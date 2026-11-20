import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterEach, describe, expect, it } from 'vitest'

// The server as Claude Code and Claude Desktop start it, from the build.
const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'node', 'mcp.js')
let client: Client | null = null

afterEach(async () => {
  await client?.close()
  client = null
})

async function connect(dir: string): Promise<Client> {
  client = new Client({ name: 'avow-test', version: '0.0.0' })
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [SERVER, '--dir', dir],
      stderr: 'ignore',
    }),
  )
  return client
}

describe('avow-sandbox-mcp', () => {
  it('speaks MCP to the official client, with the tools to connect and commit and no others', async () => {
    const c = await connect(mkdtempSync(join(tmpdir(), 'avow-mcp-')))
    expect(c.getServerVersion()?.name).toBe('avow-sandbox')
    const { tools } = await c.listTools()
    expect(tools.map((t) => t.name)).toEqual([
      'connect',
      'status',
      'authority',
      'check',
      'book',
      'verify',
      'commitments',
      'publish_offer',
      'offers',
      'order',
      'orders',
      'sell',
    ])
    // An agent can ask without knowing its business.
    expect(tools.find((t) => t.name === 'verify')?.inputSchema.required).toEqual(['link'])
    expect(tools.find((t) => t.name === 'connect')?.inputSchema.required).toEqual([])
    expect(tools.find((t) => t.name === 'book')?.inputSchema.required).toEqual(['reserve'])
    // Every tool has a title and says how it acts. Booking, ordering and selling change
    // something beyond the agent's own request, publishing changes its own folder, and nothing
    // destroys. A supplier's offers stay in its folder, so the two tools for them reach nowhere.
    for (const t of tools) {
      expect(t.title).toBeTruthy()
      expect(t.annotations?.destructiveHint).toBe(false)
    }
    expect(tools.filter((t) => !t.annotations?.openWorldHint).map((t) => t.name)).toEqual([
      'publish_offer',
      'offers',
    ])
    expect(tools.filter((t) => !t.annotations?.readOnlyHint).map((t) => t.name)).toEqual([
      'connect',
      'book',
      'publish_offer',
      'order',
      'sell',
    ])
    // An offer names both charges, since they set what a booking reserves.
    expect(tools.find((t) => t.name === 'publish_offer')?.inputSchema.required).toEqual([
      'name',
      'summary',
      'price',
      'evidence',
      'late_cancellation_percent',
      'no_show_percent',
    ])
  }, 30_000)

  it('offers the approval card with connect, for a client that renders MCP Apps, and only then', async () => {
    const c = await connect(mkdtempSync(join(tmpdir(), 'avow-mcp-')))
    const { tools } = await c.listTools()
    // Only connect names the card, so no other answer turns into one.
    expect(tools.filter((t) => t._meta?.ui).map((t) => [t.name, t._meta?.ui])).toEqual([
      ['connect', { resourceUri: 'ui://avow-sandbox/approval' }],
    ])
    const { resources } = await c.listResources()
    expect(resources).toEqual([
      expect.objectContaining({
        uri: 'ui://avow-sandbox/approval',
        mimeType: 'text/html;profile=mcp-app',
      }),
    ])
    const { contents } = await c.readResource({ uri: 'ui://avow-sandbox/approval' })
    const card = contents[0] as { mimeType: string; text: string; _meta: unknown }
    expect(card.mimeType).toBe('text/html;profile=mcp-app')
    // One file that loads nothing from anywhere, and asks for nowhere to connect to.
    expect(card.text).not.toMatch(/<script[^>]+src=|<link[^>]+href=|https?:\/\//)
    expect(card._meta).toEqual({
      ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } },
    })
    await expect(c.readResource({ uri: 'ui://avow-sandbox/other' })).rejects.toThrow(/not found/)
  }, 30_000)

  it('tells a model in a folder with no agent to connect it, and the tools that commit refuse', async () => {
    const c = await connect(mkdtempSync(join(tmpdir(), 'avow-mcp-')))
    const status = await c.callTool({ name: 'status', arguments: {} })
    expect(status.isError).toBe(false)
    expect(status.structuredContent).toEqual({ at: 'none' })
    expect(JSON.stringify(status.content)).toMatch(/call connect/)
    for (const name of ['authority', 'commitments', 'check', 'offers', 'orders', 'order']) {
      const answer = await c.callTool({ name, arguments: {} })
      expect(answer.isError).toBe(true)
      expect(JSON.stringify(answer.content)).toMatch(/isn't connected to a business yet/)
    }
    const unknown = await c.callTool({ name: 'pay', arguments: {} })
    expect(unknown.isError).toBe(true)
  }, 30_000)

  it('checks a shared commitment without connecting, and refuses a link or payee that is no such thing', async () => {
    const c = await connect(mkdtempSync(join(tmpdir(), 'avow-mcp-')))
    // A link that carries no commitment is answered without reading the chain, and not as an error,
    // since the answer is that the chain doesn't back it.
    const bad = await c.callTool({ name: 'verify', arguments: { link: 'not a link' } })
    expect(bad.isError).toBe(false)
    expect(bad.structuredContent).toMatchObject({ standing: false, code: 'message.invalid' })
    expect(JSON.stringify(bad.content)).toMatch(/Don't rely on it/)
    const payee = await c.callTool({ name: 'verify', arguments: { link: 'x', payee: 'me' } })
    expect(payee.isError).toBe(true)
    expect(JSON.stringify(payee.content)).toMatch(/isn't an address/)
  }, 30_000)

  it('refuses a blank business ID rather than asking anyone with it', async () => {
    const c = await connect(mkdtempSync(join(tmpdir(), 'avow-mcp-')))
    const answer = await c.callTool({ name: 'connect', arguments: { business: ' ' } })
    expect(answer.isError).toBe(true)
    expect(JSON.stringify(answer.content)).toMatch(/Leave business out/)
  }, 30_000)

  it.skipIf(process.platform === 'win32')(
    'replaces an entry an earlier version added, so adding again picks up this one',
    () => {
      // A stand-in for the claude command, which records each call it gets.
      const bin = mkdtempSync(join(tmpdir(), 'avow-claude-'))
      const log = join(bin, 'calls')
      writeFileSync(join(bin, 'claude'), `#!/bin/sh\necho "$@" >> "${log}"\n`)
      chmodSync(join(bin, 'claude'), 0o755)
      const dir = mkdtempSync(join(tmpdir(), 'avow-mcp-'))
      const run = spawnSync(process.execPath, [SERVER, 'add', 'claude-code'], {
        cwd: dir,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        encoding: 'utf8',
      })
      expect(run.status).toBe(0)
      const calls = readFileSync(log, 'utf8').trim().split('\n')
      expect(calls[0]).toBe('mcp remove avow-sandbox')
      expect(calls[1]).toMatch(/^mcp add avow-sandbox -- .+ --dir /)
    },
  )
})
