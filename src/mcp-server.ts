#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'
import * as rivian from './rivian-api.ts'
import { loadSession, saveSession } from './session.ts'
import { errorText, registerQueryTools, text } from './tools.ts'

const session = rivian.emptySession()

function requireAuth() {
  if (!rivian.isAuthenticated(session)) {
    throw new Error('Not logged in. Ask the user to log in to Rivian first.')
  }
}

// ── Vehicle ID resolution ─────────────────────────────────────────────

let cachedVehicleId: string | null = null

async function resolveVehicleId() {
  if (cachedVehicleId) return cachedVehicleId
  const user = await rivian.getUserInfo(session)
  if (!user.vehicles?.length) {
    throw new Error('No vehicles found on your Rivian account.')
  }
  cachedVehicleId = user.vehicles[0].id
  return cachedVehicleId
}

// ── MCP Server ────────────────────────────────────────────────────────

function createServer() {
  const server = new McpServer({
    name: 'rivian',
    version: '1.0.0',
  })

  // ── Auth tools ──────────────────────────────────────────────────────

  server.registerTool(
    'rivian_login',
    {
      description: [
        'Sign in to Rivian with the RIVIAN_EMAIL and RIVIAN_PASSWORD set in the MCP server',
        'configuration. Call it when no session is saved or after the session expires; a saved',
        'session is restored on launch. Takes no arguments. Replaces the current session and saves it to',
        '~/.rivian-mcp/session.json. When Rivian requires two-step verification, it sends a code to',
        'your phone or email and the sign-in stays pending until you pass the code to',
        'rivian_submit_otp. Returns a message saying either that you are signed in or that a code was',
        'sent, and an error if the credentials are missing or Rivian rejects them.',
      ].join(' '),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async () => {
      const email = process.env.RIVIAN_EMAIL
      const password = process.env.RIVIAN_PASSWORD
      if (!email || !password) {
        return errorText(
          'Rivian credentials are not configured. Set RIVIAN_EMAIL and RIVIAN_PASSWORD in your MCP server settings.',
        )
      }

      try {
        await rivian.createCsrfToken(session)
        const { mfa } = await rivian.login(session, email, password)
        saveSession(session)
        cachedVehicleId = null

        if (mfa) {
          return text(
            "A verification code has been sent to your phone or email. Tell me the code and I'll complete the sign-in.",
          )
        }

        return text('Signed in to Rivian.')
      } catch (err) {
        return errorText(`Couldn't sign in: ${(err as Error).message}`)
      }
    },
  )

  server.registerTool(
    'rivian_submit_otp',
    {
      description: [
        'Finish a Rivian sign-in with the verification code Rivian sent to your phone or email. Use it',
        'only after rivian_login reported that a code was sent; without a pending sign-in it returns',
        'an error and asks you to call rivian_login. On success it saves the session to',
        '~/.rivian-mcp/session.json. Uses the RIVIAN_EMAIL set in the MCP server configuration.',
        'Returns a message saying you are signed in, or an error if Rivian rejects the code.',
      ].join(' '),
      inputSchema: z.object({
        otp_code: z
          .string()
          .describe(
            'The verification code exactly as Rivian sent it, as a string, for example "123456". Do not include spaces.',
          ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ otp_code }) => {
      const email = process.env.RIVIAN_EMAIL
      if (!email) {
        return errorText('RIVIAN_EMAIL is not configured.')
      }

      if (!rivian.needsOtp(session)) {
        return errorText('No verification is pending. Call rivian_login first.')
      }

      try {
        await rivian.validateOtp(session, email, otp_code)
        saveSession(session)
        cachedVehicleId = null
        return text('Signed in to Rivian.')
      } catch (err) {
        return errorText(
          `Verification failed: ${(err as Error).message}. You may need to start over with rivian_login.`,
        )
      }
    },
  )

  registerQueryTools(server, {
    session: async () => {
      requireAuth()
      return session
    },
    vehicleId: resolveVehicleId,
  })

  return server
}

// ── Start ─────────────────────────────────────────────────────────────

// A terminal on stdin means a person ran `rivian-mcp`, not an MCP client: run the CLI instead
if (process.stdin.isTTY) {
  await import('./cli.ts')
} else {
  try {
    loadSession(session)
  } catch (err) {
    console.error(
      `[rivian-mcp] Failed to restore session, starting unauthenticated: ${(err as Error).message}`,
    )
  }

  serveStdio(createServer)
}
