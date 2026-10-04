// Monaco ownership: one editor, one model per path.
//
// The rule that keeps this simple: a `path` maps to exactly one model, however
// many tabs reference it, and only one editor instance exists — the active tab's.
// Creating an editor per tab and hiding the others is how VS Code does it (real
// editor groups, per-tab scroll state), but it costs N live editors and the scroll
// position of every tab to be saved by hand; for a workbench whose point is that
// a human is driving, that is not worth it. Scroll position *is* remembered, per
// path, because losing your place on tab-switch is the thing users notice first.
//
// Editor state lives here rather than in the store. Monaco owns a DOM subtree the
// re-render path must never touch, so the store never holds an editor and
// `render()` never rebuilds the host element.
import { monaco, applyTheme, languageOf } from './monaco.mjs'

const models = new Map()     // path → ITextModel
const scroll = new Map()     // path → { top, left }
let editor = null
let current = null           // the path the live editor is showing

export function mountEditor(hostEl, { onSave, onCursor, onDirty, theme }) {
  editor = monaco.editor.create(hostEl, {
    value: '',
    language: 'plaintext',
    theme: 'meowui-' + theme,
    automaticLayout: true,
    minimap: { enabled: true, renderCharacters: false },
    fontLigatures: true,
    fontSize: 13,
    tabSize: 2,
    renderWhitespace: 'selection',
    scrollBeyondLastLine: false,
    smoothScrolling: true,
    bracketPairColorization: { enabled: true },
  })
  // Ctrl/Cmd+S is the workbench's save, not the browser's "save page".
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => onSave())
  editor.onDidChangeCursorPosition((e) => onCursor({ line: e.position.lineNumber, column: e.position.column }))
  editor.onDidChangeModelContent(() => { if (current) onDirty(current) })
  editor.onDidScrollChange(() => rememberScroll(current))
  applyTheme(theme)
  return editor
}

/**
 * Point the editor at a path, creating its model if this is the first time we have
 * seen the file. Callers pass the content they already read; re-reading here would
 * race the watcher.
 */
export function open(path, content) {
  let model = models.get(path)
  if (!model) {
    model = monaco.editor.createModel(content ?? '', languageOf(path))
    models.set(path, model)
  }
  show(path)
  return model
}

/** Swap the live editor to an already-created model, keeping its scroll place. */
export function show(path) {
  const model = models.get(path)
  if (!model || !editor) return
  if (current === path) return
  rememberScroll(current)
  current = path
  editor.setModel(model)
  const at = scroll.get(path)
  if (at) { editor.setScrollTop(at.top); editor.setScrollLeft(at.left) }
}

/**
 * Adopt a change made on disk. Called when the watcher reports a path that is not
 * our own write.
 *
 * A clean model takes the new text. A model the user has typed into does *not* —
 * overwriting their unsaved work because something else touched the file is
 * unforgivable, and silently refusing is worse. The caller decides what to tell
 * them; this only reports which case it was.
 */
export function reload(path, content) {
  const model = models.get(path)
  if (!model) return 'absent'
  if (model.isDirty()) return 'dirty'
  model.setValue(content)
  return 'ok'
}

/** Undo the user's local edits — the tab's "discard changes" action. */
export function revert(path, content) {
  const model = models.get(path)
  if (model) model.setValue(content)
}

export function value(path = current) {
  const model = models.get(path)
  return model ? model.getValue() : ''
}

export function isDirty(path) {
  return models.get(path)?.isDirty() ?? false
}

export function markSaved(path) {
  // setValue is what clears Monaco's dirty flag for an external edit; our own save
  // writes back byte-identical text, so this is a no-op in the common case and
  // the correct fix when the host normalized a trailing newline.
  const model = models.get(path)
  if (!model) return
  const disk = model.getValue()
  if (disk.endsWith('\n')) model.setValue(disk)
}

/** Drop a model once no tab references it any more. */
export function release(path) {
  const model = models.get(path)
  if (!model) return
  if (current === path) { current = null; editor?.setModel(null) }
  models.delete(path)
  scroll.delete(path)
  model.dispose()
}

export function has(path) {
  return models.has(path)
}

export function cursor() {
  const p = editor?.getPosition()
  return p ? { line: p.lineNumber, column: p.column } : { line: 1, column: 1 }
}

export function retokenize(theme) {
  applyTheme(theme)
}

function rememberScroll(path) {
  if (!path || !editor) return
  scroll.set(path, { top: editor.getScrollTop(), left: editor.getScrollLeft() })
}