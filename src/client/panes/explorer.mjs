// The Explorer: a lazily-expanded file tree.
//
// One HTTP round trip per expanded directory, and the server does the listing —
// the browser never sees a directory it did not ask for, and `node_modules` costs
// nothing until someone expands it. Each listing lands in the store keyed by path
// so folding and unfolding is free and a re-render is not a re-fetch.

import { h, fill, icons } from '../dom.mjs'
import { api } from '../api.mjs'

const FILE_GLYPH = {
  js: 'JS', ts: 'TS', tsx: 'TS', json: '{}', md: 'M↓', css: '#', html: '<>',
  yml: 'Y', yaml: 'Y', sh: '$', py: 'PY', rs: 'Rs', go: 'Go', toml: 'T',
}

// Fetch one directory level, unless we already have it. A refresh flag forces it —
// used by the watcher's "this path changed" notice.
export async function loadDir(store, path, { refresh = false } = {}) {
  const { dirs } = store.get()
  if (!refresh && dirs.has(path)) return
  try {
    const listing = await api.tree(path)
    const next = new Map(dirs)
    next.set(path, listing.entries)
    store.update({ dirs: next })
  } catch (e) {
    const next = new Map(dirs)
    next.set(path, [])
    store.update({ dirs: next })
    store.toast(`${path}: ${e.message}`, 'error')
  }
}

/** Toggle a directory, loading it the first time it opens. */
export async function toggleDir(store, path) {
  const opening = !store.get().expanded.has(path)
  store.toggleDir(path)
  if (opening) await loadDir(store, path)
}

/** Refresh the listings that contain any of these paths (a watcher batch). */
export async function refreshPaths(store, changed) {
  const state = store.get()
  const dirs = [...state.dirs.keys()].filter((d) => d === '.' || changed.some((c) => c === d || c.startsWith(d + '/')))
  if (!dirs.length) return
  const next = new Map(state.dirs)
  for (const d of dirs) {
    try { next.set(d, (await api.tree(d)).entries) } catch { /* deleted under us */ }
  }
  store.update({ dirs: next })
}

export function renderExplorer(store, actions) {
  const state = store.get()
  const children = []

  if (!state.dirs.has('.') && !state.dirs.size) children.push(h('div.empty', {}, 'loading…'))
  else children.push(...renderLevel(store, actions, '.', 0))

  return h('div.side-bar',
    h('div.side-title', {}, h('span', {}, 'Explorer'),
      h('div.side-actions',
        h('button.icon-btn', { title: 'New file', onclick: actions.newFile }, '+'),
        h('button.icon-btn', { title: 'Refresh', onclick: () => actions.refreshTree() }, '⟳'),
      ),
    ),
    h('div.tree', {}, ...children),
  )
}

// One level of the tree, recursing into whatever is expanded. Depth is the indent;
// `depth` also stops a pathological workspace from building a 500-deep DOM.
function renderLevel(store, actions, path, depth) {
  const state = store.get()
  const entries = state.dirs.get(path)
  if (!entries) return []
  if (depth > 12) return [h('div.tree-row', { style: { paddingLeft: `${8 + depth * 12}px` } }, h('span.label', {}, '…'))]

  const rows = []
  for (const entry of entries) {
    const open = state.expanded.has(entry.path)
    const indent = { paddingLeft: `${8 + depth * 12}px` }

    if (entry.dir) {
      rows.push(h('div.tree-row', {
        class: [entry.ignored && 'ignored', state.selectedPath === entry.path && 'selected'],
        style: indent,
        onclick: () => toggleDir(store, entry.path),
      },
        h('span.twisty', {}, open ? '▾' : '▸'),
        h('span.icon', {}, entry.ignored ? '⊘' : '▬'),
        h('span.label', {}, h('span.dir-name', {}, entry.name)),
      ))
      if (open) rows.push(...renderLevel(store, actions, entry.path, depth + 1))
      continue
    }

    rows.push(h('div.tree-row', {
      class: [state.selectedPath === entry.path && 'selected'],
      style: indent,
      onclick: () => actions.openFile(entry.path),
      title: entry.path,
    },
      h('span.twisty', {}),
      h('span.icon', {}, FILE_GLYPH[entry.name.split('.').pop()] ?? '·'),
      h('span.label', {}, h('span.name', {}, entry.name)),
    ))
  }
  return rows
}