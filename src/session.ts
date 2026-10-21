import {
  chmodSync,
  closeSync,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { exportSession, restoreSession, type SavedSession, type Session } from './rivian-api.ts'

export const CONFIG_DIR = join(homedir(), '.rivian-mcp')
export const SESSION_FILE = join(CONFIG_DIR, 'session.json')
const SESSION_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000

// Open the file once and check permissions and read through the same descriptor,
// so the file cannot be swapped between the check and the read.
function readSessionFile(): SavedSession | null {
  let fd: number
  try {
    fd = openSync(SESSION_FILE, 'r')
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code !== 'ENOENT') console.error(`[rivian-mcp] Could not open session file: ${e.message}`)
    return null
  }

  try {
    if (fstatSync(fd).mode & 0o077) {
      console.error(
        `[rivian-mcp] WARNING: ${SESSION_FILE} is readable by other users. Run: chmod 600 "${SESSION_FILE}"`,
      )
    }
    return JSON.parse(readFileSync(fd, 'utf8'))
  } catch (err) {
    console.error(`[rivian-mcp] Could not read session file: ${(err as Error).message}`)
    return null
  } finally {
    closeSync(fd)
  }
}

export function loadSession(session: Session): boolean | 'needs_otp' {
  const saved = readSessionFile()
  if (!saved) return false

  if (saved.savedAt && Date.now() - saved.savedAt > SESSION_MAX_AGE_MS) {
    console.error('[rivian-mcp] Session expired. Please log in again.')
    return false
  }

  if (saved.authenticated || saved.needsOtp) {
    restoreSession(session, saved)
    return saved.authenticated ? true : 'needs_otp'
  }

  return false
}

export function saveSession(session: Session): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
  chmodSync(CONFIG_DIR, 0o700)
  const saved: SavedSession = { ...exportSession(session), savedAt: Date.now() }
  const fd = openSync(SESSION_FILE, 'w', 0o600)
  try {
    fchmodSync(fd, 0o600)
    writeFileSync(fd, JSON.stringify(saved, null, 2))
  } finally {
    closeSync(fd)
  }
}
