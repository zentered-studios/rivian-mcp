import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider'
import './support/cloudflare-stub.ts'

const { handleAuthorize } = await import('../src/oauth.ts')
type FinishResult = import('../src/logins.ts').FinishResult
type PendingAuthorization = import('../src/pending.ts').PendingAuthorization

const OWNER = 'owner@example.com'

const PENDING_ID = '0b5e7c1a-2f3d-4e5f-8a9b-0c1d2e3f4a5b'
const COOKIE = `__Host-rivian-signin-${PENDING_ID}`

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function setup(
  opts: {
    limited?: boolean
    start?: object
    finish?: FinishResult
    finishError?: Error
    owner?: string | null
  } = {},
) {
  const calls: string[] = []
  const started: PendingAuthorization[] = []
  const bindings: string[] = []
  const recorder = {
    ownerEmail: async () => (opts.owner === undefined ? OWNER : opts.owner),
    startPendingLogin: async (email: string, _password: string, oauth: PendingAuthorization) => {
      calls.push(`startPendingLogin ${email}`)
      started.push(oauth)
      return opts.start ?? { result: 'otp_sent', pendingId: PENDING_ID }
    },
    finishPendingLogin: async (pendingId: string, binding: string, code: string) => {
      calls.push(`finishPendingLogin ${pendingId} ${code}`)
      bindings.push(binding)
      if (opts.finishError) throw opts.finishError
      return opts.finish ?? { result: 'done', redirectTo: 'https://claude.ai/callback?code=c' }
    },
  }
  const env = {
    RECORDER: { idFromName: () => 'id', get: () => recorder },
    LOGIN_LIMITER: { limit: async () => ({ success: !opts.limited }) },
  }
  const authRequest = { clientId: 'c' }
  const oauth = {
    describeConsent: async () => ({
      clientName: 'Claude',
      clientDomain: 'claude.ai',
      redirectIsLoopback: false,
      redirectHost: 'claude.ai',
    }),
    beginConsent: async () => ({ handle: 'h', headers: new Headers() }),
    approveConsent: async () => ({ request: authRequest, headers: new Headers() }),
    denyConsent: async () => ({ headers: new Headers({ Location: 'https://claude.ai/denied' }) }),
    completeAuthorization: async () => ({ redirectTo: 'https://claude.ai/callback' }),
  }
  const post = (path: string, fields: Record<string, string>, cookie?: string) =>
    handleAuthorize(
      new Request(`https://worker.test${path}`, {
        method: 'POST',
        body: new URLSearchParams(fields),
        headers: cookie ? { Cookie: cookie } : {},
      }),
      env as never,
      oauth as unknown as OAuthHelpers,
    )
  /** Posts a code from the browser that passed the password step. */
  const postCode = (code: string, secret = 'secret') =>
    post(`/authorize/otp?pending=${PENDING_ID}`, { code }, `other=1; ${COOKIE}=${secret}`)
  return { calls, started, bindings, post, postCode }
}

const password = (email: string) => ({
  handle: 'h',
  decision: 'approve',
  email,
  password: 'pw',
})

test('a wrong email is rejected without calling Rivian', async () => {
  const t = setup()
  const res = await t.post('/authorize', password('other@example.com'))
  assert.equal(res.status, 200)
  assert.match(await res.text(), /records a different Rivian account/)
  assert.deepEqual(t.calls, [])
})

test('a wrong email counts against the rate limit', async () => {
  const t = setup({ limited: true })
  const res = await t.post('/authorize', password('other@example.com'))
  assert.equal(res.status, 429)
})

test('a throttled sign-in does not call Rivian', async () => {
  const t = setup({ limited: true })
  const res = await t.post('/authorize', password(OWNER))
  assert.equal(res.status, 429)
  assert.deepEqual(t.calls, [])
})

test('the owner email is matched ignoring case and spaces, and asks for the code', async () => {
  const t = setup()
  const res = await t.post('/authorize', password(` ${OWNER.toUpperCase()} `))
  assert.match(await res.text(), /Enter your Rivian code/)
  assert.deepEqual(t.calls, [`startPendingLogin ${OWNER.toUpperCase()}`])
})

test('the code page binds the sign-in to this browser with a cookie', async () => {
  const t = setup()
  const res = await t.post('/authorize', password(OWNER))
  const html = await res.text()
  assert.match(html, new RegExp(`action="/authorize/otp\\?pending=${PENDING_ID}"`))
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE}=`))
  assert.ok(cookie, 'sets the sign-in cookie')
  assert.match(cookie, /; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=600$/)
  const secret = cookie.slice(COOKIE.length + 1, cookie.indexOf(';'))
  assert.match(secret, /^[\w-]{43}$/)
  // The Recorder keeps the approved request, this origin and only the cookie's hash.
  assert.deepEqual(t.started, [
    { request: { clientId: 'c' }, origin: 'https://worker.test', binding: await sha256Hex(secret) },
  ])
})

test('with no owner yet, any email reaches Rivian to claim the server', async () => {
  const t = setup({ owner: null })
  const res = await t.post('/authorize', password('new@example.com'))
  assert.match(await res.text(), /Enter your Rivian code/)
  assert.deepEqual(t.calls, ['startPendingLogin new@example.com'])
})

test('a login without a code completes the authorization', async () => {
  const t = setup({ start: { result: 'logged_in' } })
  const res = await t.post('/authorize', password(OWNER))
  assert.equal(res.status, 302)
  assert.equal(res.headers.get('Location'), 'https://claude.ai/callback')
})

test('a denied consent redirects without calling Rivian', async () => {
  const t = setup()
  const res = await t.post('/authorize', { handle: 'h', decision: 'deny' })
  assert.equal(res.status, 302)
  assert.deepEqual(t.calls, [])
})

test('a wrong code shows the error and keeps the same sign-in', async () => {
  const t = setup({ finishError: new Error('bad code') })
  const res = await t.postCode('123456')
  assert.equal(res.status, 200)
  const html = await res.text()
  assert.match(html, /Rivian rejected the sign-in: bad code/)
  assert.match(html, new RegExp(`action="/authorize/otp\\?pending=${PENDING_ID}"`))
})

test('a malformed code never reaches Rivian', async () => {
  const t = setup()
  const res = await t.postCode('abc')
  assert.match(await res.text(), /Enter the code from Rivian/)
  assert.deepEqual(t.calls, [])
})

test('a throttled code check never reaches Rivian', async () => {
  const t = setup({ limited: true })
  const res = await t.postCode('123456')
  assert.match(await res.text(), /Too many attempts/)
  assert.deepEqual(t.calls, [])
})

test('a right code redirects to the client and clears the sign-in cookie', async () => {
  const t = setup()
  const res = await t.postCode(' 123456 ', 'secret')
  assert.equal(res.status, 302)
  assert.equal(res.headers.get('Location'), 'https://claude.ai/callback?code=c')
  assert.deepEqual(res.headers.getSetCookie(), [
    `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`,
  ])
  assert.deepEqual(t.calls, [`finishPendingLogin ${PENDING_ID} 123456`])
  assert.deepEqual(t.bindings, [await sha256Hex('secret')])
})

test('a repeated code post redirects too', async () => {
  const t = setup()
  const [first, second] = await Promise.all([t.postCode('123456'), t.postCode('123456')])
  assert.equal(first.headers.get('Location'), second.headers.get('Location'))
  assert.equal(second.status, 302)
})

test('a code post without the sign-in cookie never reaches Rivian', async () => {
  const t = setup()
  const res = await t.post(`/authorize/otp?pending=${PENDING_ID}`, { code: '123456' })
  assert.equal(res.status, 400)
  assert.match(await res.text(), /not started in this browser/)
  assert.deepEqual(t.calls, [])
})

test('a code post with a malformed pending id never reaches Rivian', async () => {
  const t = setup()
  const res = await t.post(
    '/authorize/otp?pending=x',
    { code: '123456' },
    '__Host-rivian-signin-x=s',
  )
  assert.equal(res.status, 400)
  assert.deepEqual(t.calls, [])
})

test('an expired sign-in or another browser ends on the failure page', async () => {
  const t = setup({ finish: { result: 'expired' } })
  const res = await t.postCode('123456')
  assert.equal(res.status, 400)
  assert.match(await res.text(), /expired or was started in another browser/)
})
