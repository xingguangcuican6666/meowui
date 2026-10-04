// A 60-line DOM helper instead of a framework.
//
// The workbench has a handful of views, each of which is a function from state to
// a subtree. That is exactly the shape a template function fits, and the whole
// cost of a framework here would be a bundler runtime, an update-reconciliation
// strategy, and a second mental model to hold while reading Monaco's own DOM
// events. `h()` plus a `render()` that replaces a container's children is enough,
// and the parts that must not be thrown away on every redraw (Monaco, the tree
// scroll position, the composer caret) are the ones we deliberately keep outside
// the render path.

/**
 * h('div.foo#bar', {onclick, ...}, ...children)
 *
 * A tag string with `.class` and `#id` shorthands, VS Code-ish: terse enough to
 * read a whole pane's markup in one screen. Attributes starting with `on` become
 * listeners; everything else is set as a property when the DOM has that property
 * and as an attribute otherwise. `null`/`undefined`/`false` children are dropped,
 * so `cond && h(...)` reads well.
 */
export function h(tag, props, ...children) {
  const [name, ...rest] = tag.split(/(?=[.#])/)
  const el = document.createElement(name || 'div')
  for (const token of rest) {
    if (token[0] === '.') el.classList.add(token.slice(1))
    else el.id = token.slice(1)
  }
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue
      if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value)
      else if (key === 'class') el.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : value
      else if (key === 'style' && typeof value === 'object') {
        // A custom property is not a property of CSSStyleDeclaration, so
        // `Object.assign(el.style, …)` writes an expando the stylesheet never
        // reads — and silently: nothing about it throws. They have to go through
        // setProperty or the variable simply stays at its CSS fallback.
        for (const [prop, v] of Object.entries(value)) {
          if (prop.startsWith('--')) el.style.setProperty(prop, v)
          else el.style[prop] = v
        }
      }
      else if (key === 'dataset') Object.assign(el.dataset, value)
      else if (key in el) el[key] = value
      else el.setAttribute(key, value === true ? '' : String(value))
    }
  }
  append(el, children)
  return el
}

function append(el, children) {
  for (const child of children) {
    if (child == null || child === false) continue
    if (Array.isArray(child)) append(el, child)
    else el.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
}

/** Replace a container's children in one shot. */
export function fill(el, ...children) {
  el.replaceChildren()
  append(el, children)
  return el
}

export const $ = (sel, root = document) => root.querySelector(sel)
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)]

// ---- inline icons ------------------------------------------------------------
//
// The activity bar needs six glyphs. SVG beats an icon font (no extra request,
// no FOUT) and beats emoji (which render differently per platform — and this
// project keeps emoji out of its UI on purpose). Each is drawn on a 24×24 grid to
// match VS Code's codicon geometry.

const svg = (body) => {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  el.setAttribute('viewBox', '0 0 24 24')
  el.innerHTML = body
  return el
}

export const icons = {
  explorer: () => svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zm3 15H5V4h7v5h5z"/><path d="M19 11h-2v2h2zm0 4h-2v2h2z"/>'),
  search: () => svg('<path d="M10 2a8 8 0 1 0 4.9 14.32l5.39 5.39 1.42-1.42-5.39-5.39A8 8 0 0 0 10 2m0 2a6 6 0 1 1 0 12 6 6 0 0 1 0-12"/>'),
  git: () => svg('<path d="M21 6h-3.17A3 3 0 0 0 13 3.83V3a1 1 0 1 0-2 0v.83A3 3 0 0 0 6.17 6H3a1 1 0 1 0 0 2h3.17A3 3 0 0 0 10 11.17V20h2v-8.83a3 3 0 0 0 4.17-2.83H21a1 1 0 1 0 0-2m-8 .83a1 1 0 0 1 2 0 1 1 0 0 1-2 0"/>'),
  extensions: () => svg('<path d="M20.5 11H19V7a2 2 0 0 0-2-2h-4V3.5a2.5 2.5 0 0 0-5 0V5H4a2 2 0 0 0-2 2v3.8h1.5a2.7 2.7 0 0 1 0 5.4H2V20a2 2 0 0 0 2 2h3.8v-1.5a2.7 2.7 0 0 1 5.4 0V22H17a2 2 0 0 0 2-2v-4h1.5a2.5 2.5 0 0 0 0-5"/>'),
  chat: () => svg('<path d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2"/>'),
  settings: () => svg('<path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8m8.94 3a7.6 7.6 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a8 8 0 0 0-2-1.2l-.3-2.6h-4l-.3 2.6a8 8 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a8 8 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a8 8 0 0 0 2 1.2l.3 2.6h4l.3-2.6a8 8 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.06-.4.1-.8.1-1.2"/>'),
}