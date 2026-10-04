// Watch the workspace and tell the browser what moved.
//
// `fs.watch(root, { recursive: true })` reports every write, and a single editor
// save produces several (create, write, rename, chmod). So: collect events into
// a set, debounce, then emit the batch once. The client refreshes only the
// affected tree nodes and marks affected open tabs dirty — a full reload of the
// tree on every keystroke would be unusable.
//
// Recursive watching is supported on Linux since Node 20; where it is not, the
// watcher reports so and the client falls back to re-listing on demand.

import fs from 'node:fs'
import path from 'node:path'

const DEBOUNCE_MS = 150

// Paths the watcher must never report: our own token file lives inside the entry
// dir, and saving through the host rewrites files we are already watching.
function shouldSkip(abs) {
  const parts = abs.split('/')
  return parts.includes('.git') || parts.includes('node_modules')
}

export function watchWorkspace(root, onChanged) {
  let watcher
  try {
    watcher = fs.watch(root, { recursive: true, persistent: false }, (_event, filename) => {
      if (!filename) return
      const abs = path.resolve(root, filename.toString())
      if (shouldSkip(abs)) return
      pending.add(abs)
      schedule()
    })
  } catch (e) {
    // Not fatal: the workbench still works, it just won't notice external edits.
    process.stderr.write('[meowui] file watching unavailable (' + (e instanceof Error ? e.message : e) + ')\n')
    return { close() {} }
  }

  const pending = new Set()
  let timer = null
  function schedule() {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      const changed = [...pending].map((abs) => path.relative(root, abs))
      pending.clear()
      if (changed.length) onChanged(changed)
    }, DEBOUNCE_MS)
  }

  return {
    close() {
      if (timer) clearTimeout(timer)
      try { watcher.close() } catch { /* already closed */ }
    },
  }
}