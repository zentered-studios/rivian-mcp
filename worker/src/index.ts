import { type OAuthHelpers, OAuthProvider } from '@cloudflare/workers-oauth-provider'
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import { registerApps } from './apps.ts'
import { registerTools } from './mcp.ts'
import { handleAuthorize } from './oauth.ts'
import { providerOptions } from './provider.ts'

export { Recorder } from './recorder.ts'

/** Serves /mcp to a request that already carries a valid token. */
const mcpHandler = {
  fetch(request, env) {
    const handler = createMcpHandler(
      () => {
        const server = new McpServer({ name: 'rivian-mcp', version: '1.0.0' })
        registerTools(server, env)
        registerApps(server, env)
        return server
      },
      { responseMode: 'json' },
    )
    return handler.fetch(request)
  },
} satisfies ExportedHandler<Env>

/** One provider per origin, since the OAuth resource URL is the Worker's own address. */
const providers = new Map<string, OAuthProvider<Env>>()

function oauthProvider(origin: string): OAuthProvider<Env> {
  let provider = providers.get(origin)
  if (!provider) {
    provider = new OAuthProvider<Env>(
      providerOptions(origin, mcpHandler, {
        fetch: (request, env) =>
          handleAuthorize(
            request,
            env,
            (env as Env & { OAUTH_PROVIDER: OAuthHelpers }).OAUTH_PROVIDER,
          ),
      }),
    )
    providers.set(origin, provider)
  }
  return provider
}

export default {
  fetch: (request, env, ctx) => oauthProvider(new URL(request.url).origin).fetch(request, env, ctx),
} satisfies ExportedHandler<Env>
