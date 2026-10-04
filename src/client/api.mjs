// Everything the browser asks of the server.
//
// The token rides in the query string of every request, including the event
// stream. That looks like it should be a header, and for `fetch` it could be —
// but `EventSource` has no header option, so a header-only scheme would need a
// second auth path just for the stream. One mechanism, one rule, one place to get
// it wrong. The server also accepts a `meowui_token` cookie so a hand-typed URL
// keeps working after a reload; the shell captures `?t=` into `window.MEOWUI_TOKEN`
// before the bundle loads.
const TOKEN = window.MEOWUI_TOKEN || ''

function withToken(path) {
  if (!TOKEN) return path
  const url = new URL(path, location.origin)
  url.searchParams.set('t', TOKEN)
  return url.toString()
}

async function request(method, path, body) {
  const res = await fetch(withToken(path), {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let payload = null
  try { payload = text ? JSON.parse(text) : null } catch { /* a non-JSON error page */ }
  if (!res.ok) {
    const message = payload?.error || text || `${res.status} ${res.statusText}`
    throw Object.assign(new Error(message), { status: res.status, payload })
  }
  return payload
}

export const api = {
  cwd: () => request('GET', '/api/cwd'),
  git: () => request('GET', '/api/git'),
  config: () => request('GET', '/api/config'),
  state: () => request('GET', '/api/state'),
  tools: () => request('GET', '/api/tools'),

  tree: (path = '.') => request('GET', `/api/fs/tree?path=${encodeURIComponent(path)}`),
  file: (path) => request('GET', `/api/fs/file?path=${encodeURIComponent(path)}`),
  createFile: (path) => request('POST', '/api/fs/new', { path }),

  turn: (prompt) => request('POST', '/api/turn', { prompt }),
  abort: () => request('POST', '/api/abort'),
  reset: () => request('POST', '/api/reset'),
  tool: (name, input) => request('POST', '/api/tool', { name, input }),
}

/**
 * Subscribe to the server's event stream.
 *
 * The token travels as a query parameter because `EventSource` cannot set headers.
 * Browsers cap cross-origin URL length long before this matters on loopback, and
 * the stream is same-origin, so the whole URL stays in the address bar of a
 * process the user started themselves.
 */
export function subscribe(onEvent, onStatus) {
  const source = new EventSource(withToken('/api/events'))
  let opened = false

  const dispatch = (e) => {
    try { onEvent(JSON.parse(e.data)) } catch { /* a truncated frame; the next one is fine */ }
  }
  source.onopen = () => { opened = true; onStatus?.('open') }
  source.onerror = () => onStatus?.(opened ? 'closed' : 'connecting')

  // Named channels: `agent`, `fs`, `reset`, plus `message` as the catch-all the
  // server uses when a payload has no channel. One listener per channel keeps the
  // routing explicit — a single `message` handler that switches on the channel
  // would hide who actually consumes each one.
  for (const channel of ['agent', 'fs', 'reset', 'message']) source.addEventListener(channel, dispatch)
  return () => source.close()
}