# meowui

A VS Code-shaped workbench for MeowCode, shipped as an entry plugin. The main
pane is the code; the agent is a collapsible sidebar next to it.

```
meowcode meowui        # then open the URL it prints
```

## What it is

Three files go into the entry directory, and that is the whole runtime:

| file | what it is | size |
|---|---|---|
| `launcher.js` | the host side — RPC client, HTTP/SSE server, workspace file API — bundled by `build.mjs` | 22 KB |
| `webui.js` | the front-end — Monaco inlined, workers inlined, no framework | 4.7 MB (1.3 MB gzipped) |
| `webui.css` | the VS Code design language, as CSS custom properties | 26 KB |

No `node_modules` beside them, no loader runtime, no bundler config the user has
to know about. `npm run build` regenerates the two bundles; `npm test` drives the
built plugin the way a browser would.

## The design decision worth stating

**The human drives. The agent is a copilot.**

Every row the agent produces is actionable, because a harness is not a chat box:

- a tool row (`⚙ edit_file · src/app.tsx`) opens that file;
- a change row (`⎿ +12 −3`) opens the diff, computed by the **host** and handed
  over as `DiffLine[]`, so what the review shows and what the transcript records
  cannot drift apart;
- a save the *user* makes goes out as `tools/call write_file`, so a human edit
  lands in the same timeline, with the same diffs, as an agent edit.

Reads and writes are deliberately asymmetric. Reads go straight to the
filesystem (`/api/fs/*`), because a file tree that waits for a tool round trip is
not an editor. Writes go through the host, because a write the host does not know
about is a write nothing can audit.

The agent can only *propose*. Nothing it produces is applied to a model without
the user having asked for it in the first place.

## Layout

```
activity │ tabs / breadcrumb          │ copilot  │
  bar    ├────────────────────────────┤ (model,  │
         │                            │  status, │
         │   Monaco, multi-tab,       │  timeline│
         │   ⌘S saves through the     │   of     │
         │   host, ● on dirty tabs     │  turns)  │
         ├────────────────────────────┤          │
         │ panel — problems, resizable│ > input  │
         ├────────────────────────────┴──────────┤
         status: branch · cwd · problems · tokens · Ln,Col · theme · ●
```

Keyboard: `⌘B` explorer, `⌘K` copilot, `⌘S` save, `⌘P` go-to-file,
`⌘⇧P` commands, `` ⌘` `` panel, `⌘W` close tab, `⌘N` new file, `Esc` stop the
turn (and, otherwise, close the diff).

## Why the parts are the size they are

**Monaco, hand-picked.** `monaco-editor@0.57` cannot be imported the way its
README suggests: the `exports` map rewrites `./x.js` → `./esm/vs/x.js`, so a bare
`monaco-editor/esm/vs/...` specifier resolves to a doubled path, and *both* of its
entry points (`esm/vs/index.js`, `editor/editor.main.js`) import
`external/monaco-lsp-client`, which is not in the published tarball. So
`src/client/monaco.mjs` imports `monaco-editor/editor/editor.api.js` plus the ~45
`contrib/*` registrations and language definitions it actually wants.

**Two workers, not three.** `editorWorkerService` (300 KB) is required — diff
computation and word-based suggestions live in it. `json` (427 KB) is JSON's
tokenizer *itself*: Monaco has no basic-language definition for JSON. The
TypeScript worker is deliberately absent. It is 6.8 MB of inlined compiler, and a
worker cannot see this workspace's `node_modules` or `tsconfig`, so its
type-checking would report errors against lib files that are not loaded and find
nothing in the project. Shipping 6.8 MB for a misleading answer is the wrong
trade; `build.mjs` says so at the point of the decision.

**No framework.** The entire UI is `h()` from `src/client/dom.mjs` and a
`render()` that is a pure function from state to subtree. The two things that
must survive a re-render — Monaco's container and the copilot's textarea — are
module-level singletons that get re-attached. A workbench this size does not need
a virtual DOM, and not having one is what keeps the bundle at one file.

## Security posture

A loopback HTTP port with no token is reachable from any web page the user has
open, because browsers may `GET` localhost cross-origin — and a page that can
read the workspace can also drive the agent. So:

- every request carries `?t=`, the `meowui_token` cookie, or
  `Authorization: Bearer` — the static bundle included;
- the shell embeds the token on its two subresource URLs, because a page's query
  string is not inherited by the `<link>` and `<script>` it references. This is
  also the one thing a blank page can teach you: a script that 401s never runs, so
  the browser says nothing at all. The shell therefore carries a boot watchdog —
  the one part of the front-end that does not need the bundle — which says what
  went wrong instead of leaving an empty `#root`;
- the token is 32 random bytes, stored `0600` beside the entry;
- every `/api/fs/*` path is resolved and checked for containment in the session
  root, and **symlinks are refused** rather than followed;
- the fixed port is single-instance: a bind failure exits with a message instead
  of starting a second workbench on the wrong workspace.

The API key never crosses the bridge — `config/get` strips it — and the
autosaved session file stores the config without it.

## Environment

| variable | effect |
|---|---|
| `MEOWUI_PORT` | listen port (default 4711, loopback only, single instance) |
| `MEOWUI_OPEN=0` | do not try to open a browser |
| `MEOWUI_BROWSER` | one command to open the workbench with, instead of the built-in list |

Opening a browser is a convenience, never a requirement — a headless machine has
no `xdg-open`, and that must not take the service down. The launcher tries
`xdg-open`, `gio open`, `gnome-open`, `kde-open`, `wslview` and `open` in turn,
and says one line on stderr if none of them exists. It does not matter whether a
particular opener actually displayed anything (a `gio open` with no display exits
non-zero, indistinguishable from success from out here) — the URL is always on
stderr, so the notice is a nicety rather than a promise.

## How it talks to MeowCode

The plugin is the JSON-RPC **client**, MeowCode the server, over the child's
stdin/stdout. Two facts that are easy to get backwards, both measured:

- host→plugin lines arrive on the child's **stdin**, and a child cannot write to
  its own stdin — the plugin writes only to stdout;
- the host never sends the session cwd. `process.cwd()` is it, which is what the
  manifest's `"cwd": "."` buys, and why `src/server/*` is told the entry
  directory explicitly instead of guessing from the workspace.

## Testing without a browser

Three files, no dependencies, run in order by `npm test`.

`tools/drift-check.mjs` and `tools/boot-smoke.mjs` cover the client, which the
simulator cannot: it drives the plugin over HTTP and never executes a line of
front-end code, so every pane was untested. Both run against `tools/dom-stub.mjs`,
a document small enough to build a subtree in and faithful in the two places
where being generous would hide a bug — `className` coerces an array the way a
real `DOMTokenList` does not, and `style` refuses expando assignment the way a
real `CSSStyleDeclaration` does not.

The drift check does not read the source to find the reads. It runs every pane
against a real store whose state object is a `Proxy` and records what the panes
touch, so the declared set and the read set are both runtime facts and cannot
drift apart. `tools/boot-smoke.mjs` goes one level further: it bundles
`main.mjs` with esbuild — the bare `monaco-editor` specifier intercepted, since
4.9 MB of editor is not what is under test — and runs the whole bundle in a
`node:vm` sandbox against the stub, so `main()` really does boot. Both were
written against a real failure: `statusbar.mjs` reading a `problems` field no
store declared, whose `.filter` is what turned a boot into a red box.

Monaco is the honest limit. The stub replaces it with no-ops, so a pane that
read `monaco.something` that does not exist would pass; nothing about Monaco's
own DOM, its workers, or its theme validation is covered here.

`tools/simulate.mjs` is 62 checks over the plugin's own HTTP surface — the same
routes, token, SSE frames a browser would use — with the MeowCode side of the pipe
faked. It imports nothing from meowcode's source, on purpose: a test that
reached into the host's internals would be testing the host, and the thing worth
testing here is the boundary.

That constraint has one sharp edge worth stating, because it is where the blank
page came from: the simulator adds the token to every request it makes, so it
cannot tell a correct URL from one the *browser* could not have produced. A client
that supplies its own credentials proves nothing about what a browser ends up
fetching. So the markup's own URLs are requested verbatim, with nothing added —
and the shell's inline watchdog is executed in a `node:vm` sandbox, because a
watchdog that cannot be tested without a browser is a watchdog that silently stops
working.

The event shapes it replays are the real ones, so a front-end that renders them
wrongly fails here rather than in front of a user. And because the host side of
meowcode's bridge is covered by `src/lib/launcher.test.ts` — against a real child
process, not a mock — both ends of the protocol are pinned.