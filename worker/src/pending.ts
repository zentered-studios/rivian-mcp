// Pending Rivian logins: each OAuth sign-in that needs an OTP keeps its own session until the
// code is verified, so overlapping or abandoned sign-ins never touch the recording session.

import type { AuthRequest } from '@cloudflare/workers-oauth-provider'
import type { Session } from '../../src/rivian-api.ts'

export const PENDING_PREFIX = 'pending:'
/** Rivian's OTP token expires well before this. */
export const PENDING_TTL_MS = 10 * 60_000
/** Oldest entries go first when more sign-ins than this are waiting. */
export const PENDING_MAX = 5

export interface PendingLogin {
  session: Session
  /** The email typed at sign-in. The code check and the owner claim use it. */
  email: string
  createdAt: number
  /** The OAuth sign-in this login belongs to. Entries from before it was stored are expired. */
  oauth?: PendingAuthorization
  /** SHA-256 hex of the code Rivian accepted. A later submission must carry the same code. */
  verifiedCode?: string
  /** Set once the session is the recording session. `session` is then empty. */
  activated?: boolean
  /** Set once the authorization code is issued: a repeated submission gets the same redirect. */
  redirectTo?: string
}

export interface PendingAuthorization {
  /** The request `approveConsent()` validated at the password step. */
  request: AuthRequest
  /** The Worker origin, which names the OAuth resource. */
  origin: string
  /** SHA-256 hex of the secret in the browser's sign-in cookie. */
  binding: string
}

/** Storage keys to delete: expired entries, then the oldest beyond `PENDING_MAX - 1`, which makes room for one more. */
export function pendingToDrop(entries: Map<string, PendingLogin>, now: number): string[] {
  const live: [string, PendingLogin][] = []
  const drop: string[] = []
  for (const entry of entries) {
    if (now - entry[1].createdAt >= PENDING_TTL_MS) drop.push(entry[0])
    else live.push(entry)
  }
  live.sort((a, b) => a[1].createdAt - b[1].createdAt)
  for (const [key] of live.slice(0, Math.max(0, live.length - (PENDING_MAX - 1)))) drop.push(key)
  return drop
}

export function isPendingFresh(pending: PendingLogin, now: number): boolean {
  return now - pending.createdAt < PENDING_TTL_MS
}
