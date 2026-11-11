import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { afterEach, mock, test } from 'node:test'
import { emptySession, type Session } from '../../src/rivian-api.ts'
import './support/cloudflare-stub.ts'

// The Recorder extends a class from `cloudflare:workers`, which the stub provides.
const { Recorder } = await import('../src/recorder.ts')
type Recorder = InstanceType<typeof Recorder>

/** The members the tests reach into. They are private in the class. */
interface Internals {
  onMessage(ws: unknown, vehicles: unknown[], data: string): Promise<void>
  flush(vehicleId: string): Promise<void>
  onCharging(vehicleId: string, ts: number, rvm: string, payload: string): Promise<void>
  flushAll(): Promise<void>
  states: Map<string, { drive: { id: string; endedAt: number | null } | null }>
  alarm(): Promise<void>
  activate(session: Session, email: string): Promise<void>
  onClose(ws: unknown, code: number, reason: string): Promise<void>
  ws: unknown
}

const VEHICLE = { id: 'v', name: null, model: 'R1S', modelYear: 2025 }

class Gate {
  promise: Promise<void>
  open!: () => void
  /** Resolves when a batch has reached the gate. */
  reached = Promise.withResolvers<void>()
  constructor() {
    this.promise = new Promise((resolve) => {
      this.open = resolve
    })
  }
}

/** D1 on node:sqlite, with hooks to hold or fail a batch. */
function fakeD1() {
  const sqlite = new DatabaseSync(':memory:')
  const dir = join(import.meta.dirname, '../migrations')
  for (const f of readdirSync(dir).sort()) sqlite.exec(readFileSync(join(dir, f), 'utf8'))
  const hooks = { gate: null as Gate | null, failNext: false, batches: 0 }
  const statement = (sql: string, args: SQLInputValue[] = []) => ({
    bind: (...bound: SQLInputValue[]) => statement(sql, bound),
    run: async () => sqlite.prepare(sql).run(...args),
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    exec: () => sqlite.prepare(sql).run(...args),
  })
  const db = {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: ReturnType<typeof statement>[]) => {
      hooks.batches++
      if (hooks.gate) {
        hooks.gate.reached.resolve()
        await hooks.gate.promise
      }
      if (hooks.failNext) {
        hooks.failNext = false
        throw new Error('D1 unavailable')
      }
      sqlite.exec('BEGIN')
      try {
        for (const s of statements) s.exec()
        sqlite.exec('COMMIT')
      } catch (error) {
        sqlite.exec('ROLLBACK')
        throw error
      }
    },
  }
  return { db, sqlite, hooks }
}

function fakeStorage() {
  const data = new Map<string, unknown>()
  let alarm: number | null = null
  return {
    data,
    get: async (key: string) => structuredClone(data.get(key)),
    put: async (key: string, value: unknown) => void data.set(key, structuredClone(value)),
    delete: async (keys: string | string[]) => {
      for (const key of [keys].flat()) data.delete(key)
    },
    list: async ({ prefix }: { prefix: string }) =>
      new Map([...data].filter(([key]) => key.startsWith(prefix))),
    getAlarm: async () => alarm,
    setAlarm: async (at: number) => {
      alarm = at
    },
  }
}

async function setup(email: string | null = 'owner@example.com') {
  const { db, sqlite, hooks } = fakeD1()
  const storage = fakeStorage()
  await storage.put('session', { ...emptySession(), userSessionToken: 'token' })
  await storage.put('vehicles', [VEHICLE])
  const ctx = { storage, waitUntil: (p: Promise<unknown>) => void p.catch(() => {}) }
  const env = { DB: db, RIVIAN_EMAIL: email ?? undefined }
  const recorder = new Recorder(ctx as never, env as never)
  const internals = recorder as unknown as Internals
  const socket = { send() {}, close() {} }
  const send = (message: object) => {
    internals.ws = socket
    return internals.onMessage(socket, [VEHICLE], JSON.stringify(message))
  }
  const gps = (lat: number, ts: number) =>
    send({
      id: 'state:v',
      type: 'next',
      payload: {
        data: {
          vehicleState: {
            gnssLocation: {
              latitude: lat,
              longitude: 0,
              timeStamp: new Date(ts).toISOString(),
              isAuthorized: true,
            },
          },
        },
      },
    })
  const power = (payload: string, ts: number) =>
    send({
      id: 'v',
      type: 'next',
      payload: {
        data: { parallaxMessages: { payload, timestamp: ts, rvm: 'vehicle.power.state' } },
      },
    })
  return { recorder, internals, sqlite, hooks, storage, gps, power }
}

/** Parked at lat 0, then 0.001 degree (~111 m) north: opens drive `v-<startTs>`. */
async function openDrive(t: Awaited<ReturnType<typeof setup>>, parkTs: number, startTs: number) {
  await t.gps(0, parkTs)
  await t.gps(0.001, startTs)
}

const SLEEP = 'CAE='
const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  mock.restoreAll()
})

test('a replayed power sample older than the drive does not close it', async () => {
  const t = await setup()
  await openDrive(t, 1_000_000, 1_005_000)
  await t.gps(0.001, 1_010_000)
  await t.power(SLEEP, 1_000)
  assert.ok(t.internals.states.get('v')?.drive)
})

test('a power sample after the last move still closes the drive', async () => {
  const t = await setup()
  await openDrive(t, 1_000_000, 1_005_000)
  await t.power(SLEEP, 1_020_000)
  assert.equal(t.internals.states.get('v')?.drive, null)
})

test('a point that arrives while a drive closes waits and is not carried into a later drive', async () => {
  const t = await setup()
  await openDrive(t, 1_000, 6_000)
  const gate = new Gate()
  t.hooks.gate = gate
  const closing = t.power(SLEEP, 7_000)
  await gate.reached.promise
  let handled = false
  const moving = t.gps(0.002, 12_000).then(() => {
    handled = true
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(handled, false)
  t.hooks.gate = null
  gate.open()
  await Promise.all([closing, moving])
  await t.internals.flushAll()
  const rows = t.sqlite.prepare('SELECT drive_id, ts FROM points ORDER BY ts').all()
  assert.deepEqual(
    rows.map((r) => [r.drive_id, r.ts]),
    [
      ['v-6000', 6_000],
      ['v-12000', 12_000],
    ],
  )
})

test('points survive a rejected D1 batch', async () => {
  const t = await setup()
  await openDrive(t, 1_000, 6_000)
  t.hooks.failNext = true
  await assert.rejects(t.internals.flush('v'), /D1 unavailable/)
  await t.internals.flush('v')
  const rows = t.sqlite.prepare('SELECT ts FROM points').all()
  assert.deepEqual(
    rows.map((r) => r.ts),
    [6_000],
  )
})

test('an early watchdog alarm does not reconnect during a backoff', async () => {
  const t = await setup()
  let attempts = 0
  globalThis.fetch = (async () => {
    attempts++
    throw new Error('offline')
  }) as typeof fetch
  await t.internals.alarm()
  assert.equal(attempts, 1)
  await t.internals.alarm()
  assert.equal(attempts, 1)
})

test('a power-down close that fails to write is retried as a close', async () => {
  const t = await setup()
  await openDrive(t, 1_000, 6_000)
  t.hooks.failNext = true
  await assert.rejects(t.power(SLEEP, 7_000), /D1 unavailable/)
  // Inside the park grace period, so only the pending close can end the drive.
  mock.method(Date, 'now', () => 8_000)
  ;(t.recorder as unknown as { ws: object }).ws = {}
  await t.internals.alarm()
  const row = t.sqlite.prepare('SELECT ended_at FROM drives WHERE id = ?').get('v-6000')
  assert.equal(row?.ended_at, 6_000)
})

test('a point after a failed close ends the old drive before it opens a new one', async () => {
  const t = await setup()
  await openDrive(t, 1_000, 6_000)
  t.hooks.failNext = true
  await assert.rejects(t.power(SLEEP, 7_000), /D1 unavailable/)
  await t.gps(0.002, 12_000)
  const ended = t.sqlite.prepare('SELECT ended_at FROM drives WHERE id = ?').get('v-6000')
  assert.equal(ended?.ended_at, 6_000)
  assert.equal(t.internals.states.get('v')?.drive?.id, 'v-12000')
})

/** Rivian accepts every code. Anything after sign-in fails, which `activate` records as `lastError`. */
function acceptCodes() {
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    if (!String(init?.body).includes('LoginWithOTP')) throw new Error('offline')
    const tokens = {
      __typename: 'MobileLoginResponse',
      accessToken: 'a',
      refreshToken: 'r',
      userSessionToken: 'u',
    }
    return new Response(JSON.stringify({ data: { loginWithOTP: tokens } }))
  }) as typeof fetch
}

const BINDING = 'b'.repeat(64)
const REDIRECT = 'https://claude.ai/callback?code=c'

const pendingLogin = (email: string) => ({
  session: { ...emptySession(), otpToken: 'otp' },
  email,
  createdAt: Date.now(),
  oauth: { request: { clientId: 'c' }, origin: 'https://worker.test', binding: BINDING },
})

/** Tests have no OAuth KV, so authorization completion returns a fixed redirect. */
function withCompletion<R extends Recorder>(recorder: R): R {
  ;(recorder as unknown as { completeSignIn: () => Promise<string> }).completeSignIn = async () =>
    REDIRECT
  return recorder
}

const signIn = (recorder: Recorder, pendingId: string) =>
  withCompletion(recorder).finishPendingLogin(pendingId, BINDING, '123456')

test('the first sign-in claims the worker and a different account is then refused', async () => {
  acceptCodes()
  const t = await setup(null)
  await t.storage.put('session', emptySession())
  await t.storage.put('pending:a', pendingLogin('First@Example.com'))
  await t.storage.put('pending:b', pendingLogin('other@example.com'))
  assert.equal(await t.recorder.ownerEmail(), null)
  assert.deepEqual(await signIn(t.recorder, 'a'), { result: 'done', redirectTo: REDIRECT })
  assert.equal(await t.recorder.ownerEmail(), 'first@example.com')
  const claimed = await t.storage.get('session')

  const restarted = new Recorder(
    { storage: t.storage, waitUntil() {} } as never,
    { DB: {}, RIVIAN_EMAIL: undefined } as never,
  )
  await assert.rejects(signIn(restarted, 'b'), /different Rivian account/)
  assert.equal(await restarted.ownerEmail(), 'first@example.com')
  assert.deepEqual(await t.storage.get('session'), claimed)
  assert.equal(((await t.storage.get('session')) as Session).userSessionToken, 'u')
})

test('two posts of one code reach Rivian once and get the same redirect', async () => {
  acceptCodes()
  const accept = globalThis.fetch
  let otpCalls = 0
  globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
    if (String(init?.body).includes('LoginWithOTP')) otpCalls++
    return accept(url as string, init as RequestInit)
  }) as typeof fetch
  const t = await setup('owner@example.com')
  await t.storage.put('pending:a', pendingLogin('owner@example.com'))
  const done = { result: 'done', redirectTo: REDIRECT }
  assert.deepEqual(await Promise.all([signIn(t.recorder, 'a'), signIn(t.recorder, 'a')]), [
    done,
    done,
  ])
  assert.equal(otpCalls, 1)
  // A post that arrives after the check finished gets the stored redirect.
  assert.deepEqual(await signIn(t.recorder, 'a'), done)
  assert.equal(otpCalls, 1)
  assert.equal(((await t.storage.get('session')) as Session).userSessionToken, 'u')
})

test('a configured RIVIAN_EMAIL refuses another account before it claims', async () => {
  acceptCodes()
  const t = await setup('owner@example.com')
  await t.storage.put('pending:b', pendingLogin('other@example.com'))
  await assert.rejects(signIn(t.recorder, 'b'), /different Rivian account/)
  assert.equal(t.storage.data.has('owner'), false)
  assert.equal(((await t.storage.get('session')) as Session).userSessionToken, 'token')
})

test('the owner stays after RIVIAN_EMAIL is removed', async () => {
  acceptCodes()
  const t = await setup('Owner@Example.com')
  await t.storage.put('pending:a', pendingLogin('owner@example.com'))
  await signIn(t.recorder, 'a')
  const restarted = new Recorder(
    { storage: t.storage, waitUntil() {} } as never,
    { DB: {}, RIVIAN_EMAIL: undefined } as never,
  )
  assert.equal(await restarted.ownerEmail(), 'owner@example.com')
})

test('a charging sample retries after its D1 write fails', async () => {
  let attempts = 0
  const db = {
    prepare: () => ({
      bind: () => ({
        run: async () => {
          if (++attempts === 1) throw new Error('D1 unavailable')
        },
      }),
    }),
  }
  const recorder = new Recorder({} as never, { DB: db } as never) as unknown as Internals
  const write = () => recorder.onCharging('v', 1_000, 'charging.session.status', 'CAE=')
  await assert.rejects(write(), /D1 unavailable/)
  await write()
  assert.equal(attempts, 2)
  await write()
  assert.equal(attempts, 2, 'only a successful write advances the sampling watermark')
})

test('a restored drive ignores GPS replay older than its persisted progress', async () => {
  const t = await setup()
  await openDrive(t, 1_000, 6_000)
  await t.gps(0.002, 11_000)
  // Movement updates can be newer than the most recent stored route point.
  await t.gps(0.003, 13_000)
  await t.internals.flush('v')
  const before = await t.storage.get('drive:v')
  const restarted = new Recorder(
    { storage: t.storage, waitUntil() {} } as never,
    { DB: {} } as never,
  ) as unknown as Internals
  const socket = { send() {} }
  restarted.ws = socket
  await restarted.onMessage(
    socket,
    [VEHICLE],
    JSON.stringify({
      id: 'state:v',
      type: 'next',
      payload: {
        data: {
          vehicleState: {
            gnssLocation: {
              latitude: 0,
              longitude: 0,
              timeStamp: new Date(12_000).toISOString(),
            },
          },
        },
      },
    }),
  )
  assert.deepEqual(restarted.states.get('v')?.drive, before)
})

test('an old socket auth rejection cannot erase a freshly accepted login', async () => {
  const t = await setup()
  const oldSocket = { close() {} }
  t.internals.ws = oldSocket
  const discovery = new Gate()
  globalThis.fetch = (async () => {
    discovery.reached.resolve()
    await discovery.promise
    throw new Error('discovery offline')
  }) as typeof fetch
  const login = t.internals.activate(
    { ...emptySession(), userSessionToken: 'fresh-token' },
    'owner@example.com',
  )
  await discovery.reached.promise
  const closed = t.internals.onClose(oldSocket, 4401, 'Expired')
  discovery.open()
  await Promise.all([login, closed])
  assert.equal(((await t.storage.get('session')) as Session).userSessionToken, 'fresh-token')
  assert.equal(t.internals.ws, null)
})

test('the watchdog waits for an in-progress session activation', async () => {
  const t = await setup()
  const discovery = new Gate()
  let requests = 0
  globalThis.fetch = (async () => {
    requests++
    discovery.reached.resolve()
    await discovery.promise
    throw new Error('discovery offline')
  }) as typeof fetch
  const login = t.internals.activate(
    { ...emptySession(), userSessionToken: 'fresh-token' },
    'owner@example.com',
  )
  await discovery.reached.promise
  const alarm = t.internals.alarm()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(requests, 1, 'the watchdog must not open a competing socket')
  discovery.open()
  await Promise.all([login, alarm])
})

test('messages queued from a replaced socket do not affect the current connection', async () => {
  const t = await setup()
  t.internals.ws = { send() {} }
  await t.internals.onMessage(
    { send() {} },
    [VEHICLE],
    JSON.stringify({
      id: 'v',
      type: 'error',
      payload: { message: 'Old subscription rejected' },
    }),
  )
  assert.equal((await t.recorder.status()).lastError, null)
})
