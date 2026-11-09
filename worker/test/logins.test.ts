import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AuthRequest } from '@cloudflare/workers-oauth-provider'
import { emptySession, type Session } from '../../src/rivian-api.ts'
import {
  finishPending,
  type LoginDeps,
  needsVehicleDiscovery,
  ownerEmail,
  type RecoveryDeps,
  recoverConnection,
  sameEmail,
  startPending,
} from '../src/logins.ts'
import {
  PENDING_PREFIX,
  PENDING_TTL_MS,
  type PendingAuthorization,
  type PendingLogin,
} from '../src/pending.ts'

const BINDING = 'b'.repeat(64)
const OAUTH: PendingAuthorization = {
  request: { clientId: 'c' } as AuthRequest,
  origin: 'https://worker.test',
  binding: BINDING,
}

/** Fake Rivian: each login gets a distinct otpToken; a code is right only for its own token. */
function setup() {
  const pending = new Map<string, PendingLogin>()
  const active: { session: Session | null; email: string | null; writes: Session[] } = {
    session: null,
    email: null,
    writes: [],
  }
  const counts = { validations: 0, completions: 0 }
  let n = 0
  const deps: LoginDeps = {
    store: {
      get: async (key) => pending.get(key),
      put: async (key, value) => void pending.set(key, value),
      delete: async (keys) => {
        for (const k of [keys].flat()) pending.delete(k)
      },
      list: async (prefix) =>
        new Map([...pending].filter(([k]) => k.startsWith(prefix))) as Map<string, PendingLogin>,
    },
    login: async (session, _email, password) => {
      if (password === 'direct') {
        session.userSessionToken = 'direct-token'
        return false
      }
      session.otpToken = `otp-${password}`
      return true
    },
    validateOtp: async (session, _email, code) => {
      counts.validations++
      if (code !== `code-for-${session.otpToken}`) throw new Error('bad code')
      session.userSessionToken = `user-${session.otpToken}`
      session.otpToken = ''
    },
    activate: async (session, email) => {
      active.session = session
      active.email = email
      active.writes.push(session)
    },
    complete: async (oauth) => {
      counts.completions++
      return `https://claude.ai/callback?client=${oauth.request.clientId}&n=${counts.completions}`
    },
    newSession: emptySession,
    now: () => 1000,
    newId: () => `id${++n}`,
    inFlight: new Map(),
  }
  const start = (password: string) => startPending(deps, 'me@example.com', password, OAUTH)
  const finish = (id: string, code: string, binding = BINDING) =>
    finishPending(deps, id, binding, code)
  return { deps, pending, active, counts, start, finish }
}

/** Holds every Rivian code check until the returned function runs. */
function holdValidation(deps: LoginDeps) {
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const original = deps.validateOtp
  deps.validateOtp = async (session, email, code) => {
    await gate
    return original(session, email, code)
  }
  return () => release()
}

const FIRST_REDIRECT = 'https://claude.ai/callback?client=c&n=1'
const DONE = { result: 'done', redirectTo: FIRST_REDIRECT }
const OTHER_BROWSER = 'x'.repeat(64)

test('starting overlapping sign-ins never writes the active session', async () => {
  const { pending, active, start } = setup()
  const a = await start('a')
  const b = await start('b')
  assert.deepEqual(
    [a, b],
    [
      { result: 'otp_sent', pendingId: 'id1' },
      { result: 'otp_sent', pendingId: 'id2' },
    ],
  )
  assert.equal(active.writes.length, 0)
  assert.equal(pending.size, 2)
  assert.deepEqual(pending.get(`${PENDING_PREFIX}id1`)?.oauth, OAUTH)
})

test('a wrong code keeps the pending session and writes nothing', async () => {
  const { pending, active, counts, start, finish } = setup()
  await start('a')
  await assert.rejects(finish('id1', 'nope'), /bad code/)
  assert.equal(active.writes.length, 0)
  assert.equal(counts.completions, 0)
  assert.ok(pending.has(`${PENDING_PREFIX}id1`))
  // The same sign-in accepts the right code afterwards.
  assert.deepEqual(await finish('id1', 'code-for-otp-a'), DONE)
})

test('a right code activates its own session and completes the authorization', async () => {
  const { pending, active, counts, start, finish } = setup()
  await start('a')
  await start('b')
  assert.deepEqual(await finish('id1', 'code-for-otp-a'), DONE)
  assert.equal(active.writes.length, 1)
  assert.equal(active.session?.userSessionToken, 'user-otp-a')
  assert.equal(counts.completions, 1)
  // The finished entry keeps the redirect, not the Rivian credentials.
  const done = pending.get(`${PENDING_PREFIX}id1`)
  assert.equal(done?.redirectTo, FIRST_REDIRECT)
  assert.equal(done?.session.userSessionToken, '')
  // The first sign-in's code does not work for the second.
  await assert.rejects(finish('id2', 'code-for-otp-a'), /bad code/)
  assert.equal(active.writes.length, 1)
})

test('a repeated post after success gets the same redirect without a second check', async () => {
  const { active, counts, start, finish } = setup()
  await start('a')
  await finish('id1', 'code-for-otp-a')
  assert.deepEqual(await finish('id1', 'code-for-otp-a'), DONE)
  assert.deepEqual(counts, { validations: 1, completions: 1 })
  assert.equal(active.writes.length, 1)
})

test('two posts of one code share a single check and get the same redirect', async () => {
  const { deps, active, counts, start, finish } = setup()
  await start('a')
  const release = holdValidation(deps)
  // Safari's autofill submit, then the second submit that drops the first request.
  const first = finish('id1', 'code-for-otp-a')
  const second = finish('id1', 'code-for-otp-a')
  release()
  assert.deepEqual(await Promise.all([first, second]), [DONE, DONE])
  assert.deepEqual(counts, { validations: 1, completions: 1 })
  assert.equal(active.writes.length, 1)
  assert.equal(deps.inFlight.size, 0)
})

test('a different code while one is checked is refused', async () => {
  const { deps, start, finish } = setup()
  await start('a')
  const release = holdValidation(deps)
  const first = finish('id1', 'code-for-otp-a')
  await assert.rejects(finish('id1', '999999'), /Another code is being checked/)
  release()
  assert.deepEqual(await first, DONE)
})

test('a post from another browser is refused, during and after a check', async () => {
  const { deps, pending, active, counts, start, finish } = setup()
  await start('a')
  const release = holdValidation(deps)
  const first = finish('id1', 'code-for-otp-a')
  assert.deepEqual(await finish('id1', 'code-for-otp-a', OTHER_BROWSER), { result: 'expired' })
  release()
  await first
  assert.deepEqual(await finish('id1', 'code-for-otp-a', OTHER_BROWSER), { result: 'expired' })
  assert.deepEqual(counts, { validations: 1, completions: 1 })
  assert.equal(active.writes.length, 1)
  assert.ok(pending.has(`${PENDING_PREFIX}id1`))
})

test('a wrong binding never reaches Rivian', async () => {
  const { active, counts, start, finish } = setup()
  await start('a')
  assert.deepEqual(await finish('id1', 'code-for-otp-a', OTHER_BROWSER), { result: 'expired' })
  assert.equal(counts.validations, 0)
  assert.equal(active.writes.length, 0)
})

test('an unknown or expired pending id is rejected and removed', async () => {
  const { deps, pending, counts, start, finish } = setup()
  assert.deepEqual(await finish('missing', 'code-for-otp-a'), { result: 'expired' })
  await start('a')
  deps.now = () => 1000 + PENDING_TTL_MS
  assert.deepEqual(await finish('id1', 'code-for-otp-a'), { result: 'expired' })
  assert.equal(pending.size, 0)
  assert.equal(counts.validations, 0)
})

test('a pending entry stored before the sign-in request was kept expires', async () => {
  const { pending, active, counts, finish } = setup()
  pending.set(`${PENDING_PREFIX}old`, {
    session: { ...emptySession(), otpToken: 'otp-a' },
    email: 'me@example.com',
    createdAt: 1000,
  })
  assert.deepEqual(await finish('old', 'code-for-otp-a'), { result: 'expired' })
  assert.equal(pending.size, 0)
  assert.equal(counts.validations, 0)
  assert.equal(active.writes.length, 0)
})

test('a password login without OTP activates directly', async () => {
  const { active, start } = setup()
  assert.deepEqual(await start('direct'), { result: 'logged_in' })
  assert.equal(active.session?.userSessionToken, 'direct-token')
})

test('the email typed at sign-in reaches the code check and activation', async () => {
  const { deps, active, start, finish } = setup()
  const checked: string[] = []
  const original = deps.validateOtp
  deps.validateOtp = async (session, email, code) => {
    checked.push(email)
    return original(session, email, code)
  }
  await start('a')
  await finish('id1', 'code-for-otp-a')
  assert.deepEqual(checked, ['me@example.com'])
  assert.equal(active.email, 'me@example.com')
})

test('a refused activation leaves no pending entry and issues no code', async () => {
  const { deps, pending, counts, start, finish } = setup()
  deps.activate = async () => {
    throw new Error('This server records a different Rivian account.')
  }
  await start('a')
  await assert.rejects(finish('id1', 'code-for-otp-a'), /different Rivian account/)
  assert.equal(pending.size, 0)
  assert.equal(counts.completions, 0)
})

test('the owner is RIVIAN_EMAIL when set, else the claimed email, else nobody', () => {
  assert.equal(ownerEmail(' Set@Example.com ', 'claimed@example.com'), 'Set@Example.com')
  assert.equal(ownerEmail(undefined, 'claimed@example.com'), 'claimed@example.com')
  assert.equal(ownerEmail('', 'claimed@example.com'), 'claimed@example.com')
  assert.equal(ownerEmail(undefined, undefined), null)
})

test('emails match ignoring case and surrounding spaces', () => {
  assert.equal(sameEmail(' Me@Example.com ', 'me@example.com'), true)
  assert.equal(sameEmail('me@example.com', 'you@example.com'), false)
})

test('vehicle discovery retries only for a signed-in session with no vehicles', () => {
  const signedIn = { ...emptySession(), userSessionToken: 't' }
  assert.equal(needsVehicleDiscovery(signedIn, 0), true)
  assert.equal(needsVehicleDiscovery(signedIn, 1), false)
  assert.equal(needsVehicleDiscovery(emptySession(), 0), false)
})

function recovery(opts: { failures: number; socket?: boolean }) {
  const calls = { discover: 0, open: 0, fail: 0, clear: 0 }
  let vehicles = 0
  let failures = opts.failures
  const deps: RecoveryDeps = {
    session: async () => ({ ...emptySession(), userSessionToken: 't' }),
    storedVehicleCount: async () => vehicles,
    discoverVehicles: async () => {
      calls.discover++
      if (failures-- > 0) throw new Error('503')
      vehicles = 1
    },
    hasSocket: () => opts.socket ?? false,
    openSocket: async () => void calls.open++,
    clearError: () => void calls.clear++,
    fail: async () => void calls.fail++,
  }
  return { deps, calls }
}

test('recovery: a failed discovery schedules a retry and skips the socket', async () => {
  const { deps, calls } = recovery({ failures: 2 })
  await recoverConnection(deps)
  assert.deepEqual(calls, { discover: 1, open: 0, fail: 1, clear: 0 })
  await recoverConnection(deps)
  assert.deepEqual(calls, { discover: 2, open: 0, fail: 2, clear: 0 })
})

test('recovery: a later alarm stores vehicles, clears the error and opens the socket', async () => {
  const { deps, calls } = recovery({ failures: 1 })
  await recoverConnection(deps)
  await recoverConnection(deps)
  assert.deepEqual(calls, { discover: 2, open: 1, fail: 1, clear: 1 })
  // Vehicles are stored now: no more discovery.
  await recoverConnection(deps)
  assert.equal(calls.discover, 2)
})

test('recovery: an open socket is left alone', async () => {
  const { deps, calls } = recovery({ failures: 0, socket: true })
  await recoverConnection(deps)
  assert.equal(calls.open, 0)
})
