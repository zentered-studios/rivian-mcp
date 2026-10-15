// MCP tools. All read only. Sign-in happens on the OAuth consent page in oauth.ts.

import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { registerQueryTools, text } from '../../src/tools.ts'
import { type DriveRow, enrichDrive, enrichDrives, loadPoints } from './enrich.ts'
import {
  DRIVES_SCHEMA,
  type DriveFacts,
  type DrivePayload,
  drivePayload,
  type RoutePoint,
  SPARSE_POINTS_PER_KM,
  toGeoJsonCollection,
  toGeoJsonFeature,
  toGpx,
} from './export.ts'
import { MIN_AVG_SPEED_MPS, MIN_DRIVE_M } from './stats.ts'
import { localIso, timezoneAt, utcIso, zoneAbbreviation } from './timezone.ts'

export type { DriveRow } from './enrich.ts'

/** get_drive returns at most this many points by default so the result fits a model context. */
const DEFAULT_TRACK_POINTS = 500
/** export_drive simplifies the route to this many points unless asked otherwise. */
const DEFAULT_EXPORT_POINTS = 100
const MAX_POINTS = 2000
/** A date range export stops here, so one call stays bounded. */
const MAX_EXPORT_DRIVES = 50
/** list_drives hides drives shorter than this unless min_distance_km says otherwise. */
const DEFAULT_MIN_DISTANCE_KM = MIN_DRIVE_M / 1000

export const recorder = (env: Env) => env.RECORDER.get(env.RECORDER.idFromName('default'))
export const km = (m: number) => `${(m / 1000).toFixed(1)} km`
const kmh = (mps: number) => `${Math.round(mps * 3.6)} km/h`
export const iso = utcIso

/** Shared closing sentence for tools that read only recorded data. */
export const RECORDED_READ_ONLY =
  'Read-only: it reads recorded data from the recorder database, calls no Rivian API and sends no command to the vehicle.'

const dateArg = (what: string) =>
  z
    .string()
    .date()
    .optional()
    .describe(`${what}. Format YYYY-MM-DD, read as a UTC day, for example 2026-03-01.`)
const maxPointsArg = (fallback: number) =>
  z
    .number()
    .int()
    .min(2)
    .max(MAX_POINTS)
    .default(fallback)
    .describe(
      `Most route points to return, from 2 to ${MAX_POINTS}. The route is simplified (Douglas-Peucker) to fit. Defaults to ${fallback}.`,
    )

/** Human summary of a drive for the text content: places, local times, stats, quality. */
export function describeDrive(d: DriveFacts, open: boolean): string {
  const tz = timezoneAt(d.startLat, d.startLon)
  const endTz = timezoneAt(d.endLat, d.endLon) ?? tz
  const minutes = Math.round((d.endedAt - d.startedAt) / 60_000)
  const startLocal = localIso(d.startedAt, tz)
  const endLocal = localIso(d.endedAt, endTz)
  const startZone = zoneAbbreviation(d.startedAt, tz)
  const endZone = zoneAbbreviation(d.endedAt, endTz)
  const sameDay = startLocal.slice(0, 10) === endLocal.slice(0, 10)
  const startClock = startLocal.slice(0, 16).replace('T', ' ')
  const when = open
    ? `${startClock} ${startZone} -> in progress`
    : `${startClock}${startZone === endZone ? '' : ` ${startZone}`} -> ${(sameDay ? endLocal.slice(11, 16) : endLocal.slice(0, 16)).replace('T', ' ')} ${endZone} (${minutes} min)`
  const place = (p: typeof d.start, lat: number, lon: number) =>
    p?.label ?? `${lat.toFixed(4)}, ${lon.toFixed(4)}`
  const stats = [
    km(d.distanceM),
    `max ${kmh(d.maxSpeedMps)}`,
    d.elevation
      ? `+${Math.round(d.elevation.gainM)} m / -${Math.round(d.elevation.lossM)} m`
      : 'elevation unknown',
    d.energy
      ? `${d.energy.energyKwh} kWh (SoC ${d.energy.socStartPct}% -> ${d.energy.socEndPct}%)`
      : 'energy unknown (no battery samples)',
  ]
  const perKm = d.distanceM > 0 ? d.pointCount / (d.distanceM / 1000) : 0
  const quality = [`${d.pointCount} points (${perKm.toFixed(1)}/km)`]
  if (d.noise) quality.push('NOISE: parked GPS drift, not a drive')
  else if (perKm < SPARSE_POINTS_PER_KM && d.pointCount > 0) quality.push('SPARSE: coarse route')
  return [
    d.id,
    `  ${place(d.start, d.startLat, d.startLon)} -> ${place(d.end, d.endLat, d.endLon)}`,
    `  ${when}`,
    `  ${stats.join(', ')}`,
    `  ${quality.join(', ')}`,
  ].join('\n')
}

const driveById = (db: D1Database, id: string) =>
  db.prepare('SELECT * FROM drives WHERE id = ?').bind(id).first<DriveRow>()

/** The speed half of `isNoise` for closed drives, so a LIMIT never counts rows it would drop. */
const MIN_SPEED_SQL = `(ended_at <= started_at OR distance_m >= (ended_at - started_at) / 1000.0 * ${MIN_AVG_SPEED_MPS})`

const dayStart = (date: string) => Date.parse(`${date}T00:00:00Z`)
const dayEnd = (date: string) => Date.parse(`${date}T23:59:59.999Z`)

export function registerTools(server: McpServer, env: Env): void {
  registerQueryTools(server, {
    session: async () => (await recorder(env).rivianSession()).session,
    vehicleId: async () => {
      const [vehicle] = (await recorder(env).rivianSession()).vehicles
      if (!vehicle) throw new Error('No vehicles found on your Rivian account.')
      return vehicle.id
    },
  })

  server.registerTool(
    'recorder_status',
    {
      description: [
        'Show whether the recorder holds a signed-in Rivian session and is connected to the live feed,',
        'the vehicles it knows, the time of the last message, any drive still open with its distance so',
        'far, and the last error. Use it first when drives or charging data look missing or stale. For',
        'recorded drives use list_drives; for live vehicle readings use rivian_get_vehicle_state.',
        'Takes no arguments and returns readable text. Read-only: it reads recorder state, calls no',
        'Rivian API and sends no command to the vehicle.',
      ].join(' '),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const s = await recorder(env).status()
      const lines = [
        `Logged in: ${s.loggedIn ? 'yes' : 'no, reconnect the Rivian connector'}`,
        `Connected: ${s.connected ? 'yes' : 'no'}`,
        `Vehicles: ${s.vehicles.map((v) => v.name ?? v.model).join(', ') || 'none'}`,
        `Last message: ${s.lastMessageAt ? iso(s.lastMessageAt) : 'none since restart'}`,
        ...s.openDrives.map((d) => `Open drive: since ${iso(d.startedAt)}, ${km(d.distanceM)}`),
      ]
      if (s.lastError) lines.push(`Last error: ${s.lastError}`)
      return text(lines.join('\n'))
    },
  )

  server.registerTool(
    'list_drives',
    {
      description: [
        'List drives the recorder captured, newest first, each with id, start and end place',
        '(neighborhood, city, region), local start and end time, distance, max speed, elevation gain and',
        'loss, energy used, and a quality line (GPS fix density; NOISE for parked drift, SPARSE for',
        `coarse routes). Drives under ${DEFAULT_MIN_DISTANCE_KM} km are hidden unless min_distance_km is`,
        'lower. Use it to find a drive id. For one route with its track use get_drive; to export for',
        'Roadbook use export_drive; for a visual card use show_drive. Returns text plus structured',
        'data, and "No drives recorded" when nothing matches.',
        RECORDED_READ_ONLY,
      ].join(' '),
      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .describe('Most drives to return, from 1 to 100. Defaults to 20.'),
        since: dateArg('Only drives on or after this date'),
        until: dateArg('Only drives on or before this date'),
        min_distance_km: z
          .number()
          .min(0)
          .default(DEFAULT_MIN_DISTANCE_KM)
          .describe(
            `Hide drives shorter than this many kilometers, for example 5. 0 shows everything including GPS noise. Defaults to ${DEFAULT_MIN_DISTANCE_KM}.`,
          ),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ limit, since, until, min_distance_km: minKm }) => {
      const { results } = await env.DB.prepare(
        'SELECT * FROM drives WHERE started_at BETWEEN ? AND ? AND distance_m >= ? ORDER BY started_at DESC LIMIT ?',
      )
        .bind(
          since ? dayStart(since) : 0,
          until ? dayEnd(until) : Number.MAX_SAFE_INTEGER,
          minKm * 1000,
          limit,
        )
        .all<DriveRow>()
      if (results.length === 0) return text('No drives recorded for that range.')
      const drives = await enrichDrives(env.DB, results)
      const total = drives.reduce((sum, d) => sum + d.distanceM, 0)
      const openIds = new Set(results.filter((r) => r.ended_at === null).map((r) => r.id))
      const body = drives.map((d) => describeDrive(d, openIds.has(d.id))).join('\n\n')
      return {
        ...text(`${drives.length} drives, ${km(total)}\n\n${body}`),
        structuredContent: {
          drives: drives.map((d) => ({
            id: d.id,
            started_at: utcIso(d.startedAt),
            ended_at: openIds.has(d.id) ? null : utcIso(d.endedAt),
            start: d.start?.label ?? null,
            end: d.end?.label ?? null,
            distance_km: Number((d.distanceM / 1000).toFixed(2)),
            duration_min: Math.round((d.endedAt - d.startedAt) / 60_000),
            energy_kwh: d.energy?.energyKwh ?? null,
            point_count: d.pointCount,
            noise: d.noise,
          })),
        },
      }
    },
  )

  server.registerTool(
    'get_drive',
    {
      description: [
        'Get one recorded drive by id: the summary line from list_drives plus a GeoJSON Feature. Its',
        'geometry is the route as a LineString; its properties carry the roadbook.drive/1 fields',
        '(source, UTC and local times, time zone, distance, duration, max speed, elevation, energy,',
        'start and end with coordinates and place labels, quality). Use it to inspect one route. To',
        'send a drive to Roadbook use export_drive; for a map card use show_drive. Returns "No drive',
        'with id" when the id is unknown.',
        RECORDED_READ_ONLY,
      ].join(' '),
      inputSchema: z.object({
        id: z.string().describe('Drive id from list_drives'),
        max_points: maxPointsArg(DEFAULT_TRACK_POINTS),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ id, max_points: maxPoints }) => {
      const row = await driveById(env.DB, id)
      if (!row) return text(`No drive with id ${id}.`)
      const points = await loadPoints(env.DB, id)
      const facts = await enrichDrive(env.DB, row, points)
      const feature = toGeoJsonFeature(drivePayload(facts, points, maxPoints))
      return {
        ...text(`${describeDrive(facts, row.ended_at === null)}\n\n${JSON.stringify(feature)}`),
        structuredContent: feature,
      }
    },
  )

  server.registerTool(
    'export_drive',
    {
      description: [
        'Export one finished drive, or every finished drive in a date range, as a payload to hand to',
        'another tool or save. The default format `roadbook` is the roadbook.drive/1 JSON that Roadbook',
        'import_drive accepts unchanged: pass the object as its `drive` argument (a date range gives',
        'roadbook.drives/1; pass that as `drives`), with an optional tripId to add to an existing trip.',
        'Each drive carries source {system, id} for idempotency, UTC and local times, distance_km,',
        'duration_min, max_speed_kmh, elevation gain and loss, energy_kwh (null without a close battery',
        'sample), start and end {lat, lng, label, city, region, country} and a simplified GeoJSON',
        'LineString. `geojson` gives a Feature or FeatureCollection, `gpx` a GPX 1.1 track.',
        `A range stops at ${MAX_EXPORT_DRIVES} drives and says so. With no id, since or until it exports`,
        'the latest drive. A drive still in progress is refused. To browse drives first use',
        'list_drives.',
        RECORDED_READ_ONLY,
      ].join(' '),
      inputSchema: z.object({
        id: z.string().optional().describe('Drive id from list_drives; omit for the latest drive'),
        since: dateArg('Export every drive from this date'),
        until: dateArg('Export every drive up to this date (no upper date bound when omitted)'),
        format: z
          .enum(['roadbook', 'geojson', 'gpx'])
          .default('roadbook')
          .describe(
            'Output format: roadbook (roadbook.drive/1 JSON), geojson (Feature or FeatureCollection) or gpx (GPX 1.1 track). Defaults to roadbook.',
          ),
        max_points: maxPointsArg(DEFAULT_EXPORT_POINTS),
        include_noise: z
          .boolean()
          .default(false)
          .describe('Also export drives flagged as parked GPS noise. Defaults to false.'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ id, since, until, format, max_points: maxPoints, include_noise: includeNoise }) => {
      let rows: DriveRow[]
      if (id) {
        const row = await driveById(env.DB, id)
        if (!row) return text(`No drive with id ${id}.`)
        if (row.ended_at === null)
          return text(`Drive ${id} is still in progress; export it once it has ended.`)
        rows = [row]
      } else if (since || until) {
        const from = since ? dayStart(since) : 0
        const to = until ? dayEnd(until) : Number.MAX_SAFE_INTEGER
        const { results } = await env.DB.prepare(
          `SELECT * FROM drives WHERE started_at BETWEEN ? AND ? AND ended_at IS NOT NULL AND distance_m >= ? AND (? OR ${MIN_SPEED_SQL}) ORDER BY started_at ASC LIMIT ?`,
        )
          .bind(
            from,
            to,
            includeNoise ? 0 : MIN_DRIVE_M,
            includeNoise ? 1 : 0,
            MAX_EXPORT_DRIVES + 1,
          )
          .all<DriveRow>()
        rows = results
      } else {
        const { results } = await env.DB.prepare(
          `SELECT * FROM drives WHERE ended_at IS NOT NULL AND distance_m >= ? AND (? OR ${MIN_SPEED_SQL}) ORDER BY started_at DESC LIMIT 1`,
        )
          .bind(includeNoise ? 0 : MIN_DRIVE_M, includeNoise ? 1 : 0)
          .all<DriveRow>()
        rows = results
      }
      if (rows.length === 0) return text('No drives to export for that selection.')
      const truncated = rows.length > MAX_EXPORT_DRIVES
      if (truncated) rows = rows.slice(0, MAX_EXPORT_DRIVES)

      const drives: { payload: DrivePayload; points: RoutePoint[] }[] = []
      for (const row of rows) {
        const points = await loadPoints(env.DB, row.id)
        const facts = await enrichDrive(env.DB, row, points)
        if (facts.noise && !includeNoise && id === undefined) continue
        drives.push({ payload: drivePayload(facts, points, maxPoints), points })
      }
      if (drives.length === 0)
        return text('Only GPS noise in that selection; pass include_noise to export it.')
      const single = id !== undefined || (!since && !until)
      const notice = truncated
        ? [
            {
              type: 'text' as const,
              text: `Stopped at ${MAX_EXPORT_DRIVES} drives; narrow the date range for the rest.`,
            },
          ]
        : []

      if (format === 'gpx')
        return { content: [...text(toGpx(drives, maxPoints)).content, ...notice] }
      const payloads = drives.map((d) => d.payload)
      const body =
        format === 'geojson'
          ? single
            ? toGeoJsonFeature(payloads[0])
            : toGeoJsonCollection(payloads)
          : single
            ? payloads[0]
            : { schema: DRIVES_SCHEMA, drives: payloads }
      return {
        content: [...text(JSON.stringify(body)).content, ...notice],
        structuredContent: body,
      }
    },
  )
}
