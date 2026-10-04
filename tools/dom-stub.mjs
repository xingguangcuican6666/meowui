// A DOM small enough to run h()/fill() and every pane, and loud enough to fail
// loudly. It is not a browser: it has no layout, no CSS engine and no events
// beyond the ones `h()` registers. That is enough for the whole render path,
// which is exactly the claim the drift check makes — see tools/drift-check.mjs.

class StubNode {}
class StubText extends StubNode {
  constructor(text) { super(); this.nodeType = 3; this.text = String(text) }
}
class StubElement extends StubNode {
  constructor(name) {
    super()
    this.nodeType = 1
    this.tagName = String(name).toUpperCase()
    this.children = []
    this.attributes = {}
    this.style = stubStyle()
    this.dataset = {}
    this.className = ''
    this.listeners = new Map()
    this.classList = stubClassList(this)
  }
  append(...kids) { this.children.push(...kids) }
  replaceChildren(...kids) { this.children = []; this.append(...kids) }
  remove() {}
  setAttribute(name, value) { this.attributes[name] = String(value) }
  getAttribute(name) { return name in this.attributes ? this.attributes[name] : null }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(fn)
  }
  /** Fire the click handlers `h()` registered. */
  click() {
    for (const fn of this.listeners.get('click') ?? []) fn({ stopPropagation() {}, preventDefault() {}, target: this })
  }
  /** Depth-first text, so a check can assert on what a pane rendered. */
  get text() {
    return this.children.map((c) => (c.nodeType === 3 ? c.text : c.text ?? '')).join('')
  }
  /** Depth-first elements, for asserting on classes. */
  findAll(pred = () => true, out = []) {
    for (const c of this.children) if (c.nodeType === 1) { if (pred(c)) out.push(c); c.findAll(pred, out) }
    return out
  }
}

// A real CSSStyleDeclaration is a proxy-like host object: assigning a property
// that has no accessor on it writes an ordinary JS expando that the CSS engine
// never sees. The stub reproduces that, because the defect it makes visible is
// exactly that — `Object.assign(el.style, …)` succeeds, throws nothing, and the
// custom property silently never reaches the stylesheet.
function stubStyle() {
  const declared = new Map()
  return {
    setProperty(name, value) { declared.set(name, String(value)) },
    getPropertyValue(name) { return declared.get(name) ?? '' },
  }
}

function stubClassList(el) {
  const tokens = () => el.className.split(/\s+/).filter(Boolean)
  return {
    add(...cs) { el.className = [...tokens(), ...cs].join(' ') },
    remove(...cs) { const drop = new Set(cs); el.className = tokens().filter((c) => !drop.has(c)).join(' ') },
    contains: (c) => tokens().includes(c),
  }
}

/**
 * Install the stub on globalThis and return the document. Call before importing
 * anything from src/client — `dom.mjs` captures nothing at import time, but
 * `api.mjs` does read `window.MEOWUI_TOKEN` at module scope.
 */
export function installDom() {
  const doc = {
    createElement: (name) => new StubElement(name),
    createElementNS: (_ns, name) => new StubElement(name),
    createTextNode: (text) => new StubText(text),
    getElementById: (id) => (id === 'root' ? doc.root : null),
    documentElement: new StubElement('html'),
    body: new StubElement('body'),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    root: new StubElement('div'),
  }
  globalThis.Node = StubNode
  globalThis.Element = StubElement
  globalThis.document = doc
  globalThis.window = globalThis.window ?? { addEventListener() {}, removeEventListener() {} }
  globalThis.window.MEOWUI_TOKEN = globalThis.window.MEOWUI_TOKEN || 'drift-check'
  // Assigned, never `??=`: node ships a built-in `localStorage` that throws unless
  // --localstorage-file is given, and the panes' preference code reads it.
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {}, clear() {} }
  globalThis.location = { origin: 'http://meowui.test', search: '?t=drift-check', reload() {} }
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' })
  globalThis.prompt = () => null
  // Attached to the document so a vm sandbox can be handed the same globals the
  // bundle expects, without the stub and the sandbox drifting apart.
  doc.location = { origin: 'http://meowui.test', search: '?t=boot-smoke', reload() {} }
  doc.defaultView = { localStorage: { getItem: () => null, setItem() {}, removeItem() {}, clear() {} } }
  return doc
}

export { StubElement, StubText, StubNode }
