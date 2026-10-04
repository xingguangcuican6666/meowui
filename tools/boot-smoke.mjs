import esbuild from 'esbuild'
import vm from 'node:vm'

import { installDom, StubNode, StubElement, StubText } from './dom-stub.mjs'

// Monaco is 4.9 MB of editor that needs layout, workers and a real DOM. It is not
// what is under test, so it is replaced with a stub — by intercepting the
// bare specifier at bundle time, not by editing the source. Everything else the
// bundle contains is the code the browser would run.
const MONACO_STUB = {
  name: 'stub-monaco',
  setup(build) {
    build.onResolve({ filter: /^monaco-editor\// }, () => ({ path: 'monaco', namespace: 'stub-monaco' }))
    build.onLoad({ filter: /.*/, namespace: 'stub-monaco' }, () => ({
      loader: 'js',
      contents: `
        export const monaco = {
          editor: {
            create: () => ({
              addCommand() {}, onDidChangeCursorPosition() {}, onDidChangeModelContent() {},
              onDidScrollChange() {}, setModel() {}, setScrollTop() {}, setScrollLeft() {},
              getPosition: () => ({ lineNumber: 1, column: 1 }), getScrollTop: () => 0, getScrollLeft: () => 0,
            }),
            createModel: () => ({ isDirty: () => false, setValue() {}, getValue: () => '', dispose() {} }),
            defineTheme() {}, setTheme() {},
          },
          KeyMod: 2048, KeyCode: { KeyS: 49 },
        }
        export function applyTheme() {}
        export function languageOf() { return 'plaintext' }
      `,
    }))
    build.onLoad({ filter: /\.(css|ttf|woff2?)$/, namespace: 'file' }, () => ({ contents: '', loader: 'text' }))
  },
}

const built = await esbuild.build({
  entryPoints: ['src/client/main.mjs'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  write: false,
  logLevel: 'silent',
  define: { 'process.env.MEOWUI_WORKERS': '{}', 'process.env.NODE_ENV': '"production"' },
  plugins: [MONACO_STUB],
})

const doc = installDom()
const json = (o) => Promise.resolve({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(o) })
// main().catch ends in console.error(e). That line is the boot failure arriving,
// so it is captured rather than printed: a check has to be able to say *why*.
const consoleErrors = []
const console_ = { log: () => {}, warn: () => {}, error: (...a) => consoleErrors.push(a.map(String).join(' ')) }
const sandbox = {
  console: console_,
  setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
  URL, URLSearchParams, Blob, TextEncoder, TextDecoder,
  Node: StubNode, Element: StubElement,
  process: { env: { MEOWUI_WORKERS: '{}' } },
  MutationObserver: class { observe() {} disconnect() {} },
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
  crypto: { getRandomValues: (a) => a },
  fetch: async (url) => {
    const u = String(url)
    if (u.includes('/api/cwd')) return json({ cwd: '/w' })
    if (u.includes('/api/config')) return json({ provider: 'mock', model: 'mock-model' })
    if (u.includes('/api/git')) return json({ branch: 'main' })
    if (u.includes('/api/fs/tree')) return json({ entries: [{ dir: true, path: 'src', name: 'src' }] })
    if (u.includes('/api/state')) return json({ messages: [{ role: 'user', content: 'hi' }], usage: null })
    return json({})
  },
  EventSource: class { constructor() {} addEventListener() {} close() {} },
  document: doc,
  prompt: () => null,
  self: null, window: null,
  // The globals dom.mjs / api.mjs / editor.mjs touch at module scope and at call
  // time. Each one is here because a missing global produces a *different*
  // failure than the one under test, and a red test that means "the stub is
  // incomplete" is worse than no test.
  location: doc.location,
  localStorage: doc.defaultView.localStorage,
  navigator: { clipboard: { writeText() {} }, userAgent: 'node' },
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  performance,
}
sandbox.self = sandbox
sandbox.window = sandbox
sandbox.window.MEOWUI_TOKEN = 'boot-smoke'
const listeners = new Map()
sandbox.window.addEventListener = (type, fn) => { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn) }
sandbox.window.removeEventListener = () => {}
// The shell's own inline watchdog, as http.mjs defines it: if the bundle never
// raises the booted flag within its own deadline, the box is painted. Recording
// the call is how a boot that never finishes is told apart from one that throws.
let failBox = null
sandbox.window.__meowuiFail = (why) => { failBox = why }

const rootEl = doc.getElementById('root')
let thrown = null
try {
  vm.runInNewContext(built.outputFiles[0].text, sandbox, { filename: 'meowui-boot-smoke.js', timeout: 20_000 })
} catch (e) {
  thrown = e
}
// main() is async: its rejection is handled by main().catch, which paints the
// box. Let the microtask queue and the one real timer the code schedules settle.
for (let i = 0; i < 40 && sandbox.window.__meowuiBooted !== true && !thrown; i++) {
  await new Promise((r) => setTimeout(r, 5))
}

const workbench = rootEl.children.find((c) => c.nodeType === 1 && String(c.className).includes('workbench'))
const checks = [
  ['the bundle evaluates', !thrown, thrown ? `${thrown.name}: ${thrown.message}` : ''],
  ['main() does not reject', failBox === null && consoleErrors.length === 0, failBox ?? consoleErrors.join('\n')],
  ['main() reports itself booted', sandbox.window.__meowuiBooted === true, String(sandbox.window.__meowuiBooted)],
  ['the workbench is painted', Boolean(workbench), String(rootEl.children.map(String))],
]

let failures = 0
process.stdout.write('\nthe first render, headlessly\n')
for (const [label, ok, detail] of checks) {
  if (ok) process.stdout.write(`  ✓ ${label}\n`)
  else { failures++; process.stdout.write(`  ✗ ${label}\n      ${detail}\n`) }
}
process.stdout.write(`\n${failures ? `${failures} boot smoke check(s) FAILED\n` : 'the workbench starts\n'}\n`)
process.exit(failures ? 1 : 0)
