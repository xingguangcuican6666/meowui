// Does every pane read fields createStore() declares?
//
// The bug this exists for is `state.problems` in statusbar.mjs: a field no store
// literal mentioned, read unconditionally during the first render, whose
// `.filter` rejected main() into the boot box. A field-by-field audit catches
// today's three; nothing catches the fourth, or catches one that survives
// because the pane it lives in is behind a `panel === 'visible'` guard.
//
// So this does not read the source to find the reads. It runs the panes against
// a real store whose state object is a Proxy, and records every property a pane
// touches. The declared set comes from the *actual* keys of that same object, so
// it cannot drift from createStore(): if a field is declared in the literal but
// deleted before the check runs, it is not in the set either. Runtime against
// runtime, no parser, nothing to keep in sync.
import fs from 'node:fs'

import { installDom } from './dom-stub.mjs'

installDom()

const { createStore } = await import('../src/client/state.mjs')
const { renderStatusBar, renderPanel } = await import('../src/client/panes/statusbar.mjs')
const { renderExplorer, toggleDir } = await import('../src/client/panes/explorer.mjs')
const { renderCopilot } = await import('../src/client/panes/copilot.mjs')
const { renderEditorArea } = await import('../src/client/panes/editor.mjs')

const store = createStore()
const state = store.get()
const declared = new Set(Object.keys(state))
const reads = new Set()

const probe = new Proxy(state, {
  get: (target, key) => {
    if (typeof key === 'string') reads.add(key)
    return target[key]
  },
})

let failures = 0
// `store.get` is the one method every pane reaches the state through, and it is
// `() => state` by definition, so replacing it is enough to intercept them all —
// including panes that destructure (`const { dirs } = store.get()`), because the
// destructuring still goes through the proxy.
store.get = () => probe

// A Proxy that answers no property at all: `actions` is not state, and a pane that
// reads `actions.foo` must not be reported as reading a state field.
const actions = new Proxy({}, { get: (_t, key) => typeof key === 'string' ? () => {} : undefined })

// State a live workbench has: a loaded tree, an open file, one error row and one
// usage event. Every branch in every pane is reached this way or not at all.
store.update({
  cwd: '/w/src',
  branch: 'main',
  model: 'mock-model',
  provider: 'mock',
  connected: true,
  usage: { inputTokens: 1200, outputTokens: 3400 },
  tabs: [{ path: 'src/a.js', name: 'a.js', dirty: true }],
  activeTab: 'src/a.js',
  dirs: new Map([
    ['.', [
      { dir: true, path: 'src', name: 'src' },
      { dir: true, path: 'node_modules', name: 'node_modules', ignored: true },
      { dir: false, path: 'README.md', name: 'README.md' },
    ]],
    ['src', [{ dir: false, path: 'src/a.js', name: 'a.js' }]],
  ]),
  expanded: new Set(['src']),
  rows: [
    { id: 'r1', kind: 'user', text: 'fix it' },
    { id: 'r2', kind: 'thinking', text: 'looking', collapsed: false },
    { id: 'r3', kind: 'tool', text: 'read_file · a.js', path: 'src/a.js', summary: 'read_file · a.js', collapsed: false },
    { id: 'r4', kind: 'result', text: 'line one\nline two', collapsed: false, diff: [{ tag: 'add', text: 'x', newNo: 1 }] },
    { id: 'r5', kind: 'change', text: '⎿ +1 −0', path: 'src/a.js', collapsed: true, diff: [{ tag: 'add', text: 'x', newNo: 1 }] },
    { id: 'r6', kind: 'retry', text: 'attempt 1/3', collapsed: false },
    { id: 'r7', kind: 'note', text: 'saved src/a.js', collapsed: false },
    { id: 'r8', kind: 'error', text: 'src/a.js:1 no such thing', collapsed: false },
  ],
})

const renderers = {
  'renderStatusBar': () => renderStatusBar(store, actions),
  'renderPanel': () => renderPanel(store, actions),
  'renderExplorer': () => renderExplorer(store, actions),
  'renderCopilot': () => renderCopilot(store, actions),
  'renderEditorArea': () => renderEditorArea(store, actions),
}

// Every pane renders against this state without throwing, and each one only
// touches fields createStore() declares. Two assertions, one pass.
for (const [name, fn] of Object.entries(renderers)) {
  try {
    fn()
  } catch (e) {
    process.stdout.write(`  ✗ ${name} threw: ${e.message}\n`)
    failures++
  }
}

// The same panes again with every branch open: a turn in flight, the Problems
// panel visible, a diff up, a fresh preference-shaped store. A field read only
// behind a `panel === 'visible'` guard is exactly how `problems` survived the
// first audit — the status bar renders it unconditionally, the panel only
// sometimes.
store.update({
  streaming: true, stopping: true, error: 'the host did not answer',
  panel: 'visible', diffView: { path: 'src/a.js', diff: [{ tag: 'hunk', text: '@@', oldNo: 1, newNo: 1 }, { tag: 'del', text: 'old', oldNo: 1 }, { tag: 'add', text: 'new', newNo: 1 }], onClose: () => {} },
  theme: 'light', sidebar: 'hidden', copilot: 'hidden',
  saveNote: { path: 'src/a.js', added: 1, removed: 0 },
})
for (const [name, fn] of Object.entries(renderers)) {
  try {
    fn()
  } catch (e) {
    process.stdout.write(`  ✗ ${name} threw (open branch): ${e.message}\n`)
    failures++
  }
}

// `then` is not a field read: it is what a caller sees when a bare state object
// is handed to something that checks for a thenable. `await state` is not in the
// code today, but if it ever were, this is the one property that is not a field.
const undeclared = [...reads]
  .filter((f) => !declared.has(f) && f !== 'then')
  .sort()

// Store methods are a second, separate surface with the same failure mode:
// explorer.mjs calls `store.toggleDir`, which no literal declares.
const methods = Object.keys(store)
const usedMethods = new Set()
for (const file of ['panes/explorer.mjs', 'main.mjs', 'panes/copilot.mjs', 'panes/statusbar.mjs', 'panes/editor.mjs', 'state.mjs']) {
  const src = fs.readFileSync(new URL('../src/client/' + file, import.meta.url), 'utf8')
  for (const m of src.matchAll(/(?<![\w$.])store\.([a-zA-Z_$][\w$]*)/g)) usedMethods.add(m[1])
}
const missingMethods = [...usedMethods].filter((m) => !methods.includes(m)).sort()

// And a click, because the directory twisty is the one path that only exists at
// runtime: a method that does not exist throws on first use, not on load. Two
// clicks, because what has to hold is not "did not throw" — a `toggleDir() {}`
// satisfies that and leaves a tree that never opens — but "flipped, then flipped
// back".
const openBefore = store.get().expanded.has('src')
const click = async () => { try { await toggleDir(store, 'src'); return null } catch (e) { return e } }
const clickThrew = await click()
const openAfterFirst = store.get().expanded.has('src')
await click()
const openAfterSecond = store.get().expanded.has('src')
const clickToggles = openAfterFirst !== openBefore && openAfterSecond === openBefore

process.stdout.write('\nstate shape drift\n')
process.stdout.write(`  declared by createStore: ${declared.size} fields\n`)
process.stdout.write(`  read by the panes:     ${reads.size} properties\n`)
process.stdout.write(`  undeclared reads:       ${undeclared.length ? undeclared.join(', ') : 'none'}\n`)
process.stdout.write(`  store methods called:   ${[...usedMethods].sort().join(' ') || 'none'}\n`)
process.stdout.write(`  missing methods:        ${missingMethods.length ? missingMethods.join(', ') : 'none'}\n`)
process.stdout.write(`  a directory click:      ${clickThrew ? 'threw — ' + clickThrew.message : clickToggles ? 'opened, then closed again' : 'did not toggle the directory'}\n`)

if (undeclared.length) {
  for (const f of undeclared) process.stdout.write(`      ${f} — read by the panes, absent from createStore()\n`)
  failures++
}
if (missingMethods.length) failures++
if (clickThrew) failures++
if (!clickThrew && !clickToggles) failures++

// The two structured props `h()` takes are the rest of the "a pane reads
// something that is not there" class: both used to fail silently rather than
// throw, so both are dead CSS rather than a crash. `class` arrives as an array
// from nine call sites, and `style` carries the three grid-size custom
// properties the layout reads.
const { h } = await import('../src/client/dom.mjs')
const classed = h('div.tree-row', { class: [false, true && 'selected', false] })
const styled = h('div.workbench', { style: { '--meowui-sidebar-w': '300px', paddingLeft: '8px' } })
const classOk = classed.className === 'selected'
const styleOk = styled.style.getPropertyValue('--meowui-sidebar-w') === '300px' && styled.style.paddingLeft === '8px'
if (!classOk) {
  process.stdout.write(`      a class array became ${JSON.stringify(classed.className)} — every conditional class is lost\n`)
  failures++
}
if (!styleOk) {
  process.stdout.write(`      a custom property did not reach the style — ${JSON.stringify(styled.style)}\n`)
  failures++
}

process.stdout.write(`  a class array:           ${classOk ? 'becomes "selected"' : String(JSON.stringify(classed.className))}\n`)
process.stdout.write(`  a custom property:       ${styleOk ? 'reaches the style' : 'lost'}\n`)
process.stdout.write(`\n${failures ? `${failures} drift check(s) FAILED\n` : 'the panes read only declared state\n'}\n`)
process.exit(failures ? 1 : 0)
