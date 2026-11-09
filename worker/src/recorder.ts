// Recorder: one Durable Object that holds the Rivian websocket and records drives to D1.
// The open websocket keeps the object in memory; a 60 s alarm reconnects it after
// evictions, deploys and errors.

import { DurableObject } from 'cloudflare:workers'
import {
  APOLLO_CLIENT_NAME,
  createCsrfToken,
  emptySession,
  getVehicles,
  login,
  type Session,
  type Vehicle,
  validateOtp,
} from '../../src/rivian-api.ts'
import { type LastSample, shouldSample } from './charging.ts'
import {
  close,
  type Drive,
  isOlderPoint,
  onPoint,
  type Point,
  parkedAfterGap,
  shouldClose,
} from './drive.ts'
import {
  type CodeCheck,
  type FinishResult,
  finishPending,
  type LoginDeps,
  ownerEmail,
  recoverConnection,
  type StartResult,
  sameEmail,
  startPending,
} from './logins.ts'
import {
  CHARGING_RVMS,
  decodeCharging,
  decodeGnss,
  decodeOdometerKm,
  decodePowerState,
  type PowerState,
  RVM_GNSS,
  RVM_ODOMETER,
  RVM_POWER,
  RVMS,
} from './parallax.ts'
import type { PendingAuthorization, PendingLogin } from './pending.ts'
import { completeSignIn } from './provider.ts'
import {
  pointFromVehicleState,
  STATE_ID_PREFIX,
  VEHICLE_STATE_SUBSCRIPTION,
  type VehicleStateData,
} from './vehicle-state.ts'

const WS_URL = 'https://api.rivian.com/gql-consumer-subscriptions/graphql'
const WATCHDOG_MS = 60_000
/** Rivian closes every connection after ~3 minutes with this code. */
const CLOSE_TTL_EXPIRED = 4420
const CLOSE_AUTH = [4401, 4403]
const RECONNECT_MS = 2_000
const BACKOFF_MIN_MS = 10_000
const BACKOFF_MAX_MS = 15 * 60_000
/** Flush buffered points to D1 after this many (one minute at the 5 s interval). */
const FLUSH_POINTS = 12

const PARALLAX_SUBSCRIPTION = `subscription ParallaxMessages($vehicleId: String!, $rvms: [String!]) {
  parallaxMessages(vehicleId: $vehicleId, rvms: $rvms) { payload timestamp rvm }
}`

interface VehicleState {
  drive: Drive | null
  /** The closed form of `drive` while its write is pending, so a retry closes instead of flushing it open. */
  closing: Drive | null
  /** Where the vehicle parked: first point while parked, or the end of the last drive. Not persisted: after an eviction the next point replaces it. */
  parkedAt: Point | null
  /** Latest GPS point. Not persisted. */
  lastPoint: Point | null
  power: PowerState | null
  /** Timestamp of the latest power sample, so a replayed older one cannot replace it. */
  powerAt: number
  odometerKm: number | null
}

export interface RecorderStatus {
  loggedIn: boolean
  connected: boolean
  vehicles: Vehicle[]
  openDrives: { vehicleId: string; startedAt: number; distanceM: number }[]
  lastMessageAt: number | null
  lastError: string | null
}

export class Recorder extends DurableObject<Env> {
  private ws: WebSocket | null = null
  private states = new Map<string, VehicleState>()
  private buffer = new Map<string, Point[]>()
  /** Last stored charging sample per `${vehicleId} ${rvm}`. Lost on eviction, which only adds a row. */
  private lastSamples = new Map<string, LastSample>()
  private backoffMs = 0
  /** No reconnect before this time. The 60 s watchdog alarm still runs, to flush points. */
  private retryAt = 0
  private lastMessageAt: number | null = null
  private lastError: string | null = null

  /**
   * OAuth sign-in. The typed password logs in to a separate session; the recording session is
   * replaced only once Rivian accepts it, so abandoned or overlapping sign-ins change nothing.
   * Returns a `pendingId` for `finishPendingLogin` when Rivian wants a code. `oauth` is kept with
   * the pending login, so the code step can complete the authorization here.
   */
  async startPendingLogin(
    email: string,
    password: string,
    oauth: PendingAuthorization,
  ): Promise<StartResult> {
    return startPending(this.loginDeps(), email, password, oauth)
  }

  /**
   * Verifies the code against the pending session, makes it the recording session and issues the
   * authorization code. Repeated submissions share one check and get the same redirect.
   * A wrong code throws and keeps the pending session for another try. A startup failure after a
   * valid code does not throw: the login is done, the alarm retries, and `status().lastError`
   * shows the failure. The check runs here, not in the Worker request, so it finishes even when
   * the browser drops the request that started it.
   */
  async finishPendingLogin(
    pendingId: string,
    binding: string,
    code: string,
  ): Promise<FinishResult> {
    return finishPending(this.loginDeps(), pendingId, binding, code)
  }

  /** See `ownerEmail` in logins.ts. */
  async ownerEmail(): Promise<string | null> {
    return ownerEmail(this.env.RIVIAN_EMAIL, await this.ctx.storage.get<string>('owner'))
  }

  private readonly pendingInFlight = new Map<string, CodeCheck>()
  /** Replaced in tests, which have no OAuth KV. */
  private completeSignIn = (oauth: PendingAuthorization) =>
    completeSignIn(this.env, oauth.origin, oauth.request)

  private loginDeps(): LoginDeps {
    const storage = this.ctx.storage
    return {
      store: {
        get: (key) => storage.get<PendingLogin>(key),
        put: (key, value) => storage.put(key, value),
        delete: (keys) => storage.delete(keys as string[]),
        list: (prefix) => storage.list<PendingLogin>({ prefix }),
      },
      login: async (session, email, password) => {
        await createCsrfToken(session)
        return (await login(session, email, password)).mfa
      },
      validateOtp,
      activate: (session, email) => this.activate(session, email),
      complete: (oauth) => this.completeSignIn(oauth),
      newSession: emptySession,
      now: Date.now,
      newId: () => crypto.randomUUID(),
      inFlight: this.pendingInFlight,
    }
  }

  /**
   * Stores a verified session and starts recording. Startup errors go to `lastError`.
   * With no owner yet, this sign-in claims the Worker. The owner is stored on every sign-in, so
   * removing `RIVIAN_EMAIL` later keeps the account. Activation shares the socket/alarm queue,
   * so reconnects and another accepted login cannot overlap discovery or socket replacement.
   */
  private activate(session: Session, email: string): Promise<void> {
    return this.serialize(() => this.activateSession(session, email))
  }

  private async activateSession(session: Session, email: string): Promise<void> {
    const owner = await this.ownerEmail()
    if (owner && !sameEmail(owner, email)) {
      throw new Error('This server records a different Rivian account.')
    }
    // Retire the previous socket before storing fresh credentials. Its late auth rejection
    // must not clear this session, even if vehicle discovery fails and no new socket opens.
    const previous = this.ws
    this.ws = null
    previous?.close(1000, 'Re-login')
    await this.ctx.storage.put('owner', email.trim().toLowerCase())
    await this.ctx.storage.put('session', session)
    try {
      await this.afterLogin(session)
    } catch (error) {
      await this.fail(error)
    }
  }

  /** The recording session and vehicles, for the live query tools. Throws when signed out. */
  async rivianSession(): Promise<{ session: Session; vehicles: Vehicle[] }> {
    const session = await this.session()
    if (!session.userSessionToken) {
      throw new Error('Not signed in to Rivian. Reconnect the Rivian connector to sign in again.')
    }
    return { session, vehicles: await this.vehicles() }
  }

  async status(): Promise<RecorderStatus> {
    const session = await this.session()
    await this.loadStates()
    return {
      loggedIn: Boolean(session.userSessionToken),
      connected: this.ws?.readyState === WebSocket.OPEN,
      vehicles: await this.vehicles(),
      openDrives: [...this.states.entries()].flatMap(([vehicleId, s]) =>
        s.drive ? [{ vehicleId, startedAt: s.drive.startedAt, distanceM: s.drive.distanceM }] : [],
      ),
      lastMessageAt: this.lastMessageAt,
      lastError: this.lastError,
    }
  }

  /** Watchdog: closes stale drives, flushes points and reconnects when needed. */
  alarm(): Promise<void> {
    return this.serialize(() => this.watchdog())
  }

  private async watchdog(): Promise<void> {
    await this.loadStates()
    const now = Date.now()
    try {
      for (const [vehicleId, state] of this.states) {
        if (state.closing || (state.drive && shouldClose(state.drive, now, null))) {
          await this.finishDrive(vehicleId)
        }
      }
      await this.flushAll()
    } catch (error) {
      // The points stay buffered; the next watchdog alarm writes them again.
      await this.fail(error)
    }
    // During a backoff only the flush above runs.
    if (Date.now() >= this.retryAt) await this.reconnect()
    await this.scheduleAlarm()
  }

  private reconnect(): Promise<void> {
    return recoverConnection({
      session: () => this.session(),
      storedVehicleCount: async () => (await this.vehicles()).length,
      discoverVehicles: async (session) => {
        await this.ctx.storage.put('vehicles', await getVehicles(session))
      },
      hasSocket: () => this.ws !== null,
      openSocket: () => this.openSocket(),
      clearError: () => {
        this.lastError = null
      },
      fail: (error) => this.fail(error),
    })
  }

  private async afterLogin(session: Session): Promise<Vehicle[]> {
    const vehicles = await getVehicles(session)
    await this.ctx.storage.put('vehicles', vehicles)
    this.lastError = null
    this.backoffMs = 0
    this.retryAt = 0
    await this.openSocket()
    await this.scheduleAlarm()
    return vehicles
  }

  private async session(): Promise<Session> {
    return (await this.ctx.storage.get<Session>('session')) ?? emptySession()
  }

  private async vehicles(): Promise<Vehicle[]> {
    return (await this.ctx.storage.get<Vehicle[]>('vehicles')) ?? []
  }

  private async scheduleAlarm(ms = WATCHDOG_MS): Promise<void> {
    const at = Date.now() + ms
    const current = await this.ctx.storage.getAlarm()
    if (current === null || current > at) await this.ctx.storage.setAlarm(at)
  }

  private async openSocket(): Promise<void> {
    const session = await this.session()
    const vehicles = await this.vehicles()
    if (!session.userSessionToken || vehicles.length === 0) return

    let ws: WebSocket
    try {
      const res = await fetch(WS_URL, {
        headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': 'graphql-transport-ws' },
      })
      if (!res.webSocket) throw new Error(`Websocket upgrade failed: HTTP ${res.status}`)
      ws = res.webSocket
    } catch (error) {
      await this.fail(error)
      return
    }
    ws.accept()
    this.ws = ws

    ws.addEventListener('message', (event) => {
      this.ctx.waitUntil(this.onMessage(ws, vehicles, String(event.data)))
    })
    ws.addEventListener('close', (event) => {
      this.ctx.waitUntil(this.onClose(ws, event.code, event.reason))
    })
    ws.addEventListener('error', () => {
      this.ctx.waitUntil(this.onClose(ws, 1006, 'Websocket error'))
    })
    ws.send(
      JSON.stringify({
        type: 'connection_init',
        payload: {
          'client-name': APOLLO_CLIENT_NAME,
          'client-version': '1.13.0-1494',
          'dc-cid': `m-ios-${crypto.randomUUID()}`,
          'u-sess': session.userSessionToken,
        },
      }),
    )
  }

  private queue: Promise<unknown> = Promise.resolve()

  /**
   * Runs tasks one at a time. A task that awaits D1, such as closing a drive, must not
   * interleave with the next GPS point or the alarm, which would change the drive under it.
   */
  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task)
    this.queue = run.catch(() => {})
    return run
  }

  private onMessage(ws: WebSocket, vehicles: Vehicle[], data: string): Promise<void> {
    return this.serialize(() => this.handleMessage(ws, vehicles, data))
  }

  private async handleMessage(ws: WebSocket, vehicles: Vehicle[], data: string): Promise<void> {
    if (this.ws !== ws) return
    const message = JSON.parse(data) as {
      id?: string
      type: string
      payload?: {
        data?: {
          parallaxMessages?: { payload: string; timestamp: string | number; rvm: string }
          vehicleState?: VehicleStateData
        }
      }
    }
    if (message.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }))
    } else if (message.type === 'connection_ack') {
      this.backoffMs = 0
      this.retryAt = 0
      for (const vehicle of vehicles) {
        ws.send(
          JSON.stringify({
            id: vehicle.id,
            type: 'subscribe',
            payload: {
              operationName: 'ParallaxMessages',
              query: PARALLAX_SUBSCRIPTION,
              variables: { vehicleId: vehicle.id, rvms: RVMS },
            },
          }),
        )
        // GPS every 3-7 s, against about once a minute from parallax GNSS.
        ws.send(
          JSON.stringify({
            id: `${STATE_ID_PREFIX}${vehicle.id}`,
            type: 'subscribe',
            payload: {
              operationName: 'VehicleState',
              query: VEHICLE_STATE_SUBSCRIPTION,
              variables: { vehicleID: vehicle.id },
            },
          }),
        )
      }
    } else if (message.type === 'next' && message.id?.startsWith(STATE_ID_PREFIX)) {
      await this.onVehicleState(
        message.id.slice(STATE_ID_PREFIX.length),
        message.payload?.data?.vehicleState,
      )
    } else if (message.type === 'next' && message.id) {
      const parallax = message.payload?.data?.parallaxMessages
      if (parallax) await this.onParallax(message.id, parallax)
    } else if (message.type === 'error') {
      this.lastError = `Subscription error (${message.id}): ${JSON.stringify(message.payload).slice(0, 300)}`
    }
  }

  private async onParallax(
    vehicleId: string,
    msg: { payload: string; timestamp: string | number; rvm: string },
  ): Promise<void> {
    await this.loadStates()
    const ts = Number(msg.timestamp)
    // Receive time, not the vehicle's timestamp: Rivian replays old values on subscribe.
    this.lastMessageAt = Date.now()
    const state = this.state(vehicleId)

    if (CHARGING_RVMS.includes(msg.rvm)) {
      await this.onCharging(vehicleId, ts, msg.rvm, msg.payload)
    } else if (msg.rvm === RVM_POWER) {
      // Rivian replays old samples on subscribe: one from before the drive's last move says
      // nothing about the drive now.
      if (ts < state.powerAt) return
      state.powerAt = ts
      state.power = decodePowerState(msg.payload)
      if (
        state.drive &&
        ts >= state.drive.lastMovingAt &&
        shouldClose(state.drive, ts, state.power)
      )
        await this.finishDrive(vehicleId)
    } else if (msg.rvm === RVM_ODOMETER) {
      state.odometerKm = decodeOdometerKm(msg.payload) ?? state.odometerKm
    } else if (msg.rvm === RVM_GNSS) {
      const gnss = decodeGnss(msg.payload)
      if (gnss) await this.onPoint(vehicleId, { ...gnss, ts })
    }
  }

  private async onVehicleState(
    vehicleId: string,
    data: VehicleStateData | undefined,
  ): Promise<void> {
    await this.loadStates()
    this.lastMessageAt = Date.now()
    const point = pointFromVehicleState(data)
    if (point) await this.onPoint(vehicleId, point)
  }

  /** One GPS point from either source. Older points, such as replays on subscribe, are dropped. */
  private async onPoint(vehicleId: string, point: Point): Promise<void> {
    const state = this.state(vehicleId)
    if (isOlderPoint(state.lastPoint, point)) return
    // The in-memory point is lost on eviction, but the persisted drive still provides a
    // watermark. Replays must not move its last-moving position or distance backwards.
    if (state.drive && point.ts < Math.max(state.drive.lastStoredAt, state.drive.lastMovingAt))
      return
    if (state.closing || (state.drive && shouldClose(state.drive, point.ts, null))) {
      await this.finishDrive(vehicleId)
    }
    const { drive, parkedAt, stored } = onPoint(
      state.drive,
      parkedAfterGap(state.parkedAt, state.lastPoint, point),
      vehicleId,
      point,
      state.odometerKm,
    )
    state.drive = drive
    state.parkedAt = parkedAt
    state.lastPoint = point
    if (stored) {
      const points = this.buffer.get(vehicleId) ?? []
      points.push(stored)
      this.buffer.set(vehicleId, points)
      if (points.length >= FLUSH_POINTS) await this.flush(vehicleId)
    }
  }

  private async onCharging(
    vehicleId: string,
    ts: number,
    rvm: string,
    payload: string,
  ): Promise<void> {
    const decoded = decodeCharging(rvm, payload)
    if (!decoded) return
    const data = JSON.stringify(decoded)
    const key = `${vehicleId} ${rvm}`
    if (!shouldSample(rvm, this.lastSamples.get(key), ts, data)) return
    await this.env.DB.prepare(
      'INSERT OR IGNORE INTO charge_samples (vehicle_id, ts, rvm, data, payload) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(vehicleId, ts, rvm, data, payload)
      .run()
    // Failed writes must remain eligible if Rivian sends the sample again.
    this.lastSamples.set(key, { ts, data })
  }

  private onClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    return this.serialize(() => this.handleClose(ws, code, reason))
  }

  private async handleClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    if (this.ws !== ws) return
    this.ws = null
    if (code === CLOSE_TTL_EXPIRED) {
      await this.scheduleAlarm(RECONNECT_MS)
    } else if (CLOSE_AUTH.includes(code)) {
      this.lastError = `Rivian rejected the session (${code} ${reason}). Reconnect the Rivian connector to sign in again.`
      const session = await this.session()
      await this.ctx.storage.put('session', { ...session, userSessionToken: '' })
    } else {
      await this.fail(new Error(`Websocket closed: ${code} ${reason}`))
    }
  }

  private async fail(error: unknown): Promise<void> {
    this.lastError = error instanceof Error ? error.message : String(error)
    this.backoffMs = Math.min(Math.max(this.backoffMs * 2, BACKOFF_MIN_MS), BACKOFF_MAX_MS)
    this.retryAt = Date.now() + this.backoffMs
    await this.ctx.storage.setAlarm(Date.now() + this.backoffMs)
  }

  private state(vehicleId: string): VehicleState {
    let state = this.states.get(vehicleId)
    if (!state) {
      state = {
        drive: null,
        closing: null,
        parkedAt: null,
        lastPoint: null,
        power: null,
        powerAt: 0,
        odometerKm: null,
      }
      this.states.set(vehicleId, state)
    }
    return state
  }

  /** Restores open drives after an eviction. Points still in the buffer are lost then. */
  private async loadStates(): Promise<void> {
    if (this.states.size > 0) return
    const drives = await this.ctx.storage.list<Drive>({ prefix: 'drive:' })
    for (const drive of drives.values()) this.state(drive.vehicleId).drive = drive
  }

  private async finishDrive(vehicleId: string): Promise<void> {
    const state = this.state(vehicleId)
    // The decision to close is kept until the write succeeds, so a failure is retried as a close.
    state.closing ??= state.drive && close(state.drive, state.odometerKm)
    if (!state.closing) return
    await this.writeDrive(vehicleId, state.closing)
    state.closing = null
    state.drive = null
    // The vehicle is parked where the drive ended, so the next trip starts from there.
    state.parkedAt = state.lastPoint
    await this.ctx.storage.delete(`drive:${vehicleId}`)
  }

  private async flushAll(): Promise<void> {
    for (const [vehicleId, state] of this.states) if (state.drive) await this.flush(vehicleId)
  }

  /** Writes buffered points and the drive summary in one D1 batch. */
  private async flush(vehicleId: string): Promise<void> {
    const state = this.states.get(vehicleId)
    await this.writeDrive(vehicleId, state?.closing ?? state?.drive)
  }

  private async writeDrive(vehicleId: string, drive: Drive | null | undefined): Promise<void> {
    if (!drive) return
    const points = this.buffer.get(vehicleId) ?? []
    const db = this.env.DB
    await db.batch([
      db
        .prepare(
          `INSERT INTO drives (id, vehicle_id, started_at, ended_at, start_lat, start_lon, end_lat, end_lon,
  start_odometer_km, end_odometer_km, distance_m, max_speed_mps, point_count)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (id) DO UPDATE SET ended_at = excluded.ended_at, end_lat = excluded.end_lat,
  end_lon = excluded.end_lon, end_odometer_km = excluded.end_odometer_km,
  distance_m = excluded.distance_m, max_speed_mps = excluded.max_speed_mps,
  point_count = excluded.point_count`,
        )
        .bind(
          drive.id,
          drive.vehicleId,
          drive.startedAt,
          drive.endedAt,
          drive.startLat,
          drive.startLon,
          drive.endLat,
          drive.endLon,
          drive.startOdometerKm,
          drive.endOdometerKm,
          drive.distanceM,
          drive.maxSpeedMps,
          drive.pointCount,
        ),
      ...points.map((p) =>
        db
          .prepare(
            'INSERT OR IGNORE INTO points (drive_id, ts, lat, lon, alt, speed_mps, bearing) VALUES (?, ?, ?, ?, ?, ?, ?)',
          )
          .bind(drive.id, p.ts, p.lat, p.lon, p.alt, p.speedMps, p.bearing),
      ),
      // A closed drive ends at its last move: drop the parked points after it.
      ...(drive.endedAt === null
        ? []
        : [
            db
              .prepare('DELETE FROM points WHERE drive_id = ? AND ts > ?')
              .bind(drive.id, drive.endedAt),
            db
              .prepare(
                'UPDATE drives SET point_count = (SELECT COUNT(*) FROM points WHERE drive_id = ?1) WHERE id = ?1',
              )
              .bind(drive.id),
          ]),
    ])
    // Cleared only after the write: a rejected batch keeps the points for the next flush.
    this.buffer.set(vehicleId, [])
    await this.ctx.storage.put(`drive:${vehicleId}`, drive)
  }
}
