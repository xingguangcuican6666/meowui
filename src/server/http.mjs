// The HTTP surface the browser talks to.
//
// Everything is on one loopback port: the static front-end, the workspace file
// API, the agent controls, and the event stream. One port because a workbench
// that has to be told two ports is a workbench that breaks when one of them is
// taken.
//
// Token first, always: every request — including `/` and the bundle — must
// carry `?t=`, the `meowui_token` cookie, or an `Authorization: Bearer` header.
// A loopback port with no token is reachable from any web page the user has open
// (browsers may GET localhost cross-origin), and a browser that can read the
// workspace can also drive the agent.
//
// The event stream is SSE rather than WebSocket because everything the browser
// receives is server→client (turns, tool results, file changes); the browser's
// own actions are ordinary POSTs. Node has no built-in WS server, and
// hand-rolling frame codecs is not worth a channel that carries nothing extra.
// Every event carries a monotonic `id:`, and `Last-Event-ID` replays what the
// client missed across a reconnect — otherwise a dropped connection is a
// silently truncated transcript.
import http from 'node:http'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { tokenMatches } from './token.mjs'
import * as fsapi from './fsapi.mjs'

const COOKIE = 'meowui_token'
// How many events a reconnecting client can replay. Enough for a laptop lid
// closing; not so much that a long turn grows an unbounded server-side buffer.
const REPLAY_LIMIT = 500
// A comment frame this often keeps proxies and the browser from deciding a
// connection is idle and closing it in the middle of a turn.
const KEEPALIVE_MS = 25_000

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

export function createHttpApi({ port, token, cwd, entryDir, rpc, bundle, css }) {
  // The entry directory, not the workspace: `bundle` and `css` are named relative
  // to the launcher's own location, and the workspace root is wherever the user's
  // session happened to start. Resolving them against `process.cwd()` would serve
  // the front-end out of whatever directory the user was in — the single most
  // confusing failure this service could have. The launcher passes it in because
  // it knows where its own bundle landed; nothing here has to guess from argv.
  const bundlePath = path.resolve(entryDir, bundle)
  const cssPath = path.resolve(entryDir, css)
  const clients = new Set()
  const history = []
  let nextEventId = 1

  // ---- the event stream ----------------------------------------------------

  function frame(event) {
    return `id: ${event.id}\nevent: ${event.channel || 'message'}\ndata: ${JSON.stringify(event)}\n\n`
  }

  // One ordered log, one fan-out: every channel (agent turns, tool results, file
  // changes, resets) goes through here so the ids mean the same thing to the
  // client everywhere.
  function broadcast(payload) {
    const event = { ...payload, id: nextEventId++ }
    history.push(event)
    if (history.length > REPLAY_LIMIT) history.shift()
    for (const res of clients) {
      try { res.write(frame(event)) } catch { clients.delete(res) }
    }
    return event
  }

  // ---- plumbing ------------------------------------------------------------

  const json = (res, status, body) => {
    const text = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      'cache-control': 'no-store',
    })
    res.end(text)
  }
  const fail = (res, status, message) => json(res, status, { error: message })

  function authorized(url, req) {
    if (tokenMatches(token, url.searchParams.get('t'))) return true
    const auth = req.headers.authorization
    if (typeof auth === 'string' && auth.startsWith('Bearer ') && tokenMatches(token, auth.slice(7))) return true
    const cookie = req.headers.cookie
    if (typeof cookie === 'string') {
      for (const part of cookie.split(';')) {
        const eq = part.indexOf('=')
        if (eq > 0 && part.slice(0, eq).trim() === COOKIE && tokenMatches(token, part.slice(eq + 1).trim())) return true
      }
    }
    return false
  }

  async function readBody(req, limit = 8 * 1024 * 1024) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > limit) throw new fsapi.FsError(413, 'request body too large')
      chunks.push(chunk)
    }
    if (!chunks.length) return {}
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      throw new fsapi.FsError(400, 'body must be JSON')
    }
  }

  async function serveStatic(res, file) {
    try {
      const body = await fsp.readFile(file)
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] || 'application/octet-stream',
        'content-length': body.length,
        // The bundle changes on every rebuild; a cached copy is a mystifying bug.
        'cache-control': 'no-store',
      })
      res.end(body)
    } catch {
      fail(res, 404, `${path.basename(file)} is missing — run \`npm run build\` in the plugin directory`)
    }
  }

  // ---- the shell -----------------------------------------------------------

  const PAGE = `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>meowui</title>
<link rel="stylesheet" href="/${css}">
</head>
<body>
<div id="root"></div>
<script>window.MEOWUI_TOKEN = new URLSearchParams(location.search).get('t') || ''</script>
<script src="/${bundle}"></script>
</body>
</html>`

  const NO_TOKEN_PAGE = `<!doctype html><meta charset="utf-8"><title>meowui</title>
<body style="font:14px system-ui;padding:2rem">
<p>This workbench needs the access token from the URL MeowCode printed on its stderr.</p>
<p>Open the full URL, not just <code>127.0.0.1:${port}</code>.</p>`

  // ---- routing -------------------------------------------------------------

  async function handle(req, res) {
    const url = new URL(req.url, `http://127.0.0.1:${port}`)

    if (!authorized(url, req)) {
      // A wrong token on the shell gets a page a human can read, not a bare 401.
      if (url.pathname === '/' || url.pathname === '/index.html') {
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(NO_TOKEN_PAGE)
        return
      }
      fail(res, 401, 'bad or missing token')
      return
    }

    const p = url.pathname

    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(PAGE)
      return
    }
    // The route follows the file name, so MEOWUI_BUNDLE (or a manifest that
    // renames it) serves under the name it actually has rather than 404ing on a
    // path nothing was ever going to answer.
    if (req.method === 'GET' && p === '/' + bundle) return serveStatic(res, bundlePath)
    if (req.method === 'GET' && p === '/' + css) return serveStatic(res, cssPath)

    // ---- the workspace ----------------------------------------------------
    if (req.method === 'GET' && p === '/api/cwd') return json(res, 200, { cwd })
    if (req.method === 'GET' && p === '/api/git') return json(res, 200, { branch: fsapi.gitBranch(cwd) })
    if (req.method === 'GET' && p === '/api/fs/tree') {
      return json(res, 200, await fsapi.listDir(cwd, url.searchParams.get('path') || '.'))
    }
    if (req.method === 'GET' && p === '/api/fs/file') {
      return json(res, 200, await fsapi.readFile(cwd, url.searchParams.get('path') || ''))
    }
    if (req.method === 'POST' && p === '/api/fs/new') {
      const body = await readBody(req)
      return json(res, 200, await fsapi.createFile(cwd, String(body.path ?? '')))
    }

    // ---- the agent --------------------------------------------------------
    if (req.method === 'GET' && p === '/api/config') return json(res, 200, await rpc.call('config/get'))
    if (req.method === 'GET' && p === '/api/state') return json(res, 200, await rpc.call('session/state'))
    if (req.method === 'GET' && p === '/api/tools') return json(res, 200, await rpc.call('tools/list'))
    if (req.method === 'POST' && p === '/api/turn') {
      const body = await readBody(req)
      return json(res, 200, await rpc.call('agent/turn', { prompt: String(body.prompt ?? '') }))
    }
    if (req.method === 'POST' && p === '/api/abort') return json(res, 200, await rpc.call('agent/abort'))
    if (req.method === 'POST' && p === '/api/reset') {
      const out = await rpc.call('session/reset')
      // Tell every open tab, not just the one that asked: the host transcript is
      // gone, so any tab still showing it is showing a lie.
      broadcast({ channel: 'reset' })
      return json(res, 200, out)
    }
    if (req.method === 'POST' && p === '/api/tool') {
      const body = await readBody(req)
      return json(res, 200, await rpc.call('tools/call', { name: String(body.name ?? ''), input: body.input ?? {} }))
    }

    // ---- the event stream -------------------------------------------------
    if (req.method === 'GET' && p === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      })
      res.write('retry: 1000\n\n')
      // Replay what a reconnecting client missed. A client that asks for an id
      // older than the buffer gets nothing rather than a partial replay — it will
      // re-read session/state anyway.
      const since = Number(req.headers['last-event-id'])
      if (Number.isFinite(since) && since > 0) {
        for (const event of history) if (event.id > since) res.write(frame(event))
      }
      clients.add(res)
      const keepAlive = setInterval(() => {
        try { res.write(': keep-alive\n\n') } catch { clients.delete(res) }
      }, KEEPALIVE_MS)
      req.on('close', () => { clearInterval(keepAlive); clients.delete(res) })
      return
    }

    fail(res, 404, `no route for ${req.method} ${p}`)
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      const status = typeof e?.status === 'number' ? e.status : 500
      if (!res.headersSent) fail(res, status, e instanceof Error ? e.message : String(e))
      else try { res.end() } catch { /* the socket is already gone */ }
    })
  })

  // A bind failure has to reach the launcher as a rejection, not as an unhandled
  // 'error' event after the fact: a busy port means another meowui already owns
  // this workspace, and a second front-end over one session's transcript is worse
  // than refusing to start.
  const ready = new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject)
      server.on('error', (e) => process.stderr.write('[meowui] server error: ' + e.message + '\n'))
      resolve()
    })
  })
  // The launcher awaits `ready` in a try/catch; this handler only keeps a *later*
  // failure from crashing the process as an unhandled rejection.
  ready.catch(() => {})

  return {
    ready,
    broadcast,
    url(t) { return `http://127.0.0.1:${port}/?t=${encodeURIComponent(t)}` },
    close() {
      for (const res of clients) { try { res.end() } catch { /* already gone */ } }
      clients.clear()
      try { server.close() } catch { /* already closed */ }
    },
  }
}