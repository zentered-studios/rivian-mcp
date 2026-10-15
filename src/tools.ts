// Live read-only query tools, shared by the stdio server and the Cloudflare Worker.

import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import * as format from './format.ts'
import * as rivian from './rivian-api.ts'

/** Where the tools get the Rivian session and vehicle. Both throw a readable error when unset. */
export interface QueryContext {
  session(): Promise<rivian.Session>
  vehicleId(session: rivian.Session): Promise<string>
}

export const READ_ONLY = { readOnlyHint: true, openWorldHint: true }

const SIGNED_IN = 'Requires a signed-in Rivian session and returns an error without one.'
const FIRST_VEHICLE = 'Reads the first vehicle on the account.'
const NO_COMMANDS = 'Read-only: sends no command to the vehicle.'

export function text(str: string) {
  return { content: [{ type: 'text' as const, text: str }] }
}

/** A tool response that reports a failure to the client. */
export function errorText(str: string) {
  return { ...text(str), isError: true }
}

export function registerQueryTools(server: McpServer, ctx: QueryContext): void {
  // Return query failures as MCP tool errors.
  const query = async (run: (session: rivian.Session) => Promise<string>) => {
    try {
      return text(await run(await ctx.session()))
    } catch (err) {
      return errorText((err as Error).message)
    }
  }

  server.registerTool(
    'rivian_get_user_info',
    {
      description: [
        'Get the account owner and each vehicle on the account: name, model, VIN, trim, drive system,',
        'colors, wheels, build date, installed software version and any available update with a',
        'release notes link. Use it to identify the vehicle or the account. For update progress use',
        'rivian_get_ota_status; for live readings use rivian_get_vehicle_state. Returns readable text.',
        SIGNED_IN,
        NO_COMMANDS,
      ].join(' '),
      annotations: READ_ONLY,
    },
    () => query(async (s) => format.formatUserInfo(await rivian.getUserInfo(s))),
  )

  server.registerTool(
    'rivian_get_vehicle_state',
    {
      description: [
        'Get the live vehicle state as readable text: battery level and range, doors, windows, tires,',
        'location, climate, seat heating and ventilation, steering wheel heat, software versions, and',
        'security and trailer status. Use it for how the vehicle is right now. For an active charge use',
        'rivian_get_charging_session; for past charges use rivian_get_charging_history; for updates use',
        'rivian_get_ota_status. Distances follow the unit set in the vehicle.',
        FIRST_VEHICLE,
        SIGNED_IN,
        NO_COMMANDS,
      ].join(' '),
      inputSchema: z.object({
        properties: z
          .array(z.string())
          .optional()
          .describe(
            'Names of the vehicle state properties to read, for example "batteryLevel" or "doorFrontLeftLocked". Omit or pass an empty array for the full report. An unknown name makes the Rivian API reject the request.',
          ),
      }),
      annotations: READ_ONLY,
    },
    ({ properties }) =>
      query(async (s) => {
        const props = properties?.length ? new Set(properties) : undefined
        return format.formatVehicleState(
          await rivian.getVehicleState(s, await ctx.vehicleId(s), props),
        )
      }),
  )

  server.registerTool(
    'rivian_get_ota_status',
    {
      description: [
        'Get the installed software version, the update status reported by the vehicle (for example idle)',
        'and any available update with its version and release notes link. Use it to check whether an',
        'update is waiting. For the full account and vehicle list use rivian_get_user_info. Returns',
        'readable text; shows "up to date" when no update is available.',
        FIRST_VEHICLE,
        SIGNED_IN,
        NO_COMMANDS,
      ].join(' '),
      annotations: READ_ONLY,
    },
    () =>
      query(async (s) =>
        format.formatOTAStatus(await rivian.getOTAUpdateDetails(s, await ctx.vehicleId(s))),
      ),
  )

  server.registerTool(
    'rivian_get_charging_session',
    {
      description: [
        'Get the charge happening now: battery level, power in kW, energy added in kWh, current in A,',
        'time elapsed and remaining, cost so far or free, whether it is a Rivian charger, and the',
        'charger location. When no live session exists, it reports the vehicle charging state instead.',
        'For finished sessions use rivian_get_charging_history; for planned charging use',
        'rivian_get_charging_schedule. Returns readable text.',
        FIRST_VEHICLE,
        SIGNED_IN,
        NO_COMMANDS,
      ].join(' '),
      annotations: READ_ONLY,
    },
    () =>
      query(async (s) => {
        const vehicleId = await ctx.vehicleId(s)
        const live = await rivian.getLiveChargingSession(s, vehicleId)
        // An empty live session does not mean the vehicle is idle; check vehicle state
        const state = live ? null : await rivian.getChargingState(s, vehicleId)
        return format.formatChargingSession(live, state)
      }),
  )

  server.registerTool(
    'rivian_get_charging_history',
    {
      description: [
        'List past charging sessions, newest first. Each row has date, start and end time, duration,',
        'energy in kWh, cost or free, city, charging network and charger type (home, public or other).',
        'Use it for completed sessions. For a charge in progress use rivian_get_charging_session.',
        'Returns readable text.',
        FIRST_VEHICLE,
        SIGNED_IN,
        NO_COMMANDS,
      ].join(' '),
      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'How many of the newest sessions to return, for example 10. Whole number of 1 or more. Defaults to 25.',
          ),
      }),
      annotations: READ_ONLY,
    },
    ({ limit }) =>
      query(async (s) =>
        format.formatChargingHistory(await rivian.getAllChargingHistory(s), limit ?? 25),
      ),
  )

  server.registerTool(
    'rivian_get_charging_schedule',
    {
      description: [
        'Get the charging schedules saved for the vehicle: start and end time, duration, whether each',
        'is enabled, amperage, the days of the week and the location it applies to. Use it to see when',
        'the vehicle is set to charge. It does not change a schedule. For a charge in progress use',
        'rivian_get_charging_session. Returns readable text.',
        FIRST_VEHICLE,
        SIGNED_IN,
        NO_COMMANDS,
      ].join(' '),
      annotations: READ_ONLY,
    },
    () =>
      query(async (s) =>
        format.formatChargingSchedule(await rivian.getChargingSchedule(s, await ctx.vehicleId(s))),
      ),
  )

  server.registerTool(
    'rivian_get_drivers_and_keys',
    {
      description: [
        'List who and what can open and drive the vehicle: invited drivers, enrolled phone keys and',
        'key fobs. Use it to audit access to the vehicle. It does not add or revoke access. For account',
        'and vehicle details use rivian_get_user_info. Returns readable text.',
        FIRST_VEHICLE,
        SIGNED_IN,
        NO_COMMANDS,
      ].join(' '),
      annotations: READ_ONLY,
    },
    () =>
      query(async (s) =>
        format.formatDriversAndKeys(await rivian.getDriversAndKeys(s, await ctx.vehicleId(s))),
      ),
  )
}
