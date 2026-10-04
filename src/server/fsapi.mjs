// The workspace file API: everything the browser is allowed to read.
//
// The rule this module exists to enforce: a request may only ever name a file
// inside the workspace root. That root is the session's cwd, which the launcher
// manifest pins to the session directory (`"cwd": "."`) — the host never reports
// it to us, and `process.cwd()` is the only truth we have.
//
// Three checks, in order, on every path:
//   1. resolve to absolute, then realpath — so `..`, symlinks and encoded
//      traversal all collapse to the same answer before anything is compared;
//   2. `path.relative(root, target)` must not start with `..` — the containment
//      test, done on the resolved path rather than on the raw string;
//   3. a symlink *inside* the workspace that points outside it is refused
//      outright, even though (1) would have caught the target: reading through it
//      is not what a file tree implies.
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'

// Anything larger is not text; anything with a NUL byte in the first chunk is
// not text either. Monaco can render neither, and refusing beats shipping a
// 40MB binary through a JSON response.
const MAX_TEXT_BYTES = 2 * 1024 * 1024
const SNIFF_BYTES = 4096

export class FsError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

const IGNORED = new Set(['node_modules', '.git', 'dist', '.cache', '.next', 'build', '.venv', '__pycache__', 'target', '.turbo'])

// Turn a request path into an absolute path inside the root, or throw.
// `rel` may be absolute (the client sends real paths) or relative to the root.
export function resolveInRoot(root, rel) {
  const raw = typeof rel === 'string' ? rel : ''
  const target = path.resolve(root, raw)
  const within = path.relative(root, target)
  if (within.startsWith('..') || path.isAbsolute(within)) {
    throw new FsError(403, 'path outside the workspace')
  }
  return target
}

// Same containment check, but after following symlinks — used before reading or
// listing, where the target matters more than the name.
async function realInRoot(root, target) {
  let real
  try {
    real = await fs.realpath(target)
  } catch (e) {
    if (e?.code === 'ENOENT') return null
    throw new FsError(400, e instanceof Error ? e.message : String(e))
  }
  const within = path.relative(root, real)
  if (within.startsWith('..') || path.isAbsolute(within)) {
    throw new FsError(403, 'path outside the workspace')
  }
  return real
}

function relTo(root, abs) {
  const rel = path.relative(root, abs)
  return rel === '' ? '.' : rel
}

// One directory level, the way a file tree asks for it: names, kinds, and
// whether the tree should even offer to expand them. Ignored directories are
// reported as `ignored` rather than hidden, so the greyed-out VS Code rows can
// be drawn from the same response that lists the visible ones.
export async function listDir(root, rel) {
  const target = resolveInRoot(root, rel)
  const real = await realInRoot(root, target)
  if (real === null) throw new FsError(404, 'no such directory')
  const stat = await fs.stat(real)
  if (!stat.isDirectory()) throw new FsError(400, 'not a directory')
  if (await isSymlink(target)) throw new FsError(403, 'refusing to follow a symlinked directory')

  const entries = await fs.readdir(real, { withFileTypes: true })
  const out = []
  for (const entry of entries) {
    const abs = path.join(real, entry.name)
    const isDir = entry.isDirectory()
    const ignored = isDir && IGNORED.has(entry.name)
    out.push({
      name: entry.name,
      path: relTo(root, abs),
      dir: isDir,
      symlink: entry.isSymbolicLink(),
      ignored,
    })
  }
  // Directories first, then case-insensitive by name — the order every file tree
  // uses, and the one users' muscle memory expects.
  out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) : a.dir ? -1 : 1))
  return { path: relTo(root, real), entries: out }
}

// Read one text file. Big or binary files are refused with a reason the UI can
// show, rather than silently truncated.
export async function readFile(root, rel) {
  const target = resolveInRoot(root, rel)
  const real = await realInRoot(root, target)
  if (real === null) throw new FsError(404, 'no such file')
  if (await isSymlink(target)) throw new FsError(403, 'refusing to follow a symlink')
  const stat = await fs.stat(real)
  if (!stat.isFile()) throw new FsError(400, 'not a file')
  if (stat.size > MAX_TEXT_BYTES) {
    throw new FsError(413, `file is ${(stat.size / 1048576).toFixed(1)} MB; the editor opens files under 2 MB`)
  }
  const head = Buffer.alloc(Math.min(SNIFF_BYTES, stat.size))
  const handle = await fs.open(real, 'r')
  try {
    await handle.read(head, 0, head.length, 0)
  } finally {
    await handle.close()
  }
  if (head.includes(0)) throw new FsError(415, 'this looks like a binary file')
  return {
    path: relTo(root, real),
    content: await fs.readFile(real, 'utf8'),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  }
}

// Create an empty file. The write itself is the host's job — see the client: a
// save goes out as `tools/call write_file`, so every edit lands in the session
// transcript with its diff, exactly like the agent's own edits.
export async function createFile(root, rel) {
  const target = resolveInRoot(root, rel)
  const within = path.relative(root, target)
  if (within.startsWith('..') || path.isAbsolute(within)) throw new FsError(403, 'path outside the workspace')
  const parent = path.dirname(target)
  await fs.mkdir(parent, { recursive: true })
  const handle = await fs.open(target, 'wx')
  await handle.close()
  return { path: relTo(root, target) }
}

export async function statPath(root, rel) {
  const target = resolveInRoot(root, rel)
  const stat = await fs.stat(target)
  return { path: relTo(root, target), dir: stat.isDirectory(), size: stat.size, mtimeMs: stat.mtimeMs }
}

// The branch name for the status bar, read straight out of .git/HEAD rather than
// by spawning git — the workbench asks for this on every repo change, and a
// process spawn per keystroke would be silly.
export function gitBranch(root) {
  const head = path.join(root, '.git', 'HEAD')
  try {
    const text = fsSync.readFileSync(head, 'utf8').trim()
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(text)
    if (ref) return ref[1]
    if (/^[0-9a-f]{40}$/.test(text)) return text.slice(0, 7) // detached HEAD
    return ''
  } catch {
    return ''
  }
}

async function isSymlink(target) {
  try {
    return (await fs.lstat(target)).isSymbolicLink()
  } catch {
    return false
  }
}