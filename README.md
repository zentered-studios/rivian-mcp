# Rivian MCP

Ask Claude or ChatGPT about your Rivian and every drive you take. It runs in your own Cloudflare account, so your data stays with you.

It only reads from Rivian. It sends no commands to your vehicle and changes no settings. This project is unofficial and not affiliated with or endorsed by Rivian.

## Self-host on Cloudflare

You need:

- A free [Cloudflare](https://dash.cloudflare.com/sign-up) account.
- Your Rivian email and password, and the phone or email that gets Rivian's one-time code.

The Deploy button also asks you to connect a GitHub account. Cloudflare keeps your copy of the project there. To skip GitHub, [deploy from a terminal](docs/cloudflare.md#set-it-up-from-a-terminal-instead) with Node.js 24.

### 1. Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/PatrickHeneise/rivian-mcp)

1. Select the button and sign in to Cloudflare.
2. Enter your Rivian email in `RIVIAN_EMAIL`. Only this email can sign in to your copy.
3. Select **Create and deploy**.

Cloudflare creates the storage and starts the server. It shows your address:

```text
https://rivian-mcp.<your-name>.workers.dev
```

Your connector address is that address plus `/mcp`:

```text
https://rivian-mcp.<your-name>.workers.dev/mcp
```

### 2. Connect Claude

Works on claude.ai and in the Claude desktop and mobile apps.

1. Open **Settings**, then **Connectors**, then **Add custom connector**.
2. Name it `Rivian` and paste your connector address.
3. Select **Add**, then **Connect**.
4. Sign in with your Rivian email and password, then enter the one-time code Rivian sends you.

Recording starts as soon as you are signed in. In a new chat, ask "Is the recorder running?"

ChatGPT works through its developer mode connectors. I have not tested it. See [Connect ChatGPT](docs/cloudflare.md#connect-chatgpt).

### What you can ask

- "Show my last drive."
- "List my drives this week."
- "Show my stats for the last 30 days."
- "Show my charging sessions."
- "What's my battery level?"
- "Is there a software update available?"
- "Are all the doors locked?"

### Tools

| Tool                           | What it does                                                        |
| ------------------------------ | ------------------------------------------------------------------- |
| `show_drive`                   | One drive with its route map and speed, energy and elevation charts |
| `show_stats`                   | Totals and efficiency for a period, with every route on one map     |
| `show_charging`                | Charging sessions with energy added, power and battery level curves |
| `list_drives`                  | Recorded drives, newest first                                       |
| `get_drive`                    | One drive with its route as GeoJSON                                 |
| `recorder_status`              | Whether the recorder is signed in and connected                     |
| `rivian_get_user_info`         | Your account, vehicles and software versions                        |
| `rivian_get_vehicle_state`     | Live battery, doors, tires, location, climate and OTA status        |
| `rivian_get_ota_status`        | Current and available software versions                             |
| `rivian_get_charging_session`  | Active charging session                                             |
| `rivian_get_charging_history`  | Past charging sessions with energy, cost and location               |
| `rivian_get_charging_schedule` | Your charging schedule                                              |
| `rivian_get_drivers_and_keys`  | Drivers and their phone keys and key fobs                           |

Cost, updates, where your data lives and how to remove it are in [docs/cloudflare.md](docs/cloudflare.md).

## Run it locally

The npm package runs on your computer as a CLI or a local MCP server. It needs Node.js 24 or newer. It answers questions about your Rivian as it is now. It does not record drives, because it only runs while you use it.

### CLI

```bash
npx rivian-mcp ota    # software update status
npx rivian-mcp stats  # full vehicle state
```

Or install it globally:

```bash
npm install -g rivian-mcp
rivian ota
rivian stats
```

The CLI reads `RIVIAN_EMAIL` and `RIVIAN_PASSWORD` from the environment, or asks for them.

### Local MCP server

```bash
claude mcp add rivian \
  -e RIVIAN_EMAIL=your@email.com \
  -e RIVIAN_PASSWORD=your-password \
  -- npx rivian-mcp
```

<details>
<summary>Manual config</summary>

Add to `~/.claude.json` or your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "rivian": {
      "command": "npx",
      "args": ["rivian-mcp"],
      "env": {
        "RIVIAN_EMAIL": "your@email.com",
        "RIVIAN_PASSWORD": "your-password"
      }
    }
  }
}
```

</details>

Rivian asks for a one-time code on every new sign-in:

1. Ask Claude, "Log in to Rivian."
2. Rivian sends a code to your phone or email.
3. Tell Claude, "The code is 123456."

The local server adds `rivian_login` and `rivian_submit_otp` for this step. The CLI and the local server share the session in `~/.rivian-mcp/session.json`. It is reused for up to 90 days.

## Support

If you are thinking about getting a Rivian, my referral code gets you benefits on your purchase and supports this project:

[Get a Rivian R1 with referral benefits](https://rivian.com/configurations/list?reprCode=PATRICK4568756)

## Development

The Claude Code plugin teaches Claude this codebase and the Rivian API: confirmed vehicle state fields, the auth flow and the formatters.

```bash
claude /plugin marketplace add PatrickHeneise/rivian-mcp
claude /plugin install rivian-mcp@rivian-ai
```

## References

- [Rivian API Docs](https://rivian-api.kaedenb.org/app/), community-maintained
- [rivian-python-client](https://github.com/bretterer/rivian-python-client), the Python client this is based on
- [home-assistant-rivian](https://github.com/bretterer/home-assistant-rivian), the Home Assistant integration
