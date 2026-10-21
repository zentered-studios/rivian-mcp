import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, beforeEach, mock, test } from 'node:test'
import { emptySession } from '../src/rivian-api.ts'

// SESSION_FILE is resolved from the home directory at import time.
const home = mkdtempSync(join(tmpdir(), 'rivian-mcp-session-'))
process.env.HOME = home
const { loadSession, saveSession, SESSION_FILE } = await import('../src/session.ts')

after(() => rmSync(home, { recursive: true, force: true }))
beforeEach(() => rmSync(join(home, '.rivian-mcp'), { recursive: true, force: true }))
afterEach(() => mock.restoreAll())

test('missing session file loads nothing and logs nothing', () => {
  const error = mock.method(console, 'error', () => {})
  assert.equal(loadSession(emptySession()), false)
  assert.equal(error.mock.callCount(), 0)
})

test('saved session is written owner-only and restores on load', () => {
  saveSession({ ...emptySession(), accessToken: 'access', userSessionToken: 'user' })
  assert.equal(statSync(SESSION_FILE).mode & 0o777, 0o600)

  const session = emptySession()
  assert.equal(loadSession(session), true)
  assert.equal(session.accessToken, 'access')
  assert.equal(session.userSessionToken, 'user')
})

test('saving over a world-readable file tightens it to owner-only', () => {
  saveSession(emptySession())
  chmodSync(SESSION_FILE, 0o644)
  saveSession(emptySession())
  assert.equal(statSync(SESSION_FILE).mode & 0o777, 0o600)
})

test('world-readable session file warns but still loads', () => {
  saveSession({ ...emptySession(), accessToken: 'access' })
  chmodSync(SESSION_FILE, 0o644)
  const error = mock.method(console, 'error', () => {})
  assert.equal(loadSession(emptySession()), true)
  assert.match(String(error.mock.calls[0].arguments[0]), /readable by other users/)
})

test('pending OTP session restores as needs_otp', () => {
  saveSession({ ...emptySession(), otpToken: 'otp' })
  const session = emptySession()
  assert.equal(loadSession(session), 'needs_otp')
  assert.equal(session.otpToken, 'otp')
})

test('expired session is rejected', () => {
  saveSession({ ...emptySession(), accessToken: 'access' })
  writeFileSync(
    SESSION_FILE,
    JSON.stringify({ accessToken: 'access', authenticated: true, savedAt: 1 }),
  )
  mock.method(console, 'error', () => {})
  assert.equal(loadSession(emptySession()), false)
})

test('corrupt session file is rejected', () => {
  saveSession(emptySession())
  writeFileSync(SESSION_FILE, '{not json')
  const error = mock.method(console, 'error', () => {})
  assert.equal(loadSession(emptySession()), false)
  assert.match(String(error.mock.calls[0].arguments[0]), /Could not read session file/)
})
