// Monaco, loaded by hand from the package's ESM tree.
//
// Two things about monaco-editor@0.57 decide how this file is written, and both
// are the reason importing `monaco-editor` plainly does not work:
//
//   1. The package's own entry points (`esm/vs/index.js`, `esm/vs/editor/editor.main.js`)
//      re-export a `lsp` namespace from `../../external/monaco-lsp-client/out/index.js`,
//      and that directory is not in the published tarball. Importing either entry
//      therefore fails to resolve. The same entry points also register all ~90
//      language tokenizers, which is a few hundred KB for grammars a code editor
//      will never open.
//   2. Its `exports` map rewrites `./x.js` to `./esm/vs/x.js`, so a bare specifier
//      resolves to a doubled path under esbuild's resolver.
//
// So this file reaches past the entry points: `editor.api.js` for the API, and the
// individual `contrib/*` registrations for the editor's UI. That is more imports,
// but each one is a deliberate choice about what this workbench actually offers —
// no source control decoration, no debug view, no notebooks.
import * as monaco from 'monaco-editor/editor/editor.api.js'

// The editor's UI contributions. Each of these is the standalone Monaco's feature
// set minus what a copilot-adjacent workbench has no use for.
import 'monaco-editor/editor/contrib/anchorSelect/browser/anchorSelect.js'
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js'
import 'monaco-editor/editor/contrib/caretOperations/browser/caretOperations.js'
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard.js'
import 'monaco-editor/editor/contrib/codeAction/browser/codeActionContributions.js'
import 'monaco-editor/editor/contrib/comment/browser/comment.js'
import 'monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js'
import 'monaco-editor/editor/contrib/cursorUndo/browser/cursorUndo.js'
import 'monaco-editor/editor/contrib/documentSymbols/browser/documentSymbols.js'
import 'monaco-editor/editor/contrib/find/browser/findController.js'
import 'monaco-editor/editor/contrib/folding/browser/folding.js'
import 'monaco-editor/editor/contrib/hover/browser/hoverContribution.js'
import 'monaco-editor/editor/contrib/indentation/browser/indentation.js'
import 'monaco-editor/editor/contrib/inlayHints/browser/inlayHintsContribution.js'
import 'monaco-editor/editor/contrib/lineSelection/browser/lineSelection.js'
import 'monaco-editor/editor/contrib/linesOperations/browser/linesOperations.js'
import 'monaco-editor/editor/contrib/linkedEditing/browser/linkedEditing.js'
import 'monaco-editor/editor/contrib/links/browser/links.js'
import 'monaco-editor/editor/contrib/multicursor/browser/multicursor.js'
import 'monaco-editor/editor/contrib/parameterHints/browser/parameterHints.js'
import 'monaco-editor/editor/contrib/placeholderText/browser/placeholderText.contribution.js'
import 'monaco-editor/editor/contrib/smartSelect/browser/smartSelect.js'
import 'monaco-editor/editor/contrib/suggest/browser/suggestController.js'
import 'monaco-editor/editor/contrib/tokenization/browser/tokenization.js'
import 'monaco-editor/editor/contrib/wordHighlighter/browser/wordHighlighter.js'
import 'monaco-editor/editor/contrib/wordOperations/browser/wordOperations.js'
import 'monaco-editor/editor/contrib/wordPartOperations/browser/wordPartOperations.js'
import 'monaco-editor/editor/browser/coreCommands.js'

// Tokenizers, one language at a time. `basic-languages/monaco.contribution.js`
// would register all ~90; these are the ones a JavaScript/TypeScript project in
// this workspace actually opens.
import 'monaco-editor/languages/definitions/typescript/register.js'
import 'monaco-editor/languages/definitions/javascript/register.js'
// JSON has no basic-language definition: its tokenizer ships inside the language
// service's worker, so importing `language/json` below is what colours it.
import 'monaco-editor/languages/definitions/markdown/register.js'
import 'monaco-editor/languages/definitions/css/register.js'
import 'monaco-editor/languages/definitions/scss/register.js'
import 'monaco-editor/languages/definitions/less/register.js'
import 'monaco-editor/languages/definitions/html/register.js'
import 'monaco-editor/languages/definitions/xml/register.js'
import 'monaco-editor/languages/definitions/yaml/register.js'
import 'monaco-editor/languages/definitions/ini/register.js'
import 'monaco-editor/languages/definitions/shell/register.js'
import 'monaco-editor/languages/definitions/python/register.js'
import 'monaco-editor/languages/definitions/rust/register.js'
import 'monaco-editor/languages/definitions/go/register.js'
import 'monaco-editor/languages/definitions/ruby/register.js'
import 'monaco-editor/languages/definitions/java/register.js'
import 'monaco-editor/languages/definitions/cpp/register.js'
import 'monaco-editor/languages/definitions/csharp/register.js'
import 'monaco-editor/languages/definitions/php/register.js'
import 'monaco-editor/languages/definitions/sql/register.js'

// Language *services* — the parts that need a worker. Each registers itself and
// exposes a `getWorker`; build.mjs inlines their worker sources and the Blob-URL
// shim below turns them into URLs the worker can be spawned from.
//
// JSON is here because in Monaco its *tokenizer* is a worker — there is no
// basic-language definition for it, so leaving this out means every .json file in
// the workspace opens uncoloured.
//
// TypeScript's service is deliberately not imported. It is 6.8 MB of inlined
// compiler, and a browser worker cannot see this workspace's node_modules or
// tsconfig, so it would type-check against lib files it does not have and report
// errors in a project it cannot see. A wrong type checker is worse than none. When
// the workbench can hand the worker a real tsconfig, this line and one entry in
// build.mjs' WORKERS list are all it takes.
import 'monaco-editor/language/json/monaco.contribution.js'

// Monaco loads its workers from `MonacoEnvironment.getWorkerUrl`. The entry ships
// exactly one file (`webui.js`), so each worker is inlined as a source string at
// build time and becomes a Blob URL here — no sibling files, no loader runtime,
// and the worker is still a real worker so a tokenization pass does not block
// typing.
const WORKERS = process.env.MEOWUI_WORKERS ?? {}
const workerUrls = new Map()
for (const [label, source] of Object.entries(WORKERS)) {
  workerUrls.set(label, URL.createObjectURL(new Blob([source], { type: 'text/javascript' })))
}

self.MonacoEnvironment = {
  getWorkerUrl(_moduleId, label) {
    const url = workerUrls.get(label)
    if (url) return url
    // An unmapped label still has to get *something*: the editor worker boots
    // without a language worker and degrades to no language service, which beats
    // a hard failure to start the editor at all. This is also what keeps a stale
    // `webui.js` (built before a worker was added) working instead of throwing.
    return workerUrls.get('editorWorkerService')
  },
}

// ---- theme ------------------------------------------------------------------

const tokenOf = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()

// Only the tokens Monaco actually consumes. Mapping every VS Code colour would be
// more thorough and more wrong: several are composite expressions Monaco would
// read as literal garbage.
function colors() {
  return {
    'editor.background': tokenOf('--vscode-editor-background'),
    'editor.foreground': tokenOf('--vscode-editor-foreground'),
    'editorLineNumber.foreground': tokenOf('--vscode-editorLineNumber-foreground'),
    'editorLineNumber.activeForeground': tokenOf('--vscode-editorLineNumber-activeForeground'),
    'editor.selectionBackground': tokenOf('--vscode-editor-selectionBackground'),
    'editor.inactiveSelectionBackground': tokenOf('--vscode-editor-selectionBackground'),
    'editor.selectionHighlightBackground': tokenOf('--vscode-editor-selectionHighlightBackground'),
    'editorCursor.foreground': tokenOf('--vscode-editorCursor-foreground'),
    'editorIndentGuide.background1': tokenOf('--vscode-editorIndentGuide-background'),
    'editorWidget.background': tokenOf('--vscode-editorWidget-background'),
    'editorWidget.border': tokenOf('--vscode-editorWidget-border'),
    'editorSuggestWidget.background': tokenOf('--vscode-editorWidget-background'),
    'editorSuggestWidget.border': tokenOf('--vscode-editorWidget-border'),
    'editorHoverWidget.background': tokenOf('--vscode-editorWidget-background'),
    'editorHoverWidget.border': tokenOf('--vscode-editorWidget-border'),
    'scrollbarSlider.background': tokenOf('--vscode-scrollbarSlider-background'),
    'scrollbarSlider.hoverBackground': tokenOf('--vscode-scrollbarSlider-hoverBackground'),
    'scrollbarSlider.activeBackground': tokenOf('--vscode-scrollbarSlider-activeBackground'),
    'input.background': tokenOf('--vscode-input-background'),
    'input.foreground': tokenOf('--vscode-input-foreground'),
    'focusBorder': tokenOf('--vscode-focusBorder'),
    'list.activeSelectionBackground': tokenOf('--vscode-list-activeSelectionBackground'),
    'list.activeSelectionForeground': tokenOf('--vscode-list-activeSelectionForeground'),
    'list.hoverBackground': tokenOf('--vscode-list-hoverBackground'),
  }
}

/**
 * Define and apply the workbench's own theme.
 *
 * The colours are read off the CSS variables actually in use rather than copied
 * into a table, so switching Dark↔Light is one attribute flip on `<html>` plus one
 * `defineTheme` call and the editor cannot drift from the chrome around it.
 */
export function applyTheme(theme) {
  monaco.editor.defineTheme('meowui-' + theme, {
    base: theme === 'light' ? 'vs' : 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '6a9955' },
      { token: 'keyword', foreground: 'c586c0' },
      { token: 'string', foreground: 'ce9178' },
      { token: 'number', foreground: 'b5cea8' },
    ],
    colors: colors(),
  })
  monaco.editor.setTheme('meowui-' + theme)
}

/** Language id from a path's extension — Monaco needs one and does not guess. */
export function languageOf(path) {
  const ext = String(path).split('.').pop()?.toLowerCase()
  return ({
    ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    json: 'json', jsonc: 'json',
    html: 'html', htm: 'html', xml: 'xml', svg: 'xml',
    css: 'css', scss: 'scss', less: 'less',
    py: 'python', rs: 'rust', go: 'go', rb: 'ruby', sh: 'shell', bash: 'shell', zsh: 'shell',
    yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini', md: 'markdown',
    java: 'java', cpp: 'cpp', cc: 'cpp', h: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php', sql: 'sql',
  })[ext] ?? 'plaintext'
}

export { monaco }