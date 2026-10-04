// The copilot: the agent, as a sidebar passenger rather than the main window.
//
// This is the "人驾驶，agent 是侧边副驾" decision made concrete. The code is the
// workbench's subject; this panel is a passenger that narrates. So:
//
//   - prose and tool calls are collapsed into a timeline rather than a chat log,
//     so scanning it costs nothing when you are reading code;
//   - every line the agent produced is *actionable* — a tool row opens its file,
//     a change row opens its diff — so the agent's work is reachable from where
//     it is described;
//   - the composer is the only place you can hand control back, and the stop
//     button is the only way to take it back mid-answer.
//
// It renders from store state on every change and re-attaches the textarea
// rather than recreating it: losing the caret (or the half-typed prompt) on every
// streamed token would make the panel unusable.

import { h, fill } from '../dom.mjs'

let textareaEl = null
let timelineEl = null
// Whether the timeline is pinned to its newest row. Cleared when the user scrolls
// up so streamed tokens stop yanking them back to the bottom.
let scrolledToEnd = true

export function renderCopilot(store, actions) {
  const state = store.get()

  if (!textareaEl) {
    textareaEl = h('textarea', {
      placeholder: 'Ask the agent…',
      rows: 2,
      oninput: autosize,
      onkeydown: (e) => {
        // Enter sends, Shift+Enter breaks the line — the convention every chat box
        // has trained the user into, and the opposite of a terminal's.
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault()
          actions.send(textareaEl.value)
          textareaEl.value = ''
          autosize()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          textareaEl.blur()
        }
      },
    })
  }

  const head = h('div.copilot-head',
    h('span.status-dot', { class: state.streaming ? 'busy' : state.connected ? 'ready' : '' }),
    h('span.title', {}, 'Copilot'),
    h('span.spacer'),
    h('span.model', { title: `${state.provider}/${state.model}` }, state.model || '—'),
    h('button.icon-btn', { title: 'Clear the session transcript', onclick: actions.reset }, '⟲'),
    h('button.icon-btn', { title: 'Close the copilot (Ctrl+K)', onclick: () => store.toggle('copilot') }, '×'),
  )

  const list = h('div.timeline', {
    onscroll: (e) => {
      const el = e.target
      scrolledToEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    },
  })
  const rows = state.rows.map((r) => renderRow(r, store, actions))
  if (state.liveThinking.trim()) rows.push(renderRow({ id: 'live-t', kind: 'thinking', text: state.liveThinking, live: true }, store, actions))
  if (state.liveText.trim()) rows.push(renderRow({ id: 'live-x', kind: 'assistant', text: state.liveText, live: true }, store, actions))
  if (state.streaming && !state.liveText.trim() && !state.liveThinking.trim()) {
    rows.push(h('div.tl-row.note', {}, h('span.marker', {}, '●'), h('span.body', {}, 'working…')))
  }
  if (!state.rows.length && !state.streaming) {
    rows.push(h('div.tl-row.note', {},
      h('span.marker', {}),
      h('span.body', {}, 'The agent shares this session with the TUI. Ask for a change and it lands here, in the same transcript.'),
    ))
  }
  // Carry the scroll position across the swap. A fresh subtree starts at 0, so
  // without this every streamed token would jump the user back to the top.
  if (timelineEl) list.scrollTop = scrolledToEnd ? timelineEl.scrollHeight : timelineEl.scrollTop
  fill(list, ...rows)
  timelineEl = list
  if (scrolledToEnd) queueMicrotask(() => { list.scrollTop = list.scrollHeight })

  const send = state.streaming
    ? h('button.btn.stop', { onclick: actions.stop }, 'Stop')
    : h('button.btn', { onclick: () => actions.send(textareaEl.value) }, 'Send')

  const footer = h('div.composer',
    textareaEl,
    h('div.row',
      h('span.hint', {}, state.streaming ? 'Esc stops the turn' : 'Enter sends · Shift+Enter newline'),
      h('span.spacer'),
      state.stopping ? h('span.hint', {}, 'stopping…') : null,
      send,
    ),
    state.error ? h('div.error', {}, state.error) : null,
  )

  return h('div.copilot',
    h('div.grip', { onpointerdown: actions.dragCopilot }),
    head,
    list,
    footer,
  )
}

function autosize(e) {
  const el = e.target
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 200) + 'px'
}

// ---- one row ----------------------------------------------------------------

function renderRow(r, store, actions) {
  switch (r.kind) {
    case 'user':
      return h('div.tl-row.user', {}, h('span.marker', {}, '›'), h('span.body', {}, r.text))

    case 'assistant':
      // An interrupted answer is visibly incomplete. Silently truncating it would
      // leave the user reading a half-sentence with no idea why it stopped.
      return h('div.tl-row.assistant', {},
        h('span.marker', {}, '●'),
        h('span.body', {}, r.text, r.interrupted ? h('span', { style: { opacity: 0.6 } }, '  ⚠ stopped') : null),
      )

    case 'thinking':
      return collapsible(r, '✻', 'thought')

    case 'tool': {
      const clickable = Boolean(r.path)
      return h('div.tl-row.tool', {},
        h('span.marker', {}, '⚙'),
        h('span.body', {
          class: clickable && 'clickable',
          title: clickable ? `open ${r.path}` : '',
          onclick: clickable ? () => actions.openFile(r.path) : () => store.toggleRow(r.id),
        }, r.summary || r.text),
      )
    }

    case 'change':
      // The harness's core affordance: the agent's edit is a link to its diff.
      return h('div.tl-row.tool', {},
        h('span.marker', {}, '⎿'),
        h('span.body', { class: 'clickable', title: 'show the change', onclick: () => actions.showDiff(r) },
          r.path || 'change', h('span', { style: { opacity: 0.7 } }, ` ${r.text}`)),
      )

    case 'result':
      return collapsible(r, '⎿', r.text.split('\n')[0])

    case 'retry':
      return h('div.tl-retry', {}, r.text)

    case 'error':
      return h('div.tl-row.error', {}, h('span.marker', {}, '⚠'), h('span.body', {}, r.text))

    case 'note':
    default:
      return collapsible(r, '·', r.text)
  }
}

/**
 * A row that folds to its first line and unfolds in place. Expanding is a local
 * state flip on the store, not a re-fetch — the whole point is that inspecting the
 * agent's work never costs a round trip to the host.
 */
function collapsible(r, marker, label) {
  const first = r.text.split('\n')[0] || label
  const open = !r.collapsed && r.text.includes('\n')
  return h('div.tl-row.tool', {},
    h('span.marker', {}, marker),
    h('span.body', { onclick: () => store.toggleRow(r.id) },
      open ? r.text : first,
      !open && r.text.length > first.length ? h('span', { style: { opacity: 0.6 } }, ' …') : null,
    ),
  )
}

export function focusComposer() {
  textareaEl?.focus()
}