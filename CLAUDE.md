# CLAUDE.md

## Critical Safety Rule

**This project is READ ONLY against the Rivian API.** Never add GraphQL mutations that write, update, or send commands. The only allowed mutations are `CreateCSRFToken`, `Login`, and `LoginWithOTP` (authentication). No `sendVehicleCommand`, `setVehicleName`, `setChargingSchedules`, or any other write operation.

## Commands

```sh
npm run typecheck && npm run lint && npm test   # full local gate
node --test test/format.test.ts                 # one test file
npm run format                                  # biome check --write
npm run build                                   # bundle src/ into dist/ (prepack runs it)
npm start                                       # run the MCP server from source
npm run worker:dev                              # wrangler dev; optional .dev.vars can pin RIVIAN_EMAIL
npm run worker:types                            # regenerate worker/worker-configuration.d.ts after wrangler.jsonc changes
npx wrangler deploy --dry-run                   # build the Worker without deploying
```

Source and tests are TypeScript, run directly by Node's type stripping. Node does not strip types inside `node_modules`, so the published package ships the esbuild bundle in `dist/`.

## Architecture

| File                | Responsibility                                                                                                             |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `src/mcp-server.ts` | Stdio entry point using MCP SDK v2 and `serveStdio`; registers login and shared query tools. A TTY on stdin runs the CLI.  |
| `src/cli.ts`        | `ota` and `stats` terminal commands.                                                                                       |
| `src/prompt.ts`     | Masked password and OTP input.                                                                                             |
| `src/tools.ts`      | Seven live query tools shared by stdio and the Worker. `QueryContext` supplies the session and vehicle.                    |
| `src/rivian-api.ts` | Rivian GraphQL requests. API functions take `Session` first. Schema references come from `bretterer/rivian-python-client`. |
| `src/session.ts`    | Load, save and expire `~/.rivian-mcp/session.json`.                                                                        |
| `src/format.ts`     | Human-readable MCP and CLI responses.                                                                                      |
| `src/ui.ts`         | Terminal colors, progress bars, vehicle diagrams and tables.                                                               |

Every query tool sets `readOnlyHint: true`. The login tools `rivian_login` and `rivian_submit_otp` do not. Consult [.claude/skills/SKILL.md](.claude/skills/SKILL.md) for API endpoints, signatures and tested fields.

## Auth Flow

Local authentication stores session state in `~/.rivian-mcp/session.json`:

1. `createCsrfToken(session)` → `login(session, email, password)` → returns `{ mfa: true }` → OTP sent to user
2. `validateOtp(session, email, code)` → completes authentication; the caller saves the session
3. Later launches restore the session for up to 90 days. Rivian can expire it sooner.

Key headers: `Csrf-Token`, `A-Sess` (appSessionToken), `U-Sess` (userSessionToken).

## Environment

`RIVIAN_EMAIL` and `RIVIAN_PASSWORD` are passed as env vars in the MCP server config.

## Style

- Pure ESM (`"type": "module"`), TypeScript with explicit `.ts` import extensions (`allowImportingTsExtensions`, `erasableSyntaxOnly`). No enums, namespaces or parameter properties
- Biome: single quotes, no semicolons, 2 spaces, width 100
- Plain functions in the shared core; the Worker uses a `DurableObject` subclass
- GraphQL queries are inline template literals
- Shared query tools return readable text. Recorder tools also return structured data.
- Conventional commits are required: `feat:`, `fix:`, `chore:`, etc. Semantic-release uses these to determine version bumps and generate changelogs

## API Units & Values

- The API returns raw values with **no unit metadata**. `currentUser.settings.distanceUnit/temperatureUnit/pressureUnit` exist but may be `null`.
- `vehicleMileage` is in **meters** regardless of user setting (live: `47393698` = 47,394 km). Divide by 1000 for km. `distanceToEmpty` follows the user's in-vehicle distance setting.
- Round battery levels such as `48.600002` for display. Hide OTA placeholders: version `0.0.0`, an empty hash and zero progress.
- `cabinPreconditioningStatus` returns the string `"undefined"` when off. Filter it.

## Testing New Vehicle State Properties

Probe unknown fields one at a time via `getVehicleState(session, vehicleId, new Set(['fieldName']))`. The API returns `GRAPHQL_VALIDATION_FAILED` for non-existent fields and `null` for fields that exist but have no data. See `.claude/skills/references/vehicle-state-properties.md` for the full confirmed/rejected list.
External API docs: `../rivian-api/app/` (local clone of `kaedenbrinkman/rivian-api`).

## Adding New API Queries

1. Consult `.claude/skills/SKILL.md` for confirmed-working fields and what has already been tested
2. Add an exported function to `src/rivian-api.ts`
3. Gateway queries use `authHeaders()`, charging queries use `chargingHeaders()`
4. Use `vehicleState(id: $vehicleID)` for vehicle state. The variable is `vehicleID`, not `vehicleId`
5. Add formatting to `src/format.ts` and a shared query tool in `src/tools.ts`

## Cloudflare Worker (`worker/`)

Users deploy their own recorder with the Deploy to Cloudflare button or `npm run deploy`. See [docs/cloudflare.md](docs/cloudflare.md). The button creates a new GitHub repository, not a fork, and uses the `deploy` script to run D1 migrations.

Keep `wrangler.jsonc` at the repository root and free of account or resource IDs. Wrangler creates D1 and KV on the first deploy. Worker packages are `devDependencies` so npm users do not install them.

### Sign-in and ownership

`worker/src/index.ts` wraps `/mcp` in `@cloudflare/workers-oauth-provider`. Each request origin gets its own provider because the OAuth resource URL uses that origin. OAuth state lives in `OAUTH_KV`.

`oauth.ts` serves `/authorize` for password entry, then OTP entry. Only the owner's email can sign in. The optional `RIVIAN_EMAIL` secret pins the owner; otherwise the first accepted sign-in claims ownership. `logins.ts` stores the email as `owner` in Recorder storage. The secret is typed in `worker/src/env.d.ts`.

Both sign-in steps count against `LOGIN_LIMITER`. Pending sign-ins use separate `pending:<id>` entries, with a 10-minute TTL and a maximum of 5 entries (`pending.ts`). The recording session changes only after successful authentication. Users reconnect the connector when Rivian ends the session.

Do not add a password secret or a Worker login tool. Keep `.dev.vars.example` absent: the Deploy button would prompt for every secret it listed. Sign-in cookies use `__Host-` and `Secure`; browsers send them to `localhost`, but most HTTP clients do not.

### Recording

One `Recorder` Durable Object holds the Rivian websocket using `graphql-transport-ws`. Each vehicle has `parallaxMessages` and `vehicleState` subscriptions. The recorder writes drives and charging samples to D1. `drive.ts` contains the pure drive-state logic; `rivianSession()` supplies credentials to shared query tools.

Close code 4420 reconnects after 2 seconds. Codes 4401 and 4403 clear the session. Other errors back off from 10 seconds to 15 minutes. A 60-second alarm checks the connection. `parallax.ts` decodes base64 protobuf using field numbers from `bretterer/rivian-python-client`.

### Tools and views

| Module                       | Responsibility                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------- |
| `mcp.ts`                     | Shared queries, `recorder_status`, `list_drives`, `get_drive` and `export_drive`.                 |
| `enrich.ts`                  | Add places, energy and elevation to drive rows using `geocode.ts` and `battery.ts`.               |
| `export.ts`                  | Build `roadbook.drive/1`, GeoJSON and GPX. The schema is in [docs/roadbook.md](docs/roadbook.md). |
| `simplify.ts`, `timezone.ts` | Pure route and time helpers.                                                                      |
| `apps.ts`                    | Register `show_status`, `show_drive`, `show_stats` and `show_charging`.                           |
| `status.ts`                  | Build the `show_status` payload and text from live vehicle state. Pure.                           |
| `worker/ui/`                 | Render the MCP Apps views. `npm run worker:build` bundles them into `worker/dist/app.html`.       |

### Storage, tests and presentation

D1 migrations live in `worker/migrations/`. Timestamps are Unix epoch milliseconds. Add a new migration for each schema change; never edit an applied migration.

Worker modules import the core through relative paths such as `../../src/tools.ts`. Tests in `worker/test/` use mocked bindings for recorder and login behavior, and in-memory SQLite for D1 queries. Live Worker and Rivian behavior requires separate verification.

Keep the amber-on-forest-green palette consistent across `worker/ui/app.css`, `STYLE` in `worker/src/oauth.ts` and `src/ui.ts`. Do not use Rivian's logo, wordmark or brand colors. Sign-in pages must identify the project as unofficial.
