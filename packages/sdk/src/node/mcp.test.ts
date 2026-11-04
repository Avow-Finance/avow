import { mkdtempSync } from 'node:fs'
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
  it("speaks MCP to the official client, with the starter's three tools and no others", async () => {
    const c = await connect(mkdtempSync(join(tmpdir(), 'avow-mcp-')))
    expect(c.getServerVersion()?.name).toBe('avow-sandbox')
    const { tools } = await c.listTools()
    expect(tools.map((t) => t.name)).toEqual(['authority', 'book', 'commitments'])
    expect(tools.find((t) => t.name === 'book')?.inputSchema.required).toEqual(['reserve'])
  }, 30_000)

  it('answers a folder with no agent by saying so, as an error the model sees', async () => {
    const c = await connect(mkdtempSync(join(tmpdir(), 'avow-mcp-')))
    for (const name of ['authority', 'commitments']) {
      const answer = await c.callTool({ name, arguments: {} })
      expect(answer.isError).toBe(true)
      expect(JSON.stringify(answer.content)).toMatch(/no agent yet/)
    }
    const unknown = await c.callTool({ name: 'pay', arguments: {} })
    expect(unknown.isError).toBe(true)
  }, 30_000)
})
