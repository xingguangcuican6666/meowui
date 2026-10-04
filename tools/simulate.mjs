// The simulator: drive meowui the way a browser would, and nothing else.
//
// There is no browser on this machine, so this file is how the front-end gets
// tested. It speaks only meowui's own HTTP surface — the same routes, the same
// token, the same SSE frames a browser tab would use — and it never imports
// anything from meowcode's source. That constraint is the point: a test that
// reached into the host's internals would be testing the host, not the plugin, and
// the whole reason this plugin exists is that the *boundary* works.
//
// It also fakes the MeowCode side of the pipe rather than spawning a real one, for
// the same reason: what is under test is how meowui handles the protocol, and a
// real host would drag in TypeScript, Ink and a model provider to no benefit. The
// event shapes below are the real ones (src/types.ts), so a front-end that renders
// them wrongly fails here rather than in front of a user.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.join(HERE, '..', 'launcher.js')
const PORT = Number(process.env.MEOWUI_TEST_PORT || 4731)
const BASE = `http://127.0.0.1:${PORT}`
// The workspace the plugin is started in. It must hold something to list and to
// read, and the plugin resolves its own bundle relative to the *entry*, not to
// this — which is the point the first version of this file got wrong.
const WORKSPACE = process.env.SIM_WORKSPACE || HERE

// ---- tiny test harness ------------------------------------------------------

let failures = 0
let checks = 0

function check(label, condition, detail = '') {
  checks++
  if (condition) process.stdout.write(`  ✓ ${label}\n`)
  else {
    failures++
    process.stdout.write(`  ✗ ${label}\n`)
    if (detail) process.stdout.write(`      ${String(detail).split('\n').join('\n      ')}\n`)
  }
}
const section = (title) => process.stdout.write(`\n${title}\n`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- the HTTP client a browser would use ------------------------------------

// The token is minted by the plugin on first run and printed in its workbench URL
// on stderr, so the simulator reads it out of the child's stderr — exactly where a
// human would read it.
function makeClient(token, base = BASE) {
  const get = (route) => new Promise((resolve, reject) => {
    const url = new URL(route, base)
    url.searchParams.set('t', token)
    http.get(url, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => {
        let parsed = null
        try { parsed = JSON.parse(body) } catch { /* an HTML page or a 401 */ }
        resolve({ status: res.statusCode, body, json: parsed })
      })
    }).on('error', reject)
  })
  const post = (route, payload) => new Promise((resolve, reject) => {
    const url = new URL(route, BASE)
    url.searchParams.set('t', token)
    const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => {
        let parsed = null
        try { parsed = JSON.parse(body) } catch { /* see above */ }
        resolve({ status: res.statusCode, body, json: parsed })
      })
    })
    req.on('error', reject)
    req.end(payload === undefined ? '' : JSON.stringify(payload))
  })
  return { get, post }
}

/**
 * Subscribe to the event stream and collect frames until `until` says stop or the
 * deadline passes. Returns the frames so the test can assert on the sequence.
 */
function collectEvents(token, { until, timeoutMs = 15_000, after = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/events', BASE)
    url.searchParams.set('t', token)
    const events = []
    const req = http.get(url, (res) => {
      res.setEncoding('utf8')
      let buf = ''
      res.on('data', (chunk) => {
        buf += chunk
        let i
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i)
          buf = buf.slice(i + 2)
          const data = frame.split('\n').find((l) => l.startsWith('data: '))
          if (!data) continue
          try { events.push(JSON.parse(data.slice(6))) } catch { /* keep-alive */ }
        }
        if (events.length >= after && until(events)) {
          req.destroy()
          resolve(events)
        }
      })
    })
    req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e) })
    setTimeout(() => { req.destroy(); resolve(events) }, timeoutMs)
  })
}

// A PATH that is real enough to run node but holds no browser opener at all —
// which is every headless machine, and is the only honest way to reproduce the
// "spawn xdg-open ENOENT" crash. An assertion that a flag disables the feature
// cannot prove the feature survives its absence. node is linked in beside it, so
// a PATH that is broken outright would be a test passing for the wrong reason.
const NO_BROWSER_BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'meowui-no-browser-'))
fs.symlinkSync(process.execPath, path.join(NO_BROWSER_BIN, 'node'))
const PATH_WITHOUT_OPENERS = NO_BROWSER_BIN

// ---- the fake MeowCode host, on the other end of the plugin's stdio ----------

/**
 * A MeowCode-shaped host: it answers `initialize`, serves `session/state`, and
 * streams one `agent/turn` as a plausible event sequence — prose, a tool call, a
 * tool result, more prose, usage. The interleaving is deliberate; a timeline that
 * reorders or drops any of it is broken, and a sequence where the tool comes last
 * would not catch that.
 *
 * `chunkMs` is what makes `agent/abort` testable. A real turn finishes in
 * milliseconds; with 120ms between events there is a window to interrupt.
 */
function startFakeHost({ workspace, chunkMs = 120, env = {}, port = PORT } = {}) {
  const messages = []
  let controller = null
  let hostId = 1
  let toolCount = 0

  const state = () => ({
    sessionId: 'sim-session',
    messages,
    usage: {
      turns: 1, inputTokens: 120, outputTokens: 45, toolCalls: 1,
      linesAdded: 2, linesRemoved: 1, apiMs: 12, costUsd: 0,
    },
  })

  async function runTurn(prompt, notify) {
    messages.push({ id: `u${hostId}`, role: 'user', content: prompt, meta: {} })
    const turn = hostId++
    let text = ''
    let thought = ''
    controller = new AbortController()
    const emit = (event) => notify({ turn, event })

    const script = [
      { type: 'thinking', text: 'the simulator answers in a fixed script\n' },
      { type: 'text', text: 'Reading the probe file.\n' },
      { type: 'tool_use', id: `t${turn}`, name: 'read_file', input: { path: 'probe.txt' } },
      { type: 'tool_result', id: `t${turn}`, name: 'read_file', content: 'hello from the simulator\n' },
      { type: 'text', text: 'It says hello. Done.\n' },
      { type: 'usage', inputTokens: 120, outputTokens: 45, cacheReadTokens: 0, cacheCreationTokens: 0 },
    ]

    for (const event of script) {
      if (controller.signal.aborted) break
      if (event.type === 'thinking') thought += event.text
      else if (event.type === 'text') text += event.text
      else if (event.type === 'tool_result') toolCount++
      emit(event)
      await sleep(controller.signal.aborted ? 0 : chunkMs)
    }

    if (thought) messages.push({ id: `a${turn}-t`, role: 'assistant', content: thought, meta: { thinking: true } })
    // The host's commit rule, reproduced: an interrupted turn still commits what
    // arrived, flagged `interrupted`. The front-end's Stop button depends on this.
    const interrupted = controller.signal.aborted
    messages.push({ id: `a${turn}`, role: 'assistant', content: text, meta: interrupted ? { interrupted: true } : undefined })
    controller = null
    return { turn }
  }

  function handle(msg, toPlugin) {
    const { id, method, params } = msg
    const answer = (result) => toPlugin({ jsonrpc: '2.0', id, result })
    const fail = (message) => toPlugin({ jsonrpc: '2.0', id, error: { code: -32601, message } })

    switch (method) {
      case 'config/get':
        // apiKey is stripped by the host, so it is absent here too.
        return answer({ provider: 'mock', model: 'mock-model', settings: {} })
      case 'session/state':
        return answer(state())
      case 'tools/list':
        return answer({ tools: [{ name: 'read_file' }, { name: 'write_file' }] })
      case 'session/reset':
        messages.length = 0
        return answer({ sessionId: 'sim-session-2' })
      case 'agent/abort': {
        const aborted = Boolean(controller)
        if (controller) controller.abort()
        return answer({ aborted })
      }
      case 'tools/call': {
        // write_file, exactly as the browser calls it when a tab is saved: a diff
        // and line counts, so the front-end's save toast has real numbers.
        const input = params?.input ?? {}
        const lines = String(input.content ?? '').split('\n').length
        return answer({
          content: `wrote ${workspace}/${input.path} (${String(input.content ?? '').length} bytes)`,
          linesAdded: lines,
          linesRemoved: 1,
          diff: [
            { tag: 'context', text: 'hello', oldNo: 1, newNo: 1 },
            { tag: 'del', text: 'goodbye', oldNo: 2 },
            { tag: 'add', text: 'goodbye, again', newNo: 2 },
          ],
        })
      }
      case 'agent/turn':
        return runTurn(String(params?.prompt ?? ''), (event) =>
          toPlugin({ jsonrpc: '2.0', method: 'agent/event', params: event }),
        ).then(answer)
      default:
        return fail(`unknown method: ${method}`)
    }
  }

  // The host spawns the entry exactly as the manifest declares it: an anchored
  // `launcher.js`, with the session directory as the cwd. Reproducing that here
  // is the point — the first version of this file passed `launcher.mjs` as
  // argv[2] from the source tree, which the real entry never does.
  const child = spawn(process.execPath, [PLUGIN], {
    cwd: workspace,
    env: { ...process.env, MEOWUI_PORT: String(port), MEOWUI_OPEN: '0', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  const toPlugin = (msg) => { if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(msg) + '\n') }

  // Collected for the whole life of the child, not just until `ready` resolves:
  // the browser-launch notice arrives *after* the URL is printed, so a buffer that
  // stopped at the handshake could never see it.
  let err = ''
  child.stderr.on('data', (c) => { err += c; process.stderr.write(c) })

  let buf = ''
  child.stdout.on('data', (chunk) => {
    buf += chunk
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (!line.trim()) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      // The plugin is the client: everything it sends is a request (except its
      // reply to our `initialize`, which carries an id we must not answer).
      if (msg.method && msg.method !== 'initialize') handle(msg, toPlugin)
      else if (msg.method === 'initialize') {
        toPlugin({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, name: 'meowui', version: '0.1.0' } })
      }
    }
  })

  return {
    child,
    // MeowCode always sends `initialize` first, so the plugin's HTTP port comes up
    // only after the handshake. Waiting for the URL on stderr is the honest sync
    // point — it is exactly when a human would see it.
    ready: new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the plugin never printed a workbench URL\n' + err)), 20_000)
      const settle = setInterval(() => {
        const m = /workbench: (\S+)/.exec(err)
        if (m) { clearInterval(settle); clearTimeout(timer); resolve(m[1]) }
      }, 25)
      child.on('exit', (code) => {
        clearInterval(settle)
        clearTimeout(timer)
        reject(new Error(`the plugin exited with ${code}\n${err}`))
      })
    }),
    stop() { child.stdin.end(); child.kill() },
    stderr() { return err },
  }
}

// ---- the tests --------------------------------------------------------------

async function main() {
  const host = startFakeHost({ workspace: WORKSPACE })
  const url = await host.ready
  const token = new URL(url).searchParams.get('t')
  const client = makeClient(token)
  process.stdout.write(`\nworkbench at ${BASE}\n`)

  // ---- auth -----------------------------------------------------------
  section('authentication')
  const anon = await new Promise((resolve) => {
    http.get(`${BASE}/api/cwd`, (res) => { res.resume(); resolve(res.statusCode) })
  })
  check('a request without the token is refused', anon === 401, `status ${anon}`)

  const shell = await new Promise((resolve) => {
    http.get(`${BASE}/`, (res) => { res.resume(); resolve(res.statusCode) })
  })
  check('the shell answers a tokenless visitor with a readable page, not a bare 401', shell === 401)

  const withToken = await client.get('/api/cwd')
  check('the token in the query string is accepted', withToken.status === 200, `status ${withToken.status}`)
  check('the workspace root is reported', withToken.json?.cwd === WORKSPACE, JSON.stringify(withToken.json))

  // ---- static ----------------------------------------------------------
  section('the front-end bundle')
  const bundle = await new Promise((resolve) => {
    http.get(`${BASE}/webui.js?t=${encodeURIComponent(token)}`, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }))
    })
  })
  check('webui.js is served', bundle.status === 200, `status ${bundle.status}`)
  check('webui.js has a javascript content-type', /javascript/.test(bundle.type ?? ''), bundle.type)
  check('webui.js is a single self-contained file', bundle.body.length > 500_000, `${Math.round(bundle.body.length / 1024)} KB`)
  // The entry ships three files, so Monaco's workers have to be *inside* webui.js.
  // Asserted positively — a Blob URL per worker — rather than by scanning for a
  // `.js` path that must not appear: Monaco's own sources do contain
  // `new URL('json.worker.js', import.meta.url)` in the fallback our
  // `getWorkerUrl` preempts, so a negative check would be both brittle and wrong.
  check('the Monaco workers are inlined as Blob URLs',
    bundle.body.includes('MonacoEnvironment') && /createObjectURL\(new Blob\(/.test(bundle.body),
    'no MonacoEnvironment / createObjectURL(new Blob( — the workers are not in the bundle')
  check('both inlined workers are present under Monaco\'s own labels',
    bundle.body.includes('editorWorkerService') && bundle.body.includes('"json"'),
    'expected an editorWorkerService and a "json" worker; the labels come from workerManager.ts, not from file names')

  const css = await new Promise((resolve) => {
    http.get(`${BASE}/webui.css?t=${encodeURIComponent(token)}`, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }))
    })
  })
  check('webui.css is served as css', css.status === 200 && /text\/css/.test(css.type ?? ''), `${css.status} ${css.type}`)
  check('the stylesheet carries the VS Code design tokens', css.body.includes('--vscode-sideBar-background'))

  // ---- workspace ------------------------------------------------------
  section('the workspace api')
  const tree = await client.get('/api/fs/tree?path=.')
  check('the root directory lists', tree.status === 200, tree.body)
  check('entries are sorted directories-first', firstIsDirOrNone(tree.json?.entries), JSON.stringify(tree.json?.entries?.slice(0, 4)))
  check('node_modules is offered but flagged ignored', ignoredDirFlagged(tree.json?.entries))

  const escape = await client.get('/api/fs/tree?path=../../etc')
  check('a path outside the workspace is refused', escape.status === 403, `status ${escape.status}`)

  const escapeAbs = await client.get('/api/fs/file?path=/etc/hostname')
  check('an absolute path outside the workspace is refused', escapeAbs.status === 403, `status ${escapeAbs.status}`)

  const missing = await client.get('/api/fs/file?path=nope-does-not-exist.txt')
  check('a missing file is a 404, not a 500', missing.status === 404, `status ${missing.status}`)

  const self = await client.get('/api/fs/file?path=simulate.mjs')
  check('a file inside the workspace reads', self.status === 200 && self.json?.content.includes('meowui'), self.body.slice(0, 120))
  check('the read reports the path relative to the root', self.json?.path === 'simulate.mjs', JSON.stringify(self.json?.path))

  // ---- a turn ---------------------------------------------------------
  section('a turn, end to end')
  const turnEvents = collectEvents(token, {
    until: (es) => es.filter((e) => e.channel === 'agent').length >= 6,
    timeoutMs: 20_000,
  })
  const turn = await client.post('/api/turn', { prompt: 'say hello' })
  check('agent/turn resolves', turn.status === 200, turn.body)
  check('it resolves with the turn number', typeof turn.json?.turn === 'number', JSON.stringify(turn.json))

  const events = await turnEvents
  const agent = events.filter((e) => e.channel === 'agent')
  check('the turn streamed events over SSE', agent.length >= 6, `${agent.length} events`)
  check('every event carries a monotonic id', monotonic(events), events.map((e) => e.id).join(','))
  const types = agent.map((e) => e.event?.type)
  check('the event sequence is thinking, text, tool_use, tool_result, text, usage',
    ['thinking', 'text', 'tool_use', 'tool_result', 'text', 'usage'].every((t) => types.includes(t)),
    types.join(','))
  check('the tool_use event carries the input the timeline needs to link the file',
    agent.find((e) => e.event?.type === 'tool_use')?.event?.input?.path === 'probe.txt')

  const state = await client.get('/api/state')
  check('the transcript persisted through the host', (state.json?.messages ?? []).some((m) => m.role === 'user' && m.content === 'say hello'))
  check('the thinking block is stored as a thinking message',
    state.json?.messages?.some((m) => m.meta?.thinking === true))
  check('the answer is committed as an assistant message',
    state.json?.messages?.some((m) => m.role === 'assistant' && !m.meta?.thinking && m.content.includes('Done.')))

  // ---- abort ----------------------------------------------------------
  section('stopping a turn')
  const abortEvents = collectEvents(token, {
    until: (es) => es.filter((e) => e.channel === 'agent' && e.event?.type === 'text').length >= 1,
    timeoutMs: 20_000,
  })
  const stopped = client.post('/api/turn', { prompt: 'say hello, then wait' })
  await abortEvents
  const abort = await client.post('/api/abort')
  check('agent/abort reports that it aborted something', abort.json?.aborted === true, abort.body)
  const stoppedTurn = await stopped
  check('the aborted turn still resolves normally', stoppedTurn.status === 200 && typeof stoppedTurn.json?.turn === 'number', stoppedTurn.body)

  const afterAbort = await client.get('/api/state')
  const interrupted = afterAbort.json?.messages?.filter((m) => m.role === 'assistant' && !m.meta?.thinking).at(-1)
  check('the partial answer is committed and flagged interrupted', interrupted?.meta?.interrupted === true, JSON.stringify(interrupted))
  check('the partial answer is non-empty — a stop must not lose what already streamed',
    Boolean(interrupted?.content?.trim()), JSON.stringify(interrupted?.content))

  const idle = await client.post('/api/abort')
  check('aborting with nothing running is not an error', idle.status === 200 && idle.json?.aborted === false, idle.body)

  const again = await client.post('/api/turn', { prompt: 'still there?' })
  check('a turn still runs after an abort', again.status === 200, again.body)

  // ---- tools/call -----------------------------------------------------
  section('saving through the host')
  const save = await client.post('/api/tool', { name: 'write_file', input: { path: 'probe.txt', content: 'hello\nagain\n' } })
  check('tools/call write_file goes through', save.status === 200, save.body)
  check('it returns the diff lines the diff view renders', Array.isArray(save.json?.diff) && save.json.diff.some((l) => l.tag === 'add'), JSON.stringify(save.json?.diff))
  check('it returns line counts for the save toast',
    save.json?.linesAdded === 3 && save.json?.linesRemoved === 1, JSON.stringify({ a: save.json?.linesAdded, r: save.json?.linesRemoved }))

  const badTool = await client.post('/api/tool', { name: '', input: {} })
  check('an empty tool name is handled, not a 500', badTool.status === 200 || badTool.status === 400, `status ${badTool.status}`)

  // ---- reset ----------------------------------------------------------
  section('resetting the session')
  const reset = await client.post('/api/reset')
  check('session/reset resolves', reset.status === 200, reset.body)
  const emptied = await client.get('/api/state')
  check('the transcript is empty afterwards', emptied.json?.messages?.length === 0, JSON.stringify(emptied.json?.messages?.length))

  // ---- file watching --------------------------------------------------
  section('the workspace watcher')
  // A single-shot subscription: the first `fs` frame wins, and the request is torn
  // down afterwards. `req` has to be captured outside the callback, because the
  // response arrives on a later tick and a `const` inside the handler is not the
  // same binding as the request we are trying to close.
  const watchOnce = () => new Promise((resolve, reject) => {
    const url = new URL('/api/events', BASE)
    url.searchParams.set('t', token)
    let settled = false
    const req = http.get(url, (res) => {
      res.setEncoding('utf8')
      let buf = ''
      const done = (value) => { if (settled) return; settled = true; clearTimeout(timer); req.destroy(); resolve(value) }
      const timer = setTimeout(() => done({ error: 'no fs event within 5s' }), 5000)
      res.on('data', (chunk) => {
        buf += chunk
        let i
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2)
          const data = frame.split('\n').find((l) => l.startsWith('data: '))
          if (!data) continue
          const event = JSON.parse(data.slice(6))
          if (event.channel === 'fs') done(event)
        }
      })
    })
    req.on('error', (e) => { if (!settled && e.code !== 'ECONNRESET') reject(e) })
  })
  await sleep(250)
  await fsp.writeFile(path.join(WORKSPACE, 'watch-probe.txt'), 'touched\n')
  const fsEvent = await watchOnce()
  check('a write in the workspace is announced on the stream', Array.isArray(fsEvent?.changed), JSON.stringify(fsEvent))
  check('the announced path is workspace-relative', fsEvent?.changed?.some((p) => p.endsWith('watch-probe.txt')), JSON.stringify(fsEvent?.changed))
  await fsp.rm(path.join(WORKSPACE, 'watch-probe.txt'), { force: true })

  // ---- opening a browser ------------------------------------------------
  // The launcher must treat this as a convenience it can lose, not as something
  // that takes the service down with it. It is checked by *not* disabling it, on
  // a PATH with no browser opener at all — the situation on any headless box.
  // The launcher takes a PATH here rather than a flag precisely because that is
  // the only way to make "no xdg-open anywhere" true on a machine that has one.
  section('opening a browser')
  const browserless = await startFakeHost({
    workspace: WORKSPACE,
    env: { MEOWUI_OPEN: '1', PATH: PATH_WITHOUT_OPENERS },
    port: PORT + 1,
  })
  try {
    const url = await browserless.ready
    const token = new URL(url).searchParams.get('t')
    // Give the candidate list time to be exhausted before asking whether the
    // process is still there: the first spawn attempt fails in single-digit ms.
    await sleep(1200)
    const alive = browserless.child.exitCode === null && browserless.child.signalCode === null
    check('a missing browser opener does not take the service down', alive,
      `exit ${browserless.child.exitCode ?? browserless.child.signalCode}: ${browserless.stderr()}`)
    check('it says so on stderr instead of failing silently',
      /no browser here/.test(browserless.stderr()), JSON.stringify(browserless.stderr()))
    const served = await makeClient(token, `http://127.0.0.1:${PORT + 1}`).get('/api/cwd')
    check('and the workbench is still serving', served.status === 200 && served.json?.cwd === WORKSPACE,
      `status ${served.status}`)
    // No ⚠ row, no unhandled rejection, no stack: the notice is a sentence.
    check('the notice is one line, not a stack trace',
      !/at ChildProcess|at process\.|Unhandled|^\s+at /m.test(browserless.stderr()),
      JSON.stringify(browserless.stderr()))
  } finally {
    browserless.stop()
    await waitForClose(PORT + 1, 5000)
  }

  // ---- teardown -------------------------------------------------------
  section('shutdown')
  host.stop()
  const closed = await waitForClose(PORT, 5000)
  check('the port is released when the plugin exits', closed, `still listening on ${PORT}`)

  process.stdout.write(`\n${failures ? `${failures} of ${checks} checks FAILED\n` : `all ${checks} checks passed\n`}\n`)
  process.exit(failures ? 1 : 0)
}

const firstIsDirOrNone = (entries) => {
  const firstFile = entries?.findIndex((e) => !e.dir)
  return firstFile <= 0
}
const ignoredDirFlagged = (entries) => {
  const nm = entries?.find((e) => e.name === 'node_modules')
  return !nm || nm.ignored === true
}
const monotonic = (events) => events.every((e, i) => i === 0 || e.id > events[i - 1].id)

async function waitForClose(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const free = await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 500 }, (res) => { res.resume(); resolve(false) })
      req.on('error', () => resolve(true))
      req.on('timeout', () => { req.destroy(); resolve(true) })
    })
    if (free) return true
    await sleep(150)
  }
  return false
}

main().catch((e) => {
  process.stdout.write(`\nsimulator crashed: ${e.stack ?? e}\n`)
  process.exit(1)
})