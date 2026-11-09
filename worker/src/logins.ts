// Session isolation for sign-ins that need an OTP. Pure: storage and the Rivian calls are
// injected, so tests run without Workers. A sign-in works on its own pending session. The
// recording session is written only by `activate`, and only after Rivian accepted the login.

import type { Session } from '../../src/rivian-api.ts'
import {
  isPendingFresh,
  PENDING_PREFIX,
  type PendingAuthorization,
  type PendingLogin,
  pendingToDrop,
} from './pending.ts'

export interface LoginStore {
  get(key: string): Promise<PendingLogin | undefined>
  put(key: string, value: PendingLogin): Promise<void>
  delete(keys: string | string[]): Promise<unknown>
  list(prefix: string): Promise<Map<string, PendingLogin>>
}

export interface LoginDeps {
  store: LoginStore
  /** Logs in to a fresh session. Returns true when Rivian sent an OTP. */
  login(session: Session, email: string, password: string): Promise<boolean>
  validateOtp(session: Session, email: string, code: string): Promise<void>
  /** Makes a verified session the recording session. Throws when `email` is not the owner. */
  activate(session: Session, email: string): Promise<void>
  /** Issues the OAuth authorization code. Returns the client redirect. */
  complete(oauth: PendingAuthorization): Promise<string>
  newSession(): Session
  now(): number
  newId(): string
  /** The code check running for each pending id. */
  inFlight: Map<string, CodeCheck>
}

export interface CodeCheck {
  code: string
  binding: string
  result: Promise<FinishResult>
}

export type StartResult = { result: 'logged_in' } | { result: 'otp_sent'; pendingId: string }

/**
 * `expired`: the sign-in is gone, belongs to another browser, or predates the stored request.
 * `other_code`: this sign-in is checking, or already accepted, a different code.
 * `retry`: the code was accepted but the authorization could not be issued; the same code
 * resumes the sign-in.
 */
export type FinishResult =
  | { result: 'done'; redirectTo: string }
  | { result: 'expired' }
  | { result: 'other_code' }
  | { result: 'retry' }

export async function startPending(
  deps: LoginDeps,
  email: string,
  password: string,
  oauth: PendingAuthorization,
): Promise<StartResult> {
  const session = deps.newSession()
  const needsOtp = await deps.login(session, email, password)
  if (!needsOtp) {
    await deps.activate(session, email)
    return { result: 'logged_in' }
  }
  const now = deps.now()
  await deps.store.delete(pendingToDrop(await deps.store.list(PENDING_PREFIX), now))
  const pendingId = deps.newId()
  await deps.store.put(`${PENDING_PREFIX}${pendingId}`, { session, email, createdAt: now, oauth })
  return { result: 'otp_sent', pendingId }
}

/**
 * Verifies the code, activates the session and issues the authorization code, once per sign-in.
 * Browsers can submit the code form twice, for example when Safari fills the code from Messages.
 * A submission that arrives while a check runs waits for that check and gets its result. Each
 * step is stored, so a later submission of the same code resumes where the last one stopped:
 * after success it gets the stored redirect. A wrong code throws and keeps the pending session
 * for another try.
 */
export async function finishPending(
  deps: LoginDeps,
  pendingId: string,
  binding: string,
  code: string,
): Promise<FinishResult> {
  const running = deps.inFlight.get(pendingId)
  if (running) {
    if (!sameDigest(running.binding, binding)) return { result: 'expired' }
    if (running.code !== code) return { result: 'other_code' }
    return running.result
  }
  // Registered before the first await, so a concurrent call always finds it.
  const result = checkCode(deps, pendingId, binding, code).finally(() =>
    deps.inFlight.delete(pendingId),
  )
  deps.inFlight.set(pendingId, { code, binding, result })
  return result
}

async function checkCode(
  deps: LoginDeps,
  pendingId: string,
  binding: string,
  code: string,
): Promise<FinishResult> {
  const key = `${PENDING_PREFIX}${pendingId}`
  const stored = await deps.store.get(key)
  // Entries stored before the sign-in request was kept have no `oauth`.
  if (!stored?.oauth || !isPendingFresh(stored, deps.now())) {
    await deps.store.delete(key)
    return { result: 'expired' }
  }
  const { oauth } = stored
  if (!sameDigest(oauth.binding, binding)) return { result: 'expired' }
  const codeHash = await sha256Hex(code)
  if (stored.verifiedCode && !sameDigest(stored.verifiedCode, codeHash)) {
    return { result: 'other_code' }
  }
  let entry: PendingLogin = stored
  if (!entry.verifiedCode) {
    // Rivian accepts a code once, so the verified session is stored before the next step.
    await deps.validateOtp(entry.session, entry.email, code)
    entry = { ...entry, verifiedCode: codeHash }
    await deps.store.put(key, entry)
  }
  if (!entry.activated) {
    try {
      await deps.activate(entry.session, entry.email)
    } catch (error) {
      await deps.store.delete(key)
      throw error
    }
    // The Rivian session now lives in the recorder.
    entry = { ...entry, session: deps.newSession(), activated: true }
    await deps.store.put(key, entry)
  }
  let { redirectTo } = entry
  if (!redirectTo) {
    try {
      redirectTo = await deps.complete(oauth)
    } catch (error) {
      console.error('Sign-in authorization failed', error)
      return { result: 'retry' }
    }
    await deps.store.put(key, { ...entry, redirectTo })
  }
  return { result: 'done', redirectTo }
}

/** Constant-time comparison of two hex digests. */
function sameDigest(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Rivian emails compare without case or surrounding spaces. */
export const sameEmail = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

/**
 * The owner email: `RIVIAN_EMAIL` when set, else the one the first accepted sign-in claimed.
 * Null until the first sign-in.
 */
export const ownerEmail = (configured: string | undefined, claimed: string | undefined) =>
  configured?.trim() || claimed || null

/** True when a session exists but vehicle discovery never succeeded. */
export function needsVehicleDiscovery(session: Session, vehicleCount: number): boolean {
  return Boolean(session.userSessionToken) && vehicleCount === 0
}

export interface RecoveryDeps {
  session(): Promise<Session>
  storedVehicleCount(): Promise<number>
  /** Fetches vehicles and stores them. */
  discoverVehicles(session: Session): Promise<void>
  hasSocket(): boolean
  openSocket(): Promise<void>
  clearError(): void
  /** Records the error and schedules a retry. */
  fail(error: unknown): Promise<void>
}

/** The alarm's reconnect step: find vehicles if a login never got them, then open the socket. */
export async function recoverConnection(deps: RecoveryDeps): Promise<void> {
  const session = await deps.session()
  if (needsVehicleDiscovery(session, await deps.storedVehicleCount())) {
    try {
      await deps.discoverVehicles(session)
      deps.clearError()
    } catch (error) {
      await deps.fail(error)
      return
    }
  }
  if (!deps.hasSocket()) await deps.openSocket()
}
