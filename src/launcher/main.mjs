// ---------------------------------------------------------------------------
// meowui — the host side of a MeowCode entry launcher.
//
// MeowCode skips its TUI when this entry is active and hands the whole process
// to us over newline-delimited JSON-RPC 2.0 on our stdin/stdout: we are the
// client, MeowCode is the server. On startup it sends one `initialize` request
// (`{ protocolVersion: "2025-meowcode-launcher-1", serverInfo }`), which we
// answer; from then on we drive the agent and it streams `agent/event`
// notifications back.
//
// This file is thin on purpose. It owns exactly three things:
//
//   1. the RPC client          — server/rpc.mjs
//   2. an authenticated HTTP API the browser talks to — server/http.mjs
//   3. the workspace file API  — server/fsapi.mjs + server/watcher.mjs
//
// The front-end (client/**) is bundled into webui.js by build.mjs, and this file
// is bundled into launcher.js — the entry ships exactly three files and has no
// loader runtime beside them. That is why there is no `src/` out here at all.
//
// Two facts about the launcher protocol that are easy to get wrong, both
// measured rather than assumed:
//
//   - Host→plugin lines arrive on our STDIN; plugin→host lines go to our
//     STDOUT. A child cannot write to its own stdin — `process.stdin.write`
//     fails with ERR_STREAM_WRITE_AFTER_END.
//   - The host never tells us the session cwd. `process.cwd()` is it, and the
//     manifest's `"cwd": "."` is what makes that the session's directory rather
//     than the entry's (Node resolves a relative cwd against the parent's).
//     The host does anchor a relative `launcher.args` path against the entry
//     dir, since that is where the installer put it — so `launcher.js` beside
//     this bundle is found even though the session cwd is somewhere else.
// ---------------------------------------------------------------------------
import http from 'node:http'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRpcClient } from '../server/rpc.mjs'
import { createHttpApi } from '../server/http.mjs'
import { watchWorkspace } from '../server/watcher.mjs'
import { loadToken, saveToken } from '../server/token.mjs'

const HOST_PROTOCOL = '2025-meowcode-launcher-1'
const DEFAULT_PORT = 4711

function log(...args) {
  process.stderr.write('[meowui] ' + args.join(' ') + '\n')
}

const rpc = createRpcClient({
  onEvent(params) { api.broadcast({ channel: 'agent', ...params }) },
  onHandshake(info) {
    log('host handshake:', JSON.stringify(info ?? {}))
    if (info?.protocolVersion && info.protocolVersion !== HOST_PROTOCOL) {
      log(`warning: host speaks ${info.protocolVersion}, this front-end was written for ${HOST_PROTOCOL}`)
    }
  },
})

// The workspace root is the cwd we were started in — i.e. the session's
// directory, courtesy of `"cwd": "."` in the manifest.
const cwd = process.cwd()
log('workspace:', cwd)

// Where this bundle itself sits, which is what tells the HTTP layer where
// webui.js and webui.css are. process.argv[1] is that path for both
// `node <entry>/launcher.js` and the host's own anchored spawn, and the session
// cwd is the wrong directory to ask about it in.
const entryDir = path.dirname(path.resolve(process.argv[1]))

const token = loadToken(entryDir)
if (token.created) saveToken(entryDir, token.value)

let api
try {
  api = createHttpApi({
    port: Number(process.env.MEOWUI_PORT || DEFAULT_PORT),
    token: token.value,
    cwd,
    entryDir,
    rpc,
    // Named relative to this bundle, not to the workspace. Both strings are also
    // listed in the manifest's `launcher.args`, which is the only thing that makes
    // the entry installer copy them — the installer ships files named in the
    // manifest and nothing else, so a file the front-end needs must appear there
    // even though the launcher never passes one of them as an argument.
    bundle: process.env.MEOWUI_BUNDLE || 'webui.js',
    css: 'webui.css',
  })
  // A bind failure surfaces here, not as an unhandled rejection: the port being
  // busy means another meowui already owns this workspace.
  await api.ready
} catch (e) {
  log(e instanceof Error ? e.message : String(e))
  log('set MEOWUI_PORT to pick a different port')
  process.exit(1)
}

const url = api.url(token.value)
log('workbench:', url)

const watcher = watchWorkspace(cwd, (changed) => api.broadcast({ channel: 'fs', changed }))

// Best-effort convenience: a terminal user gets the page without copy-pasting.
// The call itself is at the bottom of this file — see the note there.

/**
 * Open the workbench in a browser, or stay quiet about it.
 *
 * Two things make this sharper than it looks.
 *
 * A `spawn` that finds no binary does NOT throw: it returns a ChildProcess and
 * then emits `error` asynchronously. So the obvious `try { spawn(...) } catch {}`
 * handles the case that cannot happen and misses the one that does — the unhandled
 * `error` event then takes the whole process down, HTTP service and all, over a
 * convenience that was never required. The failure has to be caught on the event.
 *
 * And one candidate is not enough: `xdg-open` is the documented one and is absent
 * on plenty of healthy machines, while `gio` is right there. So the candidates are
 * tried in turn, each one's absence silent, and only the exhausted list is worth a
 * line — "no xdg-open, no gio" is noise, "nothing can open a browser here" is the
 * fact. MEOWUI_BROWSER replaces the list with a single command of your own.
 */
const BROWSERS = [
  ['xdg-open', []],
  ['gio', ['open']],
  ['gnome-open', []],
  ['kde-open', []],
  ['wslview', []],
  ['open', []],
]

async function openInBrowser(target) {
  if (process.env.MEOWUI_OPEN === '0') return
  const candidates = process.env.MEOWUI_BROWSER ? [[process.env.MEOWUI_BROWSER, []]] : BROWSERS
  for (const [command, prefix] of candidates) {
    if (await tryOpen(command, [...prefix, target])) return
  }
  log('no browser here — open the URL above by hand')
}

/**
 * One launch attempt, as a question: did this command exist and start?
 *
 * `spawn` throws only for malformed arguments; "no such binary" arrives later as
 * an `error` event. So the answer is the absence of that event within a short
 * grace period — long enough for a failed exec to report, short enough that a
 * real browser has already been handed the URL. Exiting non-zero (a `gio open`
 * with no display) is indistinguishable from success from out here, which is fine:
 * the URL is on stderr either way, so the notice is a nicety and not a guarantee.
 */
function tryOpen(command, args) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, { stdio: 'ignore', detached: true })
    } catch {
      resolve(false)
      return
    }
    const grace = setTimeout(() => { child.unref(); resolve(true) }, 400)
    // Clearing the timer matters: a late `error` after we resolved would be an
    // unhandled event, which is the very thing this function exists to prevent.
    child.on('error', () => { clearTimeout(grace); resolve(false) })
  })
}

// Exiting is the user's call, not the browser's: they close the terminal (or
// ctrl-c) to stop meowui, and the host then autosaves the transcript. A dead
// stdin means the host is gone, so nothing is left to talk to.
process.stdin.on('end', () => { log('host closed the bridge'); shutdown(0) })
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

// Last, and deliberately so: `openInBrowser` reads BROWSERS, and an async body
// runs synchronously up to its first await, so calling it above that `const` hit
// it in its temporal dead zone. The ReferenceError was swallowed by the `.catch`
// and the "no browser here" notice silently never printed — which is how the
// first version of this fix shipped still broken, and why the notice is now
// asserted by a test that runs with no browser opener on PATH at all.
openInBrowser(url).catch((e) => log(`could not open a browser: ${e?.message ?? e}`))

let closing = false
function shutdown(code) {
  if (closing) return
  closing = true
  try { watcher.close() } catch { /* best-effort */ }
  try { api.close() } catch { /* best-effort */ }
  process.exit(code)
}