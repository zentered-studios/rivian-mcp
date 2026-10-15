// Prints the Worker's MCP `tools/list` result as JSON. Needs no Rivian credentials, Cloudflare
// bindings or network: tool registration only reads `env` inside the handlers.
// Usage: node scripts/dump-worker-tools.ts [output.json]
import { mkdir, writeFile } from 'node:fs/promises'
import { build } from 'esbuild'

const dir = 'node_modules/.cache/dump-worker-tools'
await mkdir(dir, { recursive: true })
// The app view is a build artifact the handlers serve; tool metadata does not need it.
const emptyHtml = {
  name: 'empty-html',
  setup(b: import('esbuild').PluginBuild) {
    b.onResolve({ filter: /\.html$/ }, (args) => ({ path: args.path, namespace: 'empty-html' }))
    b.onLoad({ filter: /.*/, namespace: 'empty-html' }, () => ({
      contents: 'export default ""',
      loader: 'js',
    }))
  },
}
await build({
  stdin: {
    contents: `
      import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
      import { registerApps } from '../../../worker/src/apps.ts'
      import { registerTools } from '../../../worker/src/mcp.ts'
      const env = {}
      const handler = createMcpHandler(() => {
        const server = new McpServer({ name: 'rivian-mcp', version: '1.0.0' })
        registerTools(server, env)
        registerApps(server, env)
        return server
      }, { responseMode: 'json' })
      const response = await handler.fetch(new Request('https://tdqs.invalid/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      }))
      const body = await response.text()
      // The handler may answer as plain JSON or as one server-sent event.
      const data = body.startsWith('{') ? body : body.split('\\n').find((l) => l.startsWith('data:'))?.slice(5)
      const { result, error } = JSON.parse(data ?? 'null') ?? {}
      if (error || !result?.tools) throw new Error('tools/list failed: ' + JSON.stringify(error ?? result))
      export default result
    `,
    resolveDir: dir,
    sourcefile: 'entry.ts',
    loader: 'ts',
  },
  outfile: `${dir}/entry.mjs`,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  packages: 'external',
  plugins: [emptyHtml],
})
const { default: result } = await import(`${process.cwd()}/${dir}/entry.mjs`)
const json = `${JSON.stringify({ tools: result.tools }, null, 2)}\n`
const out = process.argv[2]
if (out) await writeFile(out, json)
else process.stdout.write(json)
