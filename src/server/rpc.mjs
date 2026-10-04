// The client half of the launcher bridge: we call host methods, we serve their
// `agent/event` notifications. One reader for stdin, one pending map, no more.
//
// Pipe directions, which are the part everyone gets backwards: host→plugin
// lines arrive on STDIN, plugin→host lines (our replies, our requests, the
// host's answers) go to STDOUT. Writing to our own stdin is impossible — it
// fails with ERR_STREAM_WRITE_AFTER_END.
import readline from 'node:readline'

const HOST_PROTOCOL = '2025-meowcode-launcher-1'
const VERSION = '0.1.0'

// Long, because an agent turn can legitimately run for minutes; short enough
// that a wedged host still surfaces as an error rather than a hung tab.
const CALL_TIMEOUT_MS = 600_000

let nextId = 1
const pending = new Map()
const eventListeners = new Set()
let handshakeHandler = () => {}

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n')
}

// EXACTLY ONE readline over stdin. A second consumer of the same stream races
// the first, and the loser is whichever request never gets answered.
let reader
function ensureReader() {
  if (reader) return
  reader = readline.createInterface({ input: process.stdin })
  reader.on('line', onLine)
  reader.on('close', () => {
    // The host is gone: nothing will answer an in-flight request, so fail them
    // instead of leaving the browser's fetch hanging forever.
    for (const [, p] of pending) p.reject(new Error('the MeowCode host closed the bridge'))
    pending.clear()
  })
}

// The handshake is a host→plugin REQUEST, so it arrives on this same stdin. It
// may land before or after `createRpcClient` runs; `onHandshake` is called
// whenever it arrives and the reader is installed at call time, so nothing is
// missed and nothing is answered twice.
function onLine(line) {
  const text = line.trim()
  if (!text) return
  let message
  try {
    message = JSON.parse(text)
  } catch {
    return // a chatty host must not take the front-end down
  }

  if (typeof message.id === 'number' && pending.has(message.id)) {
    const p = pending.get(message.id)
    pending.delete(message.id)
    clearTimeout(p.timer)
    if (message.error) p.reject(new Error(message.error.message || 'host error'))
    else p.resolve(message.result)
    return
  }

  if (message.method === 'initialize') {
    try { handshakeHandler(message.params) } catch { /* reporting must not break the bridge */ }
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { protocolVersion: HOST_PROTOCOL, name: 'meowui', version: VERSION },
    })
    return
  }

  if (message.method === 'agent/event') {
    for (const fn of [...eventListeners]) {
      try { fn(message.params) } catch { /* one bad listener must not stop the rest */ }
    }
  }
}

// Call a host method. Rejects on a JSON-RPC error, on a timeout, or when the
// bridge closes — so the browser always gets an answer.
export function call(method, params = {}) {
  ensureReader()
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`${method} timed out after ${CALL_TIMEOUT_MS}ms`))
    }, CALL_TIMEOUT_MS)
    pending.set(id, { resolve, reject, timer })
    send({ jsonrpc: '2.0', id, method, params })
  })
}

// Subscribe to `agent/event`; returns an unsubscribe function.
export function onAgentEvent(fn) {
  ensureReader()
  eventListeners.add(fn)
  return () => eventListeners.delete(fn)
}

export function createRpcClient({ onEvent, onHandshake } = {}) {
  handshakeHandler = onHandshake || (() => {})
  if (onEvent) onAgentEvent(onEvent)
  return { call, onAgentEvent }
}

// Abort the in-flight turn (the TUI's `esc`). The pending `agent/turn` still
// resolves — its partial answer is committed with `meta.interrupted` — so the
// front-end learns the turn is over from that resolution and needs no abort
// event. `{ aborted: false }` means nothing was running.
export function abortTurn() {
  return call('agent/abort')
}