// MCP Apps: tools that render drives, stats and charging in the host as an interactive view.
// All read only. The view is one HTML file built from ui/ by scripts/build-ui.ts.

import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from '@modelcontextprotocol/ext-apps/server'
import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import * as rivian from '../../src/rivian-api.ts'
import { errorText, READ_ONLY, text } from '../../src/tools.ts'
import html from '../dist/app.html'
import type {
  ChargeSessionView,
  ChargingView,
  DriveSummary,
  DriveView,
  Series,
  StatsView,
  StatusView,
  TrackPoint,
} from './app-data.ts'
import { batterySamples, DAY_MS, driveWindowSamples } from './battery.ts'
import { geocodeKey, reverseGeocodeMany } from './geocode.ts'
import { type DriveRow, iso, km, recorder } from './mcp.ts'
import { RVM_BATTERY, RVM_CHARGE_BREAKDOWN } from './parallax.ts'
import { DAILY_CAPACITY_SQL, STATS_POINTS_SQL } from './queries.ts'
import {
  chargeSessions,
  downsample,
  driveEnergy,
  type Elevation,
  efficiencyKmPerKwh,
  elevation,
  isNoise,
  MIN_AVG_SPEED_MPS,
  MIN_DRIVE_M,
  round,
  SESSION_GAP_MS,
} from './stats.ts'
import { buildStatus, describeStatus, type ParallaxBattery, STATUS_PROPERTIES } from './status.ts'

export const APP_URI = 'ui://rivian-mcp/app.html'
/** Tile servers the map loads images from. */
const TILE_DOMAINS = ['https://server.arcgisonline.com']
const MAX_TRACK_POINTS = 1000
const MAX_ROUTE_POINTS = 150
const MAX_SERIES_POINTS = 300
/** Stats read one point per this window, so a year of drives stays a bounded query. */
const STATS_POINT_BUCKET_MS = 15_000
/** Charging reads every battery sample of the period, so it takes a shorter range than stats. */
const MAX_CHARGING_DAYS = 90
/** A recorded battery sample older than this does not tell the range unit. */
const RANGE_SAMPLE_MAX_AGE_MS = 6 * 3_600_000
/** A recorded charging power older than this is not the current power. */
const POWER_SAMPLE_MAX_AGE_MS = 5 * 60_000

const ui = { ui: { resourceUri: APP_URI } }
const daysInput = (max: number) =>
  z.object({
    days: z
      .number()
      .int()
      .min(1)
      .max(max)
      .default(30)
      .describe(`How many days back from now to include, from 1 to ${max}. Defaults to 30.`),
  })

export function registerApps(server: McpServer, env: Env): void {
  registerAppResource(
    server,
    'Rivian dashboard',
    APP_URI,
    { description: 'Vehicle status, and maps, stats and charts for recorded drives and charging' },
    async () => ({
      contents: [
        {
          uri: APP_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: html,
          _meta: { ui: { csp: { resourceDomains: TILE_DOMAINS }, prefersBorder: true } },
        },
      ],
    }),
  )

  registerAppTool(
    server,
    'show_status',
    {
      description: [
        'Show the vehicle status right now as an interactive dashboard in the host: a drawing of the',
        'vehicle with doors, closures, windows and tires, lock state, battery, range, charging,',
        'cabin temperature, location, software update status and anything that needs attention.',
        'Use it for "Rivian status", "is my car locked", "how charged is it" or "is there an',
        'update". For the same facts as plain text use rivian_get_vehicle_state. Takes no',
        'arguments; also returns a text summary and structured data for hosts without app support.',
        'Reads the first vehicle on the account through the live Rivian API, and returns an error',
        'when the recorder holds no signed-in session. Read-only: it sends no command to the vehicle.',
      ].join(' '),
      annotations: READ_ONLY,
      _meta: ui,
    },
    async () => {
      try {
        const view = await statusView(env)
        return { ...text(describeStatus(view)), structuredContent: view }
      } catch (err) {
        return errorText((err as Error).message)
      }
    },
  )

  registerAppTool(
    server,
    'show_drive',
    {
      description: [
        'Show one recorded drive as an interactive card in the host: its route on a map, distance,',
        'duration, speed, energy, efficiency and elevation charts. Without an id it shows the latest',
        'drive. Use it to look at a drive; for the raw route data use get_drive, and to export use',
        'export_drive. Also returns a text summary and structured data. Returns "No drive" when none',
        'matches. Read-only: it reads recorded data from the recorder database, calls no Rivian',
        'API and sends no command to the vehicle.',
      ].join(' '),
      inputSchema: z.object({
        id: z
          .string()
          .optional()
          .describe('Drive id from list_drives. Omit to show the latest drive.'),
      }),
      annotations: { readOnlyHint: true },
      _meta: ui,
    },
    async ({ id }) => {
      const view = await driveView(env.DB, id)
      if (!view) return text(`No drive${id ? ` with id ${id}` : ''}.`)
      const d = view.drive
      const lines = [
        `Drive ${d.id}: ${iso(d.startedAt)}, ${km(d.distanceM)} in ${Math.round(d.durationMs / 60_000)} min.`,
        d.energyKwh === null
          ? 'Energy: no battery samples around this drive.'
          : `Energy: ${d.energyKwh} kWh (SoC ${d.socStartPct}% -> ${d.socEndPct}%), ${d.efficiencyKmPerKwh ?? '-'} km/kWh.`,
        d.elevation
          ? `Elevation: +${Math.round(d.elevation.gainM)} m, -${Math.round(d.elevation.lossM)} m.`
          : 'Elevation: no altitude data.',
      ]
      return { ...text(lines.join('\n')), structuredContent: view }
    },
  )

  registerAppTool(
    server,
    'show_stats',
    {
      description: [
        'Show driving stats for a period as an interactive dashboard in the host: totals, distance per',
        'day, efficiency, every route on one map, the drive list and battery capacity over time.',
        'Drives flagged as GPS noise are left out and counted in the text summary. Use it for an',
        'overview of many drives; for one drive use show_drive, for a list as text use list_drives.',
        'Also returns a text summary and structured data. Read-only: it reads recorded data from',
        'the recorder database, calls no Rivian API and sends no command to the vehicle.',
      ].join(' '),
      inputSchema: daysInput(365),
      annotations: { readOnlyHint: true },
      _meta: ui,
    },
    async ({ days }) => {
      const view = await statsView(env.DB, days)
      const distance = view.drives.reduce((sum, d) => sum + d.distanceM, 0)
      const energy = view.drives.reduce((sum, d) => sum + (d.energyKwh ?? 0), 0)
      const summaryText = [
        `Last ${days} days: ${view.drives.length} drives, ${km(distance)}, ${energy.toFixed(1)} kWh measured.`,
        view.skipped
          ? `${view.skipped} drives left out as GPS noise (under ${MIN_DRIVE_M} m, or averaging under ${MIN_AVG_SPEED_MPS} m/s).`
          : '',
      ]
        .filter(Boolean)
        .join('\n')
      return { ...text(summaryText), structuredContent: view }
    },
  )

  registerAppTool(
    server,
    'show_charging',
    {
      description: [
        'Show recorded charging sessions for a period as an interactive view in the host: energy',
        'added, average and peak power, and SoC and power curves. Sessions are detected from rising',
        'state of charge in the recorded battery samples, so a charge the recorder missed does not',
        'appear. Use it for charging trends; for a charge in progress use',
        'rivian_get_charging_session, and for the Rivian account history use',
        'rivian_get_charging_history. Also returns a text summary and structured data. Read-only:',
        'it reads recorded data from the recorder database, calls no Rivian API and sends no',
        'command to the vehicle.',
      ].join(' '),
      inputSchema: daysInput(MAX_CHARGING_DAYS),
      annotations: { readOnlyHint: true },
      _meta: ui,
    },
    async ({ days }) => {
      const view = await chargingView(env.DB, days)
      const energy = view.sessions.reduce((sum, s) => sum + s.energyKwh, 0)
      return {
        ...text(
          `Last ${days} days: ${view.sessions.length} charging sessions, ${energy.toFixed(1)} kWh added.`,
        ),
        structuredContent: view,
      }
    },
  )
}

async function statusView(env: Env): Promise<StatusView> {
  const rec = recorder(env)
  const { session, vehicles } = await rec.rivianSession()
  const [vehicle] = vehicles
  if (!vehicle) throw new Error('No vehicles found on your Rivian account.')
  const at = Date.now()
  const latest = async (rvm: string, maxAgeMs: number) => {
    const row = await env.DB.prepare(
      'SELECT data FROM charge_samples WHERE vehicle_id = ? AND rvm = ? AND ts >= ? ORDER BY ts DESC LIMIT 1',
    )
      .bind(vehicle.id, rvm, at - maxAgeMs)
      .first<{ data: string }>()
    return row ? (JSON.parse(row.data) as Record<string, number | undefined>) : null
  }
  // Only the vehicle state is required; every other source only adds detail.
  const [state, ota, settings, status, battery, power] = await Promise.all([
    rivian.getVehicleState(session, vehicle.id, STATUS_PROPERTIES),
    rivian.getOTAUpdateDetails(session, vehicle.id).catch(() => null),
    rivian.getUserSettings(session).catch(() => null),
    rec.status().catch(() => null),
    latest(RVM_BATTERY, RANGE_SAMPLE_MAX_AGE_MS).catch(() => null),
    latest(RVM_CHARGE_BREAKDOWN, POWER_SAMPLE_MAX_AGE_MS).catch(() => null),
  ])
  const loc = state.gnssLocation
  let place: string | null = null
  if (typeof loc?.latitude === 'number' && typeof loc.longitude === 'number') {
    const { latitude: lat, longitude: lon } = loc
    place = await reverseGeocodeMany(env.DB, [{ lat, lon }])
      .then((found) => found.get(geocodeKey(lat, lon))?.label ?? null)
      .catch(() => null)
  }
  const parallaxBattery: ParallaxBattery | null =
    battery?.socPct !== undefined && battery.rangeKm !== undefined
      ? { socPct: battery.socPct, rangeKm: battery.rangeKm }
      : null
  const drive = status?.openDrives.find((d) => d.vehicleId === vehicle.id)
  return buildStatus({
    at,
    vehicle,
    state,
    ota,
    settings,
    parallaxBattery,
    powerKw: power?.powerKw ?? null,
    drive: drive ? { startedAt: drive.startedAt, distanceM: Math.round(drive.distanceM) } : null,
    place,
  })
}

async function driveView(db: D1Database, id: string | undefined): Promise<DriveView | null> {
  const row = await db
    .prepare('SELECT * FROM drives WHERE ?1 IS NULL OR id = ?1 ORDER BY started_at DESC LIMIT 1')
    .bind(id ?? null)
    .first<DriveRow>()
  if (!row) return null
  const { results: points } = await db
    .prepare('SELECT ts, lat, lon, alt, speed_mps FROM points WHERE drive_id = ? ORDER BY ts')
    .bind(row.id)
    .all<{ ts: number; lat: number; lon: number; alt: number | null; speed_mps: number | null }>()
  const endedAt = row.ended_at ?? points.at(-1)?.ts ?? row.started_at
  const samples = await batterySamples(
    db,
    row.vehicle_id,
    row.started_at - DAY_MS,
    endedAt + DAY_MS,
  )
  const energy = driveEnergy(samples, row.started_at, endedAt)
  const elev = elevation(points.map((p) => p.alt))
  const track: TrackPoint[] = downsample(points, MAX_TRACK_POINTS).map((p) => [
    p.ts,
    round(p.lat, 6),
    round(p.lon, 6),
    p.alt === null ? null : round(p.alt, 1),
    p.speed_mps === null ? null : round(p.speed_mps, 2),
  ])
  return {
    kind: 'drive',
    drive: {
      ...summary(row, energy?.energyKwh ?? null, elev),
      durationMs: endedAt - row.started_at,
      startOdometerKm: row.start_odometer_km,
      endOdometerKm: row.end_odometer_km,
      socStartPct: energy?.socStartPct ?? null,
      socEndPct: energy?.socEndPct ?? null,
      elevation: elev,
    },
    track,
  }
}

async function statsView(db: D1Database, days: number): Promise<StatsView> {
  const to = Date.now()
  const from = to - days * DAY_MS
  const { results: rows } = await db
    .prepare('SELECT * FROM drives WHERE started_at >= ? ORDER BY started_at DESC')
    .bind(from)
    .all<DriveRow>()
  const drives = rows.filter(
    (d) => !isNoise(d.distance_m, d.ended_at === null ? null : d.ended_at - d.started_at),
  )
  // One point per bucket and drive; SQLite takes the bare columns from the MIN(ts) row.
  const { results: points } = await db
    .prepare(STATS_POINTS_SQL)
    .bind(from, MIN_DRIVE_M, STATS_POINT_BUCKET_MS)
    .all<{ drive_id: string; ts: number; lat: number; lon: number; alt: number | null }>()
  const byDrive = Map.groupBy(points, (p) => p.drive_id)
  const samplesByVehicle = await driveWindowSamples(db, from)
  const capacity = await dailyCapacity(db, from)

  return {
    kind: 'stats',
    from,
    to,
    minDriveM: MIN_DRIVE_M,
    minAvgSpeedMps: MIN_AVG_SPEED_MPS,
    skipped: rows.length - drives.length,
    drives: drives.map((d) => {
      const track = byDrive.get(d.id) ?? []
      const endedAt = d.ended_at ?? track.at(-1)?.ts ?? d.started_at
      const energy = driveEnergy(samplesByVehicle.get(d.vehicle_id) ?? [], d.started_at, endedAt)
      return {
        ...summary(d, energy?.energyKwh ?? null, elevation(track.map((p) => p.alt))),
        route: downsample(track, MAX_ROUTE_POINTS).map((p) => [round(p.lat, 5), round(p.lon, 5)]),
      }
    }),
    capacity,
  }
}

async function chargingView(db: D1Database, days: number): Promise<ChargingView> {
  const to = Date.now()
  const from = to - days * DAY_MS
  const { results: vehicles } = await db
    .prepare('SELECT DISTINCT vehicle_id FROM charge_samples WHERE ts >= ? AND rvm = ?')
    .bind(from, RVM_BATTERY)
    .all<{ vehicle_id: string }>()
  const sessions: ChargeSessionView[] = []
  for (const { vehicle_id: vehicleId } of vehicles) {
    const samples = await batterySamples(db, vehicleId, from - SESSION_GAP_MS, to)
    const { results: power } = await db
      .prepare(
        'SELECT ts, data FROM charge_samples WHERE vehicle_id = ? AND rvm = ? AND ts >= ? ORDER BY ts',
      )
      .bind(vehicleId, RVM_CHARGE_BREAKDOWN, from - SESSION_GAP_MS)
      .all<{ ts: number; data: string }>()
    const powerSeries: Series = power.flatMap((p) => {
      const kw = (JSON.parse(p.data) as { powerKw?: number }).powerKw
      return kw === undefined ? [] : [[p.ts, kw] as [number, number]]
    })
    for (const s of chargeSessions(samples)) {
      // A session that ended before the period only appears because of the extra lookback.
      if (s.endedAt < from) continue
      const within = (ts: number) => ts >= s.startedAt && ts <= s.endedAt
      const sessionPower = powerSeries.filter(([ts]) => within(ts))
      const hours = (s.endedAt - s.startedAt) / 3_600_000
      sessions.push({
        vehicleId,
        ...s,
        avgKw: hours > 0 ? round(s.energyKwh / hours, 1) : 0,
        peakKw: sessionPower.length ? Math.max(...sessionPower.map(([, kw]) => kw)) : null,
        soc: downsample(
          samples.filter((b) => within(b.ts)).map((b): [number, number] => [b.ts, b.socPct]),
          MAX_SERIES_POINTS,
        ),
        power: downsample(sessionPower, MAX_SERIES_POINTS),
      })
    }
  }
  sessions.sort((a, b) => b.startedAt - a.startedAt)
  return { kind: 'charging', from, to, sessions }
}

/** The last pack capacity reading of each UTC day, separately for each vehicle. */
async function dailyCapacity(db: D1Database, from: number): Promise<StatsView['capacity']> {
  // The bare columns come from the MAX(ts) row of each day.
  const { results } = await db
    .prepare(DAILY_CAPACITY_SQL)
    .bind(RVM_BATTERY, from, DAY_MS)
    .all<{ vehicle_id: string; ts: number; kwh: number }>()
  return [...Map.groupBy(results, (r) => r.vehicle_id)].map(([vehicleId, rows]) => ({
    vehicleId,
    points: rows.map((r): [number, number] => [r.ts, r.kwh]),
  }))
}

function summary(d: DriveRow, energyKwh: number | null, elev: Elevation | null): DriveSummary {
  return {
    id: d.id,
    vehicleId: d.vehicle_id,
    startedAt: d.started_at,
    endedAt: d.ended_at,
    distanceM: Math.round(d.distance_m),
    maxSpeedMps: d.max_speed_mps,
    energyKwh,
    efficiencyKmPerKwh: efficiencyKmPerKwh(d.distance_m, energyKwh),
    gainM: elev ? Math.round(elev.gainM) : null,
    lossM: elev ? Math.round(elev.lossM) : null,
  }
}
