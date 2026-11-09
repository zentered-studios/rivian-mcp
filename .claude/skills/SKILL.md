---

name: rivian-api
description: Use for Rivian GraphQL queries, vehicle state fields, MCP tools, formatters and API errors in this repository.
---

# Rivian API

## Critical Safety Rule

**This project is READ ONLY. Never add mutations that write, update, or send commands.**

Allowed mutations: `CreateCSRFToken`, `Login`, `LoginWithOTP` only.
Forbidden: `sendVehicleCommand`, `setVehicleName`, `setChargingSchedules`, any write operation.

## Architecture

| File                     | Purpose                                                         |
| ------------------------ | --------------------------------------------------------------- |
| `src/rivian-api.ts`      | All API interaction - session state, queries, auth              |
| `src/format.ts`          | Human-readable output for MCP/CLI                               |
| `src/session.ts`         | Session persistence to `~/.rivian-mcp/session.json`             |
| `src/mcp-server.ts`      | Stdio MCP entry point, authentication tools and session restore |
| `src/tools.ts`           | Live query tools shared by stdio and the Worker                 |
| `worker/src/recorder.ts` | Durable Object recorder and live websocket subscriptions        |
| `src/cli.ts`             | CLI - `ota` and `stats` commands                                |
| `src/prompt.ts`          | Terminal-only masked password and OTP input                     |

## API Endpoints

| Endpoint                                       | Purpose                                       | Auth                                                      |
| ---------------------------------------------- | --------------------------------------------- | --------------------------------------------------------- |
| `https://rivian.com/api/gql/gateway/graphql`   | Auth, vehicle info, state, schedules, drivers | `authHeaders()` → `{ A-Sess, U-Sess }`                    |
| `https://rivian.com/api/gql/chrg/user/graphql` | Charging history, live session                | `chargingHeaders()` → `{ U-Sess, Authorization: Bearer }` |

> Introspection is blocked on both endpoints. `/orders/graphql` and `/t2d/graphql` exist but are untested.
>
> **Discovery tip:** the charging endpoint returns Apollo `Did you mean "..."?` suggestions and full validation messages (unknown field, missing required argument with its type). Probe it with near-complete names to enumerate fields and arguments. The gateway masks every validation error as `Error in GraphQL validation`, so probe it one field per request.

All HTTP requests have a 30-second timeout. Failed requests are not automatically retried, including authentication mutations.

## Authentication Flow

1. `createCsrfToken(session)` → gets `csrfToken` + `appSessionToken`
2. `login(session, email, password)` → `{ mfa: true|false }`
   - `mfa: true` → OTP sent → `validateOtp(session, email, code)`
3. Gateway queries use `A-Sess` + `U-Sess`; charging queries use `U-Sess` + `Authorization: Bearer <accessToken>`
4. The local session persists to `~/.rivian-mcp/session.json` and is reused for at most 90 days (`SESSION_MAX_AGE_MS` in `src/session.ts`). Rivian can expire it sooner. The Worker stores sessions in its Recorder Durable Object instead.
5. `exportSession(session)` / `restoreSession(session, saved)` - serialize/restore state
6. `isAuthenticated(session)` / `needsOtp(session)` - check status

## Implemented Functions

### `getUserInfo(session)`

Returns `currentUser` with vehicles, including `vehicle.mobileConfiguration` (trim, drive system, exterior, interior, wheels) and `vehicle.actualGeneralAssemblyDate`. The local CLI and stdio server select `vehicles[0].id` for single-vehicle queries; the Worker supplies its vehicle through `QueryContext`. The vehicle ID is not the VIN.

### `getVehicles(session)`

Returns the recorder’s compact vehicle list: `id`, `name`, `model` and `modelYear`.

### `getVehicleState(session, vehicleId, properties?)`

Use `vehicleState(id: $vehicleID)`. The variable is `vehicleID` (capital D), not `vehicleId`.

```graphql
query GetVehicleState($vehicleID: String!) {
  vehicleState(id: $vehicleID) {
    batteryLevel {
      timeStamp
      value
    }
    cloudConnection {
      lastSync
      isOnline
    }
    # ...
  }
}
```

Pass a `Set<string>` to fetch specific properties; omit for the full default set. Most return `{ timeStamp, value }`. Three use custom templates defined in `TEMPLATE_MAP`: `cloudConnection`, `gnssLocation`, `gnssError`.

`vehicleMileage` is in meters (live `47393698` = 47,394 km). Divide by 1000 for km. Round `batteryLevel` for display; the API returns floating-point noise. See `references/vehicle-state-properties.md` for per-field units.

### `getOTAUpdateDetails(session, vehicleId)`

Returns `currentOTAUpdateDetails`, `availableOTAUpdateDetails`, and `vehicleState.otaStatus` via `getVehicle(id:)`.

### `getLiveChargingSession(session, vehicleId)`

Queries `getLiveSessionHistory(vehicleId: ID!)` on the charging endpoint. `getLiveSessionData` was removed (rejected Oct 2026) and its fields moved to `getLiveSessionHistory`. The query returns an all-null object when not charging, and also during an active charge it does not track (live, Oct 10, 2026: `chargerState: charging_active`, every field `null`). The function returns `null` in both cases.

### `getChargingState(session, vehicleId)`

Reads `batteryLevel`, `batteryLimit`, `timeToEndOfCharge`, `chargerState` and `chargingTimeEstimationValidity` from vehicle state. `rivian_get_charging_session` calls it when `getLiveChargingSession` returns `null`, and `formatChargingSession(null, state)` shows the charge when `chargerState` is `charging_active`.

### `getChargingHistory(session, vehicleId)`

Queries `getCompletedSessionSummariesV2(vehicleId: String!, pageSize: Int, searchAfter: String)` and follows `pageInfo.nextCursor` (max `pageSize` 100, no fixed page cap; repeated or missing continuation cursors are errors). Maps each item to the legacy flat shape (`startInstant`, `totalEnergyKwh`, `rangeAddedKm`, `vendor`, `city`, `paidTotal`, ...). The v1 `getCompletedSessionSummaries` still validates but returns `[]` (Oct 2026).

### `getAllChargingHistory(session)`

Fetches charging history for every vehicle on the account and merges sessions newest first. If any vehicle history is unavailable, returns `null` rather than silently presenting a partial list.

### `getChargingSchedule(session, vehicleId)`

Returns `chargingSchedules` array from `getVehicle`.

### `getDriversAndKeys(session, vehicleId)`

Returns `invitedUsers` (provisioned + unprovisioned) with enrolled devices.

## Adding a New Vehicle State Property

1. Check the field in `references/vehicle-state-properties.md`. Unknown fields return `GRAPHQL_VALIDATION_FAILED`.
2. Add to `DEFAULT_VEHICLE_STATE_PROPERTIES` in `src/rivian-api.ts`.
3. If the field needs a non-standard fragment (not `{ timeStamp value }`), add it to `TEMPLATE_MAP`.
4. Add formatting in `src/format.ts`. Mark each field as `printed` so it does not also appear in "Other".

## Adding a New MCP Tool

1. Add an exported function to `src/rivian-api.ts`.
2. Add a `format*` function to `src/format.ts`.
3. Register live queries with `server.registerTool(name, { description, inputSchema, annotations: READ_ONLY }, handler)` in `src/tools.ts` so both the stdio server and the Worker expose them. `inputSchema` is a `z.object(...)`.
4. Handler pattern (`query` obtains authentication from `QueryContext` and returns errors with `isError: true`):

```ts
;({ param }) =>
  query(async (session) => {
    const vehicleId = await ctx.vehicleId(session)
    return format.formatMyThing(await rivian.getMyThing(session, vehicleId, param))
  })
```

## format.ts Patterns

`formatVehicleState` uses a `printed` Set to track which keys have been rendered, falling back to an "Other" section for any remainder. When adding a new section:

```js
// Mark keys so they don't leak into "Other"
printed.add('myNewField')
const val = state.myNewField?.value
if (val !== null && val !== undefined) lines.push(`  My label: ${val}`)
```

For conditional sections, check whether at least one relevant key is present before pushing a section header:

```js
const myKeys = ['field1', 'field2', 'field3']
if (myKeys.some((k) => k in state)) {
  lines.push('Section Header')
  print('Label', 'field1')
  print('Label', 'field2')
  lines.push('')
}
```

## Common Errors

| Error                           | Cause                                     | Fix                                                                                            |
| ------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `GRAPHQL_VALIDATION_FAILED`     | Unknown field name or wrong variable name | Check `references/vehicle-state-properties.md`; ensure variable is `vehicleID` not `vehicleId` |
| `Not logged in`                 | No session / expired session              | Call `rivian_login` → `rivian_submit_otp`                                                      |
| `HTTP 400 Body cannot be empty` | JSON serialization issue in shell         | Use Node.js or proper JSON escaping                                                            |
| Field leaks into "Other"        | Missing `printed.add(key)` in formatter   | Add the key to `printed` in the appropriate section                                            |

## Additional Resources

- [`references/vehicle-state-properties.md`](references/vehicle-state-properties.md) lists tested fields, types, examples and rejected queries. Consult it before adding a field.
  - Verified read-only queries not yet implemented as tools: `getRegisteredWallboxes`, `getSessionStatusByVehicleId`, `Vehicle.estimatedRange(startSoc)`, and the `chartData` series of `getLiveSessionHistory`. Schemas are in the reference under "Additional Queries → Confirmed working."
  - Websocket subscriptions (`VehicleState` with subscription-only fields, `ParallaxMessages` with 25 RVM topics, `chargingSession`, `vehicleDepartureSchedules`) have been verified live. The Worker recorder uses `VehicleState` and `ParallaxMessages`; the other subscriptions remain reference material. See the reference under "Subscriptions (websocket)". Use one `VehicleState` subscription per vehicle: parallel ones hit `SUBSCRIPTION_LIMIT_EXCEEDED`.
