// OAuth provider options, shared by the Worker entry point and the Recorder. The Recorder
// completes sign-ins that needed a code, so both must describe the same authorization server.

import {
  type AuthRequest,
  getOAuthApi,
  type OAuthProviderOptions,
} from '@cloudflare/workers-oauth-provider'

/** The one scope this server grants. */
export const SCOPE = 'mcp'
/** Every grant belongs to the one owner account (`ownerEmail` in logins.ts). */
export const USER_ID = 'owner'

/** An `ExportedHandler` with `fetch`, the shape both `apiHandler` and `defaultHandler` accept. */
type Handler = { fetch: ExportedHandlerFetchHandler<Env> }

/** One set of options per origin, since the OAuth resource URL is the Worker's own address. */
export function providerOptions(
  origin: string,
  apiHandler: Handler,
  defaultHandler: Handler,
): OAuthProviderOptions<Env> {
  return {
    apiRoute: '/mcp',
    apiHandler,
    defaultHandler,
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/oauth/token',
    clientRegistrationEndpoint: '/oauth/register',
    scopesSupported: [SCOPE],
    requiredScopes: [SCOPE],
    resourceMetadata: { resource: `${origin}/mcp`, resource_name: 'Rivian' },
  }
}

/** Completion never routes requests, so these handlers are never called. */
const unused = { fetch: () => new Response('Not found', { status: 404 }) } satisfies Handler

/** Issues the authorization code for an approved request. Returns the client redirect. */
export async function completeSignIn(
  env: Env,
  origin: string,
  request: AuthRequest,
): Promise<string> {
  const oauth = getOAuthApi(providerOptions(origin, unused, unused), env)
  const { redirectTo } = await oauth.completeAuthorization({
    request,
    userId: USER_ID,
    metadata: {},
    scope: [SCOPE],
    props: {},
  })
  return redirectTo
}
