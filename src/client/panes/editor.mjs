// The editor area: breadcrumb plus the pane the active tab renders in.
//
// The tab strip lives in the title bar (main.mjs builds it), because that is where
// VS Code puts it — this pane is only the content under it.
//
// Two persistent DOM nodes and nothing else: Monaco's container, and a
// placeholder for when there is nothing to show. Both are created once and
// re-attached by every render. `replaceChildren` on Monaco's container would
// destroy the editor, so the re-render path must never touch it.

import { h, fill } from '../dom.mjs'

let editorEl = null
let emptyEl = null
let diffEl = null

function ensureNodes() {
  if (!editorEl) {
    editorEl = h('div.editor-host')
    emptyEl = h('div.empty-editor')
    diffEl = h('div.diff')
  }
}

/** The node that belongs in the editor slot right now. */
function body(state) {
  ensureNodes()
  if (state.diffView) { renderDiff(state.diffView); return diffEl }
  if (state.activeTab) { emptyEl.remove(); return editorEl }
  renderEmpty(state)
  return emptyEl
}

function renderEmpty(state) {
  fill(emptyEl,
    h('div', {}, state.cwd.split('/').pop() || state.cwd || 'meowui'),
    h('div.keys', {},
      h('kbd', {}, 'Ctrl'), ' + ', h('kbd', {}, 'P'), ' commands · ',
      h('kbd', {}, 'Ctrl'), ' + ', h('kbd', {}, 'B'), ' explorer · ',
      h('kbd', {}, 'Ctrl'), ' + ', h('kbd', {}, 'K'), ' copilot · ',
      h('kbd', {}, 'S'), ' save',
    ),
  )
  emptyEl.className = 'empty-editor'
}

export function renderEditorArea(store) {
  const state = store.get()
  const active = state.tabs.find((t) => t.path === state.activeTab)
  return h('div.editor-area',
    h('div.breadcrumb', {}, ...breadcrumb(active)),
    body(state),
  )
}

function breadcrumb(active) {
  if (!active) return []
  const parts = active.path.split('/')
  return [
    h('span', {}, parts[0]),
    ...parts.slice(1).flatMap((p) => [h('span.sep', {}, '/'), h('span', {}, p)]),
    active.dirty ? h('span.sep', {}, ' ●') : null,
  ]
}

/**
 * Render a `DiffLine[]` from the host.
 *
 * These are exactly the lines the host committed, hunks included, so this view
 * cannot disagree with the transcript about what changed. The line numbers come
 * from `oldNo`/`newNo`: the text alone would need a second diff to line up.
 */
function renderDiff(view) {
  const added = view.diff.filter((l) => l.tag === 'add').length
  const removed = view.diff.filter((l) => l.tag === 'del').length
  fill(diffEl,
    h('div.head',
      h('span', {}, `${view.path} · +${added} −${removed}`),
      h('button.close', { title: 'back to the file (Esc)', onclick: view.onClose }, '×'),
    ),
    ...view.diff.map((line) => h('div.line', { class: [line.tag] },
      h('span.no', {}, line.oldNo ?? ''),
      h('span.no', {}, line.newNo ?? ''),
      h('span.text', {}, h('span.sign', {}, signOf(line.tag)), line.text),
    )),
  )
  return diffEl
}

const signOf = (tag) => (tag === 'add' ? '+' : tag === 'del' ? '−' : tag === 'hunk' ? '' : ' ')