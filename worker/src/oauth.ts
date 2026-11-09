// OAuth sign-in for MCP clients such as claude.ai. The Worker is its own authorization server;
// its /authorize page signs in to Rivian with the existing Login and LoginWithOTP mutations.

import { waitUntil } from 'cloudflare:workers'
import {
  AuthorizationError,
  type AuthRequest,
  CimdFetchError,
  type OAuthHelpers,
} from '@cloudflare/workers-oauth-provider'
import { esc, merge } from './html.ts'
import { type FinishResult, type StartResult, sameEmail } from './logins.ts'
import { PENDING_TTL_MS } from './pending.ts'
import { SCOPE, USER_ID } from './provider.ts'

const recorder = (env: Env) => env.RECORDER.get(env.RECORDER.idFromName('default'))

const overLimit = async (env: Env, key: string) => !(await env.LOGIN_LIMITER.limit({ key })).success
const ipOverLimit = (request: Request, env: Env) =>
  overLimit(env, `ip:${request.headers.get('CF-Connecting-IP') ?? 'unknown'}`)

/** Both sign-in steps call Rivian, so both count against one global and one per-client limit. */
async function throttled(request: Request, env: Env): Promise<boolean> {
  const [global, client] = await Promise.all([overLimit(env, 'global'), ipOverLimit(request, env)])
  return global || client
}

const tooManyAttempts = () =>
  page('Too many attempts', '<p class="lead">Wait a minute, then start again from your app.</p>', {
    status: 429,
    headers: new Headers({ 'Retry-After': '60' }),
  })

export async function handleAuthorize(
  request: Request,
  env: Env,
  oauth: OAuthHelpers,
): Promise<Response> {
  const { pathname } = new URL(request.url)
  try {
    if (pathname === '/authorize' && request.method === 'GET') {
      return await signInPage(oauth, await oauth.parseAuthRequest(request))
    }
    if (pathname === '/authorize' && request.method === 'POST') {
      return await submitPassword(request, env, oauth)
    }
    if (pathname === '/authorize/otp' && request.method === 'POST') {
      return await submitOtp(request, env)
    }
    return new Response('Not found', { status: 404 })
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) {
      return Response.redirect(error.redirectTo, 302)
    }
    if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
      const message =
        error instanceof AuthorizationError ? error.description : 'This app could not be verified.'
      return failed(message)
    }
    throw error
  }
}

async function signInPage(
  oauth: OAuthHelpers,
  authRequest: AuthRequest,
  error?: string,
  headers?: Headers,
): Promise<Response> {
  const details = await oauth.describeConsent(authRequest)
  const consent = await oauth.beginConsent(authRequest)
  const publisher = details.clientDomain
    ? `Published by ${esc(details.clientDomain)}`
    : 'Self-registered. The name is not verified.'
  const loopback = details.redirectIsLoopback
    ? '<p class="note"><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</p>'
    : ''
  return page(
    `Allow ${details.clientName}?`,
    `<p class="lead"><strong>${esc(details.clientName)}</strong> wants read-only access to your recorded drives and charging sessions.</p>
<dl class="client">
  <dt>App</dt><dd>${esc(details.clientName)}<small>${publisher}</small></dd>
  <dt>Sends access to</dt><dd>${esc(details.redirectHost)}</dd>
</dl>
${loopback}${errorLine(error)}
<form method="post" action="/authorize">
  <input type="hidden" name="handle" value="${esc(consent.handle)}">
  <label>Rivian email <input name="email" type="email" autocomplete="username" autofocus required></label>
  <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
  <div class="actions">
    <button class="primary" name="decision" value="approve">Sign in and allow</button>
    <button class="secondary" name="decision" value="deny" formnovalidate>Deny</button>
  </div>
</form>
<p class="fine">Your password goes to Rivian only to sign in. This server does not store it.</p>`,
    { headers: merge(headers, consent.headers), step: 'Step 1 of 2 · Rivian account' },
  )
}

async function submitPassword(request: Request, env: Env, oauth: OAuthHelpers): Promise<Response> {
  const form = await request.formData()
  const handle = String(form.get('handle') ?? '')
  if (form.get('decision') !== 'approve') {
    const denied = await oauth.denyConsent(request, handle)
    return new Response(null, { status: 302, headers: denied.headers })
  }
  // Checks the browser binding first, so no other site can make this page call Rivian.
  const approved = await oauth.approveConsent(request, handle, { scope: [SCOPE] })
  // Before the email check, so guessing the owner's email costs attempts. Only the per-client
  // limit applies here: no Rivian call happens yet, so a wrong email must not use up the global one.
  if (await ipOverLimit(request, env)) return tooManyAttempts()
  const email = String(form.get('email') ?? '')
  // The Recorder holds one session, so only the owner may sign in. Before the first sign-in
  // there is no owner yet, and the first account Rivian accepts claims this Worker.
  const owner = await recorder(env).ownerEmail()
  if (owner && !sameEmail(owner, email)) {
    return signInPage(
      oauth,
      approved.request,
      'This server records a different Rivian account.',
      approved.headers,
    )
  }
  if (await overLimit(env, 'global')) return tooManyAttempts()
  // The code step completes the authorization from the Recorder, bound to this browser by a
  // cookie whose hash is stored with the pending login.
  const secret = randomSecret()
  const origin = new URL(request.url).origin
  const pending = { request: approved.request, origin, binding: await sha256Hex(secret) }
  let login: StartResult
  try {
    login = await recorder(env).startPendingLogin(
      email.trim(),
      String(form.get('password') ?? ''),
      pending,
    )
  } catch (error) {
    return signInPage(oauth, approved.request, rivianError(error), approved.headers)
  }
  if (login.result === 'logged_in') return complete(oauth, approved.request, approved.headers)
  const headers = new Headers(approved.headers)
  headers.append('Set-Cookie', bindingCookie(login.pendingId, secret))
  return otpPage(headers, login.pendingId)
}

/**
 * Safe to repeat. Safari can post the form twice when it fills the code from Messages, and it
 * drops the first request. Every post for one sign-in shares the Recorder's single code check
 * and gets the same redirect.
 */
async function submitOtp(request: Request, env: Env): Promise<Response> {
  const pendingId = new URL(request.url).searchParams.get('pending') ?? ''
  const secret = readCookie(request, cookieName(pendingId))
  if (!PENDING_ID.test(pendingId) || !secret) {
    return failed('This sign-in was not started in this browser.')
  }
  const headers = new Headers({ 'Cache-Control': 'no-store' })
  const form = await request.formData()
  const code = String(form.get('code') ?? '').trim()
  if (!/^\d{4,8}$/.test(code)) return otpPage(headers, pendingId, 'Enter the code from Rivian.')
  if (await throttled(request, env)) {
    return otpPage(headers, pendingId, 'Too many attempts. Wait a minute.')
  }
  const check = recorder(env).finishPendingLogin(pendingId, await sha256Hex(secret), code)
  // Lets the check finish after the browser drops this request; a repeated post picks it up.
  waitUntil(check.catch(() => {}))
  let finished: FinishResult
  try {
    finished = await check
  } catch (error) {
    return otpPage(headers, pendingId, rivianError(error))
  }
  if (finished.result === 'expired') {
    return failed('This sign-in expired or was started in another browser.')
  }
  headers.append('Set-Cookie', clearCookie(pendingId))
  headers.set('Location', finished.redirectTo)
  return new Response(null, { status: 302, headers })
}

function otpPage(headers: Headers, pendingId: string, error?: string): Response {
  return page(
    'Enter your Rivian code',
    `<p class="lead">Rivian sent a one-time code to your phone or email.</p>
${errorLine(error)}
<form method="post" action="/authorize/otp?pending=${encodeURIComponent(pendingId)}">
  <label>Code <input class="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="\\d{4,8}" maxlength="8" autofocus required></label>
  <div class="actions"><button class="primary">Verify and connect</button></div>
</form>`,
    { headers, step: 'Step 2 of 2 · One-time code' },
  )
}

async function complete(
  oauth: OAuthHelpers,
  authRequest: AuthRequest,
  headers: Headers,
): Promise<Response> {
  const { redirectTo } = await oauth.completeAuthorization({
    request: authRequest,
    userId: USER_ID,
    metadata: {},
    scope: [SCOPE],
    props: {},
  })
  headers.set('Location', redirectTo)
  return new Response(null, { status: 302, headers })
}

const failed = (message: string) =>
  page(
    'Sign-in failed',
    `<p class="lead">${esc(message)}</p><p class="lead">Start again from your app.</p>`,
    { status: 400 },
  )

/** `crypto.randomUUID()` in `Recorder.loginDeps`. Also keeps the cookie name valid. */
const PENDING_ID = /^[0-9a-f-]{36}$/
const cookieName = (pendingId: string) => `__Host-rivian-signin-${pendingId}`

function bindingCookie(pendingId: string, secret: string): string {
  const maxAge = PENDING_TTL_MS / 1000
  return `${cookieName(pendingId)}=${secret}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`
}

const clearCookie = (pendingId: string) =>
  `${cookieName(pendingId)}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`

function readCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
    const at = part.indexOf('=')
    if (at !== -1 && part.slice(0, at).trim() === name)
      return part.slice(at + 1).trim() || undefined
  }
  return undefined
}

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function rivianError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return `Rivian rejected the sign-in: ${message}`
}

const errorLine = (error?: string) =>
  error ? `<p class="error" role="alert">${esc(error)}</p>` : ''

function page(
  title: string,
  body: string,
  init: { status?: number; headers?: Headers; step?: string },
): Response {
  const headers = new Headers(init.headers)
  headers.set('Content-Type', 'text/html; charset=utf-8')
  headers.set(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  )
  headers.set('X-Frame-Options', 'DENY')
  headers.set('Cache-Control', 'no-store')
  const html = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(title)} · rivian-mcp</title>
<style>${STYLE}</style>
<main>
  <header class="brand">${MARK}<span>rivian-mcp</span></header>
  <section class="card">
    ${init.step ? `<p class="step">${esc(init.step)}</p>` : ''}<h1>${esc(title)}</h1>
    ${body}
  </section>
  <footer>Unofficial, self-hosted drive recorder. Not affiliated with or endorsed by Rivian.</footer>
</main>
</html>`
  return new Response(html, { status: init.status ?? 200, headers })
}

/** A route line over a ridge. Not a Rivian mark. */
const MARK = `<svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true">
<rect width="32" height="32" rx="8" style="fill: var(--green)"/>
<path d="M5 23 L12 13 L16 18 L20 11 L27 23" style="fill: none; stroke: var(--on-green)" stroke-opacity=".45" stroke-width="2" stroke-linejoin="round"/>
<path d="M6 26 C 11 26, 12 20, 17 21 S 23 25, 26 19" style="fill: none; stroke: var(--amber)" stroke-width="2.5" stroke-linecap="round"/>
</svg>`

/** Same trail palette as `ui/app.css`: amber on forest green, warm neutrals. */
const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #f8f6f1; --card: #fffdf9; --ink: #1c1f1b; --ink-2: #5b5f57; --line: #e6e2d8;
  --green: #24402f; --on-green: #fffdf9; --amber: #e0a12a; --ring: #2f5a40;
  --error-bg: #fbeae6; --error: #9b3a24;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #131614; --card: #1b1f1c; --ink: #eef0ea; --ink-2: #b3b8ae; --line: #2d332e;
    --green: #2f5a40; --on-green: #eef0ea; --amber: #f0b43c; --ring: #f0b43c;
    --error-bg: #3a1f18; --error: #f2b1a0;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 26rem; margin: 0 auto; padding: 3rem 1rem 2rem; }
.brand { display: flex; align-items: center; gap: .6rem; margin-bottom: 1.25rem; font-weight: 600; letter-spacing: .01em; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 1.5rem; box-shadow: 0 1px 2px rgb(0 0 0 / .04), 0 8px 24px rgb(0 0 0 / .05); }
h1 { font-size: 1.35rem; line-height: 1.25; margin: 0 0 .75rem; }
.step { margin: 0 0 .25rem; font-size: .8rem; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-2); }
.lead { margin: 0 0 1rem; color: var(--ink-2); }
.lead strong { color: var(--ink); }
.client { display: grid; grid-template-columns: auto 1fr; gap: .35rem 1rem; margin: 0 0 1rem; padding: .75rem 1rem; border-radius: 10px; background: var(--bg); font-size: .9rem; }
.client dt { color: var(--ink-2); }
.client dd { margin: 0; overflow-wrap: anywhere; font-weight: 500; }
.client small { display: block; font-weight: 400; color: var(--ink-2); }
.note { margin: 0 0 1rem; font-size: .9rem; }
.error { margin: 0 0 1rem; padding: .6rem .8rem; border-radius: 8px; background: var(--error-bg); color: var(--error); font-size: .9rem; }
label { display: block; margin: 0 0 .9rem; font-size: .9rem; font-weight: 500; }
input { display: block; width: 100%; margin-top: .3rem; padding: .65rem .75rem; font: inherit; font-weight: 400; color: var(--ink); background: var(--card); border: 1px solid var(--line); border-radius: 8px; }
input.code { font-size: 1.4rem; letter-spacing: .3em; text-align: center; font-variant-numeric: tabular-nums; }
input:focus-visible, button:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
.actions { display: flex; flex-wrap: wrap; gap: .5rem; margin-top: 1.25rem; }
button { font: inherit; font-weight: 600; padding: .65rem 1.1rem; border-radius: 8px; cursor: pointer; }
.primary { flex: 1; background: var(--green); color: var(--on-green); border: 1px solid var(--green); }
.primary:hover { filter: brightness(1.1); }
.secondary { background: transparent; color: var(--ink); border: 1px solid var(--line); }
.secondary:hover { background: var(--bg); }
.fine { margin: 1rem 0 0; font-size: .8rem; color: var(--ink-2); }
footer { margin-top: 1.25rem; font-size: .8rem; color: var(--ink-2); text-align: center; }
`
