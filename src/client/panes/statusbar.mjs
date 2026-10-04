// The status bar, and the panel above it.
//
// The status bar's job is to answer "where am I, and what just happened" in one
// line, in VS Code's idiom: branch on the left, cursor and encoding on the right,
// problems in the middle. Everything here is derived — nothing is stored twice.

import { h } from '../dom.mjs'

export function renderStatusBar(store, actions) {
  const state = store.get()
  const errors = state.problems.filter((p) => p.severity === 'error').length
  const warnings = state.problems.length - errors
  const u = state.usage
  const tokens = u ? `${formatTokens(u.inputTokens)} in · ${formatTokens(u.outputTokens)} out` : ''

  return h('div.status-bar',
    state.branch
      ? h('button.status-item', { title: state.branch, onclick: actions.refreshGit }, h('span', {}, '⑂'), h('span', {}, state.branch))
      : null,
    h('button.status-item', { title: 'Reveal the workspace', onclick: () => navigator.clipboard?.writeText(state.cwd) }, state.cwd || '—'),
    h('span.spacer'),
    h('button.status-item', {
      title: errors ? `${errors} errors, ${warnings} warnings` : 'no problems detected',
      onclick: () => store.toggle('panel'),
    },
      errors ? h('span', { style: { color: '#f14c4c' } }, `✗ ${errors}`) : null,
      warnings ? h('span', { style: { color: '#cca700' } }, `⚠ ${warnings}`) : null,
      !errors && !warnings ? h('span', {}, '✓ 0') : null,
    ),
    tokens ? h('span.status-item', { title: 'tokens for this session' }, tokens) : null,
    h('span.status-item', {}, `Ln ${state.cursor?.line ?? 1}, Col ${state.cursor?.column ?? 1}`),
    h('button.status-item', { title: 'Switch theme', onclick: actions.toggleTheme }, state.theme === 'dark' ? '☾ Dark' : '☀ Light'),
    h('span.status-item', { title: 'The host process — this stream is ' + (state.connected ? 'live' : 'reconnecting') },
      h('span.status-dot', { class: state.connected ? 'ready' : '' })),
  )
}

/**
 * The Problems panel.
 *
 * It is derived entirely from the timeline — error rows and error tool results.
 * A separate error channel would be a second thing to keep in sync with the
 * transcript, and it would eventually disagree with it.
 */
export function renderPanel(store, actions) {
  const state = store.get()
  const problems = collectProblems(state)

  return h('div.panel',
    h('div.grip', { onpointerdown: actions.dragPanel }),
    h('div.head',
      h('span', {}, 'Problems'),
      h('span', {}, `${problems.length}`),
      h('span.spacer'),
      h('button.icon-btn', { title: 'Close (Ctrl+`)', onclick: () => store.toggle('panel') }, '×'),
    ),
    h('div.body',
      problems.length
        ? problems.map((p) => h('div.problem', { onclick: p.path ? () => actions.openFile(p.path) : null },
            h('span.sev', { class: p.severity }, p.severity === 'error' ? '✗' : '⚠'),
            h('span', {}, p.text),
            p.path ? h('span', { style: { opacity: 0.6 } }, p.path) : null,
          ))
        : h('div.empty', {}, 'No problems have been reported in this session.'),
    ),
  )
}

// The transcript's own error rows, oldest first, most recent last — the order a
// Problems list is expected to be in.
function collectProblems(state) {
  const out = []
  for (const r of state.rows) {
    if (r.kind !== 'error') continue
    const text = String(r.text).replace(/^⚠\s*/, '')
    const file = /(?:^|\s)((?:\.{0,2}\/)?[\w./-]+\.\w+)/.exec(text)?.[1]
    out.push({ severity: 'error', text, path: file && !file.includes(' ')? file : null })
  }
  return out
}

function formatTokens(n) {
  if (n == null) return '0'
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}