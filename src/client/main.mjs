// The workbench: a VS Code-shaped shell with the agent as a sidebar passenger.
//
// The layout is one CSS grid (see workbench.css) and the whole render is a
// function from state to subtree. `render()` swaps the body in one go; the two
// things that must survive a swap — Monaco's container and the copilot's
// textarea — are module-level singletons that get re-attached rather than
// recreated, which is why this file is allowed to be simple.

import { h, fill, icons } from './dom.mjs'
import { api, subscribe } from './api.mjs'
import { createStore, loadPreferences, persist } from './state.mjs'
import * as editor from './editor.mjs'
import { renderExplorer, loadDir, refreshPaths } from './panes/explorer.mjs'
import { renderEditorArea } from './panes/editor.mjs'
import { renderCopilot, focusComposer } from './panes/copilot.mjs'
import { renderStatusBar, renderPanel } from './panes/statusbar.mjs'

const store = createStore()
const prefs = loadPreferences()
const root = document.getElementById('root')

// The backstop against a render that throws: a broken pane must not leave the
// user staring at a blank page with no clue which click caused it.
window.addEventListener('error', (e) => {
  store.toast(`workbench error: ${e.message}`, 'error')
  // eslint-disable-next-line no-console
  console.error(e.error ?? e.message)
})

// A rejection nothing awaited, *before* the workbench is up — there are no panes on
// screen yet to hold a toast, and the shell's error box is the one thing on the page
// that works without this bundle. After startup this is deliberately quiet: a toast
// would land on a real UI, and a boot box over a working workbench would be a lie.
//
// It cannot double-report `main()`'s own failure, because `main().catch` at the
// bottom handles that rejection — so it never becomes unhandled.
window.addEventListener('unhandledrejection', (e) => {
  if (window.__meowuiBooted) return
  window.__meowuiFail?.(`the front-end threw: ${e.reason?.message ?? e.reason}`)
})

// ---- rendering --------------------------------------------------------------

let workbenchEl = null

function render() {
  const state = store.get()
  document.documentElement.dataset.theme = state.theme

  const grid = h('div.workbench', {
    dataset: { sidebar: state.sidebar, copilot: state.copilot, panel: state.panel },
    style: {
      '--meowui-sidebar-w': `${prefs.sidebarWidth}px`,
      '--meowui-copilot-w': `${prefs.copilotWidth}px`,
      '--meowui-panel-h': `${prefs.panelHeight}px`,
    },
  },
    h('div.activity-bar', {}, ...activityItems(store, actions)),
    h('div.title-bar', {},
      h('div.brand', {}, 'meowui'),
      h('div.drag', {}, renderTabsInline(state)),
    ),
    state.sidebar === 'visible' ? renderExplorer(store, actions) : null,
    renderEditorArea(store, actions),
    state.panel === 'visible' ? renderPanel(store, actions) : null,
    h('div.copilot-gutter', {}),
    state.copilot === 'visible' ? renderCopilot(store, actions) : null,
    renderStatusBar(store, actions),
  )

  fill(root, grid, toasts(store))
  workbenchEl = grid
}

// The tab strip lives in the title bar, so it is built here rather than inside
// the editor pane; the editor pane keeps only the breadcrumb.
function renderTabsInline(state) {
  return h('div.tabs', {},
    ...state.tabs.map((tab) => h('div.tab', {
      class: [tab.dirty && 'dirty'],
      'aria-selected': String(tab.path === state.activeTab),
      title: tab.path,
      onclick: () => actions.focusTab(tab.path),
    },
      h('span.name', {}, tab.name),
      tab.dirty
        ? h('span.dirty', {}, '●')
        : h('button.close', { title: 'close', onclick: (e) => { e.stopPropagation(); actions.closeTab(tab.path) } }, '×'),
    )),
    h('div.tab', {
      style: { padding: '0 10px', background: 'transparent', borderRight: 'none' },
      title: 'New file (Ctrl+N)',
      onclick: actions.newFile,
    }, '+'),
  )
}

function activityItems(store, actions) {
  const state = store.get()
  const item = (icon, label, onClick, selected) => h('button.activity-item', {
    'aria-selected': String(Boolean(selected)),
    title: label,
    onclick: onClick,
  }, icons[icon]())
  return [
    item('explorer', 'Explorer (Ctrl+B)', () => store.toggle('sidebar'), state.sidebar === 'visible'),
    item('search', 'Search', () => store.toast('Search is not in this build yet')),
    item('git', 'Source control', () => store.toast('Source control is not in this build yet')),
    item('chat', 'Copilot (Ctrl+K)', () => store.toggle('copilot'), state.copilot === 'visible'),
    h('div.spacer'),
    item('settings', 'Settings', actions.toggleTheme),
  ]
}

function toasts(store) {
  const state = store.get()
  if (!state.toasts.length) return null
  return h('div.toasts', {}, ...state.toasts.map((t) => h('div.toast', { class: t.kind }, t.text)))
}

// ---- actions ----------------------------------------------------------------
//
// Everything the panes can do, in one object. Panes take it whole rather than
// destructuring, so adding a capability is one line here and no pane changes.

const actions = {
  /** Send a prompt as a turn, then wait for the host to finish it. */
  async send(text) {
    const prompt = String(text ?? '').trim()
    if (!prompt || store.get().streaming) return
    store.addUser(prompt)
    store.update({ streaming: true, stopping: false, error: null, diffView: null })
    try {
      // `agent/turn` resolves only once the turn is over, so the timeline closes
      // from here rather than from the last event — the events are for content,
      // the promise is for termination.
      await api.turn(prompt)
      // Whether this turn was interrupted is decided by the host, not by whether
      // the user pressed stop: the turn may also have ended because a second abort
      // arrived from somewhere else, or because it simply finished. The only
      // authoritative answer is `session/state` after the fact, which is one cheap
      // round trip and cannot be wrong.
      store.endTurn({ interrupted: await turnWasInterrupted() })
    } catch (e) {
      store.update({ error: e.message })
      store.endTurn({ interrupted: store.get().stopping })
    }
  },

  /** The stop button, and Esc. The flag is what the row's "⚠ stopped" marker reads. */
  async stop() {
    if (!store.get().streaming) return
    store.update({ stopping: true })
    try {
      await api.abort()
    } catch (e) {
      store.toast(`stop failed: ${e.message}`, 'error')
    }
  },

  async reset() {
    if (store.get().streaming) return store.toast('stop the turn before clearing the session', 'error')
    await api.reset()
    store.clearTranscript()
  },

  async openFile(path) {
    const state = store.get()
    if (editor.has(path)) return actions.focusTab(path)
    try {
      const file = await api.file(path)
      store.update({
        tabs: [...state.tabs, { path, name: path.split('/').pop(), dirty: false }],
        activeTab: path,
        diffView: null,
      })
      editor.open(path, file.content)
    } catch (e) {
      store.toast(`${path}: ${e.message}`, 'error')
    }
  },

  focusTab(path) {
    store.update({ activeTab: path, diffView: null })
    editor.show(path)
  },

  closeTab(path) {
    const state = store.get()
    if (state.tabs.length === 1 && path === state.activeTab) {
      // The last tab stays open. A workbench with no editor pane at all reads as
      // a crash, and there is nothing to gain by an empty window.
      return
    }
    const tabs = state.tabs.filter((t) => t.path !== path)
    const activeTab = state.activeTab === path ? tabs[tabs.length - 1].path : state.activeTab
    store.update({ tabs, activeTab })
    editor.release(path)
    if (state.activeTab === path) editor.show(activeTab)
  },

  /** Save the active tab through the host, so the write lands in the transcript. */
  async save() {
    const path = store.get().activeTab
    if (!path) return
    const content = editor.value(path)
    try {
      const result = await api.tool('write_file', { path, content })
      const tab = store.get().tabs.find((t) => t.path === path)
      if (result?.isError) {
        store.toast(String(result.content).slice(0, 200), 'error')
        return
      }
      store.update({ tabs: store.get().tabs.map((t) => (t.path === path ? { ...t, dirty: false } : t)) })
      // The host's own line counts, not ours: a write that normalized a trailing
      // newline is a 1-line diff the user should see reported.
      const added = result?.linesAdded ?? 0
      const removed = result?.linesRemoved ?? 0
      store.addSystem(`saved ${path}`, {
        diff: result?.diff, path, collapsed: true,
      })
      store.update({ saveNote: { path, added, removed } })
      setTimeout(() => { if (store.get().saveNote?.path === path) store.update({ saveNote: null }) }, 2600)
      editor.markSaved(path)
    } catch (e) {
      store.toast(`save failed: ${e.message}`, 'error')
    }
  },

  /** Show a host-computed diff in the editor pane. */
  showDiff(row) {
    if (!row?.diff?.length) return store.toast('no diff for that row', 'error')
    store.update({
      diffView: { path: row.path || 'change', diff: row.diff, onClose: () => store.update({ diffView: null }) },
    })
  },

  async newFile() {
    const name = prompt('New file, relative to the workspace root:')
    if (!name) return
    try {
      await api.createFile(name)
      await refreshPaths(store, [name.split('/')[0] === name ? '.' : name.split('/')[0]])
      await actions.openFile(name)
    } catch (e) {
      store.toast(e.message, 'error')
    }
  },

  async refreshTree() {
    await Promise.all([...store.get().dirs.keys()].map((d) => loadDir(store, d, { refresh: true })))
  },

  toggleTheme() {
    const theme = store.get().theme === 'dark' ? 'light' : 'dark'
    persist('theme', theme)
    store.update({ theme })
    editor.retokenize(theme)
  },

  async refreshGit() {
    const git = await api.git()
    store.update({ branch: git?.branch ?? '' })
  },

  quickOpen() { runQuickPick('files') },

  dragCopilot: dragHandle((delta) => {
    prefs.copilotWidth = clamp(prefs.copilotWidth - delta, 280, 720)
    persist('copilotWidth', prefs.copilotWidth)
    render()
  }),

  dragPanel: dragHandle((delta) => {
    prefs.panelHeight = clamp(prefs.panelHeight - delta, 80, 600)
    persist('panelHeight', prefs.panelHeight)
    render()
  }),
}

// ---- a resizable divider ----------------------------------------------------

/**
 * Ask the host whether the turn that just ended was interrupted.
 *
 * The host marks a truncated answer `meta.interrupted` and the events carry no such
 * flag, so this is the only trustworthy source. If the state read fails we fall
 * back to what the user did — better a wrong marker on a row than an unhandled
 * rejection in the middle of a turn's teardown.
 */
async function turnWasInterrupted() {
  if (!store.get().stopping) return false
  try {
    const host = await api.state()
    const last = (host.messages ?? []).filter((m) => m.role === 'assistant' && !m.meta?.thinking).at(-1)
    return last?.meta?.interrupted === true
  } catch {
    return true
  }
}

/**
 * Pointer-capture drag. `CSS resize` cannot express "invert the delta for a panel
 * that grows upward", and a divider the user has to find with the mouse cursor is a
 * divider most people never find.
 */
function dragHandle(onDelta) {
  return (e) => {
    e.preventDefault()
    const startX = e.clientX
    const startY = e.clientY
    const move = (ev) => onDelta(ev.clientX - startX, ev.clientY - startY)
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      render()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))

// ---- the quick pick ----------------------------------------------------------
//
// One overlay serves both Ctrl+P and Ctrl+Shift+P: a file filter and a command
// list are the same widget with different items, and VS Code's palette is exactly
// that. Fuzzy matching is a subsequence test — good enough to type
// "lsrcap" and find "src/client/app.mjs".

function runQuickPick(kind) {
  const commands = [
    { label: 'View: Toggle Explorer', run: () => store.toggle('sidebar') },
    { label: 'View: Toggle Copilot', run: () => store.toggle('copilot') },
    { label: 'View: Toggle Problems', run: () => store.toggle('panel') },
    { label: 'Preferences: Toggle Dark/Light', run: actions.toggleTheme },
    { label: 'File: New File…', run: actions.newFile },
    { label: 'File: Save', run: actions.save },
    { label: 'Session: Clear Transcript', run: actions.reset },
    { label: 'Workbench: Reload', run: () => location.reload() },
  ]

  let items = kind === 'commands' ? commands : []
  let selected = 0
  const input = h('input', { placeholder: kind === 'commands' ? 'Type a command' : 'Go to file', spellcheck: false })
  const list = h('div.list')

  const paint = () => fill(list, ...items.slice(0, 50).map((it, i) => h('div.item', {
    'aria-selected': String(i === selected),
    onmouseenter: () => { selected = i; paint() },
    onclick: () => close(it.run()),
  }, h('span', {}, it.label), it.key ? h('span.key', {}, it.key) : null)))

  const close = (after) => {
    backdrop.remove()
    if (after) after()
    else focusComposer()
  }

  const filter = async () => {
    const q = input.value.trim().toLowerCase()
    selected = 0
    if (kind === 'commands') {
      items = commands.filter((c) => fuzzy(c.label.toLowerCase(), q))
    } else {
      items = q ? await searchFiles(q) : []
    }
    paint()
  }

  input.addEventListener('input', filter)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') return close()
    if (e.key === 'ArrowDown') { e.preventDefault(); selected = Math.min(items.length - 1, selected + 1); paint() }
    if (e.key === 'ArrowUp') { e.preventDefault(); selected = Math.max(0, selected - 1); paint() }
    if (e.key === 'Enter') { e.preventDefault(); const it = items[selected]; if (it) close(it.run) }
  })

  const backdrop = h('div.palette-backdrop', {
    onclick: (e) => { if (e.target === backdrop) close() },
  }, h('div.palette', {}, input, list))

  document.body.append(backdrop)
  input.focus()
  paint()
}

/** Every file in the workspace, from the listings we already hold. */
function searchFiles(q) {
  const { dirs } = store.get()
  const out = []
  for (const [dir, entries] of dirs) {
    for (const e of entries) {
      if (e.dir) continue
      if (fuzzy(e.path.toLowerCase(), q)) out.push({ label: e.path, run: () => actions.openFile(e.path) })
    }
  }
  return out.sort((a, b) => a.label.length - b.label.length)
}

/**
 * Subsequence match, the way VS Code's quick open filters: every character of the
 * query appears in order, and a match starting at a word boundary is what decides
 * the ordering. No scoring library for one input box.
 */
function fuzzy(text, q) {
  if (!q) return true
  let i = 0
  for (const ch of q) {
    i = text.indexOf(ch, i)
    if (i < 0) return false
    i++
  }
  return true
}

// ---- keyboard ---------------------------------------------------------------

window.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey

  // Escape while a turn streams stops it, the way Esc does in the TUI and in every
  // chat box: it must work with the caret in the composer, so it is handled here
  // rather than on the textarea alone.
  if (e.key === 'Escape' && store.get().streaming) {
    e.preventDefault()
    actions.stop()
    return
  }
  if (!mod) {
    // Otherwise a bare Escape closes the diff, which is the next most transient
    // thing on screen.
    if (e.key === 'Escape' && store.get().diffView) store.update({ diffView: null })
    return
  }
  switch (e.key.toLowerCase()) {
    case 'b': e.preventDefault(); store.toggle('sidebar'); break
    case 'k': e.preventDefault(); store.toggle('copilot'); break
    case 's': e.preventDefault(); actions.save(); break
    case 'p': e.preventDefault(); runQuickPick(e.shiftKey ? 'commands' : 'files'); break
    case 'n': e.preventDefault(); actions.newFile(); break
    case '`': e.preventDefault(); store.toggle('panel'); break
    case 'w': e.preventDefault(); if (store.get().activeTab) actions.closeTab(store.get().activeTab); break
    case 'i': e.preventDefault(); focusComposer(); break
  }
})

// ---- startup ----------------------------------------------------------------

store.on(render)

async function main() {
  // Preferences are the view's own persisted shape, and four of its seven keys are
  // store fields. Written through `update` rather than `Object.assign`ed onto the
  // state object, so the store's declared keys stay the whole truth about the
  // shape — the three width keys below are deliberately not state at all; they are
  // read from `prefs` directly, at render time and while dragging.
  const { sidebar, copilot, panel, theme } = prefs
  store.update({ sidebar, copilot, panel, theme })
  document.documentElement.dataset.theme = prefs.theme

  const [cwd, config, host] = await Promise.all([api.cwd(), api.config(), api.state()])
  store.update({
    cwd: cwd.cwd,
    model: config.model,
    provider: config.provider,
    connected: true,
  })
  store.hydrate(host, host.messages)
  api.git().then((g) => store.update({ branch: g.branch })).catch(() => {})

  // Monaco's container has to exist in the document before `create()` runs.
  render()
  const hostEl = document.querySelector('.editor-host')
  if (hostEl) {
    editor.mountEditor(hostEl, {
      theme: prefs.theme,
      onSave: actions.save,
      onCursor: (pos) => { if (store.get().cursor !== pos) store.update({ cursor: pos }) },
      onDirty: (path) => store.update({
        tabs: store.get().tabs.map((t) => (t.path === path ? { ...t, dirty: editor.isDirty(path) } : t)),
      }),
    })
  }

  await loadDir(store, '.')
  render()

  // Up and visible, with the tree loaded and the editor mounted — the flag the
  // shell's watchdog waits for, and the honest definition of "started".
  window.__meowuiBooted = true

  subscribe((event) => {
    if (event.channel === 'agent') store.applyAgentEvent(event)
    else if (event.channel === 'fs') onWorkspaceChanged(event.changed ?? [])
    else if (event.channel === 'reset') store.clearTranscript()
  }, (status) => {
    const connected = status === 'open'
    if (connected !== store.get().connected) store.update({ connected })
  })
}

/**
 * The file watcher. A change to a path we have open is adopted into Monaco when
 * the model is clean and reported when it is not; a change to a listed directory
 * re-lists only that directory.
 */
async function onWorkspaceChanged(changed) {
  const { tabs, dirs } = store.get()
  for (const rel of changed) {
    const tab = tabs.find((t) => t.path === rel)
    if (!tab) continue
    try {
      const file = await api.file(rel)
      const outcome = editor.reload(rel, file.content)
      if (outcome === 'dirty') store.toast(`${rel} changed on disk — your unsaved edits were kept`, 'info')
      if (outcome === 'absent') store.toast(`${rel} was deleted outside the workbench`, 'info')
    } catch (e) {
      store.toast(`${rel}: ${e.message}`, 'error')
    }
  }
  await refreshPaths(store, changed)
}

main().catch((e) => {
  fill(root, h('div.empty-editor', {}, h('div', {}, 'the workbench failed to start'), h('div.keys', {}, String(e.message ?? e))))
  // eslint-disable-next-line no-console
  console.error(e)
})