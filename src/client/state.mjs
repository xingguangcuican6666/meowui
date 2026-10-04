// The single place workbench state lives.
//
// Two very different kinds of write arrive here and they must not be confused:
//
//   - **transcript writes** come from the host, in order, as `agent/event`
//     notifications, and describe what the agent did. Append-only.
//   - **view writes** come from the user's own clicks — opening a tab, expanding a
//     directory, toggling the copilot. They never touch the transcript.
//
// Keeping those apart is what stops a redraw from ever being able to lose a token
// the model already streamed: the timeline is only ever appended to, never
// re-derived from the view.

/** One row in the copilot timeline. */
const row = (kind, text, extra = {}) => ({ id: nextId(), kind, text, collapsed: false, ...extra })
let idSeq = 0
const nextId = () => `r${++idSeq}`

export function createStore() {
  const listeners = new Set()
  // The tool call whose result is arriving next: tool_use gives us the path,
  // tool_result gives us the diff, and neither alone is clickable.
  let pending = { name: '', path: '' }
  const state = {
    // ---- transcript (host-owned) ----
    rows: [],
    /** True from the moment a turn is sent until its `agent/turn` resolves. */
    streaming: false,
    /** The user pressed stop; the next turn resolution closes as interrupted. */
    stopping: false,
    /** Live prose for the turn in flight, accumulated until it commits. */
    liveText: '',
    liveThinking: '',
    usage: null,
    // ---- view (browser-owned) ----
    cwd: '',
    branch: '',
    model: '',
    provider: '',
    tabs: [],
    activeTab: null,
    /** Directory listings by path, fetched lazily as the tree expands. */
    dirs: new Map(),
    expanded: new Set(),
    sidebar: 'visible',
    copilot: 'visible',
    panel: 'hidden',
    theme: 'dark',
    /** Monaco's caret, mirrored for the status bar. */
    cursor: { line: 1, column: 1 },
    /** Path whose diff the editor is showing instead of its text. */
    diffView: null,
    saveNote: null,
    /**
     * A transport failure of the last send — 401, a 500, the host closing the
     * bridge. Stored rather than derived because a failure that never reached the
     * host produced no event and so left no row in the transcript; this is the
     * only place it can be said out loud. Cleared at the head of every send.
     */
    error: null,
    toasts: [],
    connected: false,
  }

  const emit = () => { for (const fn of listeners) fn(state) }

  // Two consecutive events can both need to flush the live buffer (a tool_use
  // right after a text run), so `flushLive` reads `patch.rows ?? state.rows`,
  // appends, and writes the result back onto the patch. The ordering rule lives in
  // one function instead of being repeated per event type.
  function flushLive(patch) {
    let rows = patch.rows ?? state.rows
    if (state.liveThinking.trim()) rows = [...rows, row('thinking', state.liveThinking)]
    if (state.liveText.trim()) rows = [...rows, row('assistant', state.liveText)]
    patch.rows = rows
    patch.liveThinking = ''
    patch.liveText = ''
  }

  const store = {
    get: () => state,
    on(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    // Every view write goes through here, so a pane that mutated state behind the
    // store's back — the classic stale-sidebar bug — cannot happen by accident.
    update(patch) { Object.assign(state, patch); emit() },

    // ---- transcript ------------------------------------------------------

    /**
     * Fold one `agent/event` into the timeline.
     *
     * Events arrive in order and carry `{ turn, event }`. Text accumulates rather
     * than appending to the DOM, so a replayed event after a reconnect folds into
     * the same live buffer rather than duplicating a paragraph.
     */
    applyAgentEvent({ turn, event }) {
      const patch = { streaming: true }
      switch (event?.type) {
        case 'text':
          patch.liveText = state.liveText + (event.text ?? '')
          break
        case 'thinking':
          patch.liveThinking = state.liveThinking + (event.text ?? '')
          break
        case 'tool_use':
          // Prose ends where the tool call begins: flush first, then the call.
          flushLive(patch)
          // A tool_result carries the diff but not the path, so remember which file
          // this call is about — it is what makes the change row a link.
          pending = { name: event.name, path: fileIn(event.input) }
          patch.rows = [...(patch.rows ?? state.rows), row('tool', event.name, {
            path: pending.path,
            // The summary the host's own transcript uses, so a row read from an
            // event and a row read from session/state say the same thing.
            summary: summarize(event.name, event.input),
          })]
          break
        case 'tool_result': {
          flushLive(patch)
          if (event.isError) {
            patch.rows = [...(patch.rows ?? state.rows), row('error', event.display || event.content || 'tool failed', { tool: event.name })]
            break
          }
          // A tool_result carries the diff but not the path — the path arrived with
          // the tool_use that caused it, so the pending tool is what makes the
          // change row clickable.
          if (event.diff?.length) {
            patch.rows = [...(patch.rows ?? state.rows), row('change', `⎿ +${event.linesAdded ?? 0} −${event.linesRemoved ?? 0}`, {
              diff: event.diff, path: pending.path, collapsed: true,
            })]
          } else {
            patch.rows = [...(patch.rows ?? state.rows), row('result', truncate(event.display || event.content || '', 12), { collapsed: true })]
          }
          break
        }
        case 'retry':
          patch.rows = [...(patch.rows ?? state.rows), row('retry', `attempt ${event.attempt}/${event.max} · ${event.reason}`)]
          break
        case 'error':
          flushLive(patch)
          patch.rows = [...(patch.rows ?? state.rows), row('error', event.message || 'the turn failed')]
          break
        case 'usage':
          patch.usage = event
          break
        default: {
          // `workflow` and `agent` carry a whole sub-agent snapshot. One collapsed
          // line keeps the main timeline readable instead of interleaving a
          // child's tool calls with the parent's.
          flushLive(patch)
          const snap = event?.snap ?? {}
          const label = event?.type === 'agent'
            ? `agent · ${snap.name || snap.agent || ''}`.trim()
            : `workflow · ${(snap.steps || []).length} steps`
          patch.rows = [...(patch.rows ?? state.rows), row('note', label, { snap, collapsed: true })]
          break
        }
      }
      store.update(patch)
    },

    /** The user's prompt, echoed at once so the timeline shows it immediately. */
    addUser(text) {
      store.update({ rows: [...state.rows, row('user', text)] })
    },

    /**
     * The turn ended. Whatever was live becomes committed rows, flagged
     * `interrupted` when the user stopped it — the same distinction the host's
     * own transcript makes, so the two views never disagree.
     */
    endTurn({ interrupted } = {}) {
      const patch = { streaming: false, stopping: false }
      flushLive(patch)
      const rows = patch.rows ?? state.rows
      patch.rows = interrupted
        ? rows.map((r) => (r.kind === 'assistant' || r.kind === 'thinking' ? { ...r, interrupted: true } : r))
        : rows
      store.update(patch)
    },

    /**
     * Replace the transcript with the host's. Used at startup and after a reset:
     * the host's rows are the only ones that cannot be reconstructed from events.
     *
     * The transcript is flat — a tool call and its result are two consecutive
     * messages — so the pairing happens here, where the previous row's
     * `name · arg` line is the only source of the path a diff belongs to.
     */
    hydrate(host, messages) {
      const rows = []
      let lastTool = null
      for (const m of messages ?? []) {
        if (m.role === 'user') rows.push(row('user', m.content))
        else if (m.role === 'assistant') rows.push(row(m.meta?.thinking ? 'thinking' : 'assistant', m.content, { ...m.meta }))
        else if (m.role === 'tool') {
          // A result row starts with `⎿`; the call row above it is `● name · arg`.
          if (m.content.startsWith('⎿')) {
            const isChange = Boolean(m.meta?.diff?.length)
            rows.push(row(isChange ? 'change' : 'result', m.content, {
              diff: m.meta?.diff, path: lastTool, collapsed: true,
            }))
          } else {
            lastTool = pathOf(m.content)
            rows.push(row('tool', m.content.replace(/^●\s*/, ''), { path: lastTool, summary: m.content.replace(/^●\s*/, ''), collapsed: true }))
          }
        } else if (m.role === 'system') rows.push(row(m.meta?.error ? 'error' : 'note', m.content))
      }
      store.update({ rows, usage: host?.usage ?? state.usage })
    },

    clearTranscript() {
      store.update({ rows: [], liveText: '', liveThinking: '', usage: null, diffView: null })
    },

    // ---- view ------------------------------------------------------------

    /** One tool call made by the user (a save), recorded in the same timeline. */
    addSystem(text, extra = {}) {
      store.update({ rows: [...state.rows, row('note', text, extra)] })
    },

    toggle(key) {
      const next = state[key] === 'visible' ? 'hidden' : 'visible'
      store.update({ [key]: next })
      persist(key, next)
    },

    /**
     * Expand or collapse one directory.
     *
     * A copy of the Set, like every other view write: `update` is an
     * `Object.assign` onto the state object, so a mutation in place would reach
     * the panes without ever going through `emit`.
     */
    toggleDir(path) {
      const expanded = new Set(state.expanded)
      expanded.has(path) ? expanded.delete(path) : expanded.add(path)
      store.update({ expanded })
    },

    toggleRow(id) {
      store.update({ rows: state.rows.map((r) => (r.id === id ? { ...r, collapsed: !r.collapsed } : r)) })
    },

    toast(text, kind = 'info') {
      const id = nextId()
      store.update({ toasts: [...state.toasts, { id, text, kind }] })
      setTimeout(() => store.update({ toasts: state.toasts.filter((t) => t.id !== id) }), 4000)
    },
  }

  return store
}

// ---- view preferences -------------------------------------------------------

// Only view state is persisted. The transcript is re-read from the host, which is
// the only place it exists — a cached transcript in localStorage would be a second
// source of truth that drifts the moment a second tab opens.
export function loadPreferences() {
  const read = (key, fallback) => {
    try { return localStorage.getItem('meowui.' + key) ?? fallback } catch { return fallback }
  }
  return {
    sidebar: read('sidebar', 'visible'),
    copilot: read('copilot', 'visible'),
    panel: read('panel', 'hidden'),
    theme: read('theme', 'dark'),
    sidebarWidth: Number(read('sidebarWidth', 260)) || 260,
    copilotWidth: Number(read('copilotWidth', 400)) || 400,
    panelHeight: Number(read('panelHeight', 180)) || 180,
  }
}

export function persist(key, value) {
  try { localStorage.setItem('meowui.' + key, String(value)) } catch { /* private mode */ }
}

// ---- the host's own one-line summaries, kept in step with it -----------------

/**
 * The same `name · argument` line the host writes into its transcript
 * (summarizeToolCall in src/tools/index.ts). Reimplemented rather than imported:
 * this bundle ships no TypeScript from meowcode, so the agreement has to be
 * maintained by hand — and it is, deliberately, a *readable* duplication: when
 * the host adds a tool, this is where the web copy drifts and gets fixed.
 */
function summarize(name, input) {
  const i = input ?? {}
  switch (name) {
    case 'bash': return `bash · ${String(i.command ?? '').split('\n')[0].slice(0, 80)}`
    case 'read_file': case 'write_file': case 'edit_file': case 'notebook_edit': return `${name} · ${i.path ?? ''}`
    case 'grep': return `grep · ${i.pattern ?? ''}${i.glob ? ` (${i.glob})` : ''}`
    case 'glob': return `glob · ${i.pattern ?? ''}`
    case 'list_dir': return `list_dir · ${i.path ?? '.'}`
    case 'memory': return `memory · ${String(i.action ?? '')}${i.name ? ` ${i.name}` : ''}`
    case 'web_fetch': return `web_fetch · ${i.url ?? ''}`
    case 'web_search': return `web_search · ${i.query ?? ''}`
    case 'todo_write': return `todo_write · ${Array.isArray(i.todos) ? i.todos.length : 0} items`
    case 'task': return `task · ${i.description || String(i.subagent_type ?? 'general')}`
    case 'plan': return `plan · ${i.description || 'plan'}`
    default: return name
  }
}

const fileIn = (input) => {
  const p = input?.path ?? input?.file_path
  return typeof p === 'string' ? p : ''
}

// Pull the path back out of a `name · arg` transcript line. The host's own
// summarizeToolCall writes it, so this is the inverse of the function above —
// the only way to attribute a bare `⎿ +3 −1` result to the file it belongs to.
const pathOf = (line) => {
  const m = /^(?:read_file|write_file|edit_file|notebook_edit|list_dir)\s*·\s*(\S+)/.exec(String(line).trim())
  return m ? m[1] : ''
}

const truncate = (text, lines) => {
  const all = String(text).split('\n')
  return all.length > lines ? all.slice(0, lines).join('\n') + `\n… ${all.length - lines} more` : String(text)
}