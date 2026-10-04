// A local bearer token for the workbench's HTTP port.
//
// The port is fixed and loopback-only, which is not enough on its own: any
// process on the machine — including a web page you happen to have open, since
// browsers may issue cross-origin GETs to localhost — can talk to 127.0.0.1.
// The token is what makes "only this front-end" true. It is minted once, stored
// beside the entry with 0600, and reused across restarts so the browser's
// localStorage copy keeps working.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const FILE = '.meowui-token'
const BYTES = 32

// The entry dir is the installer's layout, ~/.meowcode/entries/<name>/, and the
// launcher passes it in rather than re-deriving it from process.argv[1]: one
// caller that knows where its own bundle landed beats a helper that guesses, and
// a token must never end up written into the session's workspace by mistake.
export function loadToken(entryDir) {
  const file = path.join(entryDir, FILE)
  try {
    const existing = fs.readFileSync(file, 'utf8').trim()
    if (existing.length >= 32) return { value: existing, created: false }
  } catch { /* no token yet */ }
  const value = crypto.randomBytes(BYTES).toString('base64url')
  return { value, created: true }
}

export function saveToken(entryDir, value) {
  const file = path.join(entryDir, FILE)
  try {
    // 0600 and O_EXCL-ish semantics don't matter for a file we own; the mode is
    // what does. Written via a temp file so a crash cannot leave a half token
    // that fails every request with a 401 nobody can explain.
    fs.writeFileSync(file + '.tmp', value, { mode: 0o600 })
    fs.renameSync(file + '.tmp', file)
    fs.chmodSync(file, 0o600)
  } catch (e) {
    process.stderr.write('[meowui] could not store the access token: ' + (e instanceof Error ? e.message : e) + '\n')
  }
}

// Timing-safe compare, so a wrong token cannot be discovered a byte at a time.
export function tokenMatches(expected, given) {
  if (typeof given !== 'string' || given.length !== expected.length) return false
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))
}