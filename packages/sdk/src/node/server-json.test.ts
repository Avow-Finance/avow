import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterEach, describe, expect, it } from 'vitest'
import { folderWithAgent } from '../test/agent-folder.js'
import { MCP_TOOLS } from './mcp.js'
import { fileStore, SANDBOX_DIR } from './platform.js'

// The MCP Registry's listing of the server, read as the registry reads it, beside the packages it
// names. A client starts the server from these fields alone, so they have to describe what the
// packages really run.
const ROOT = join(import.meta.dirname, '../../../..')
const read = (path: string) => JSON.parse(readFileSync(join(ROOT, path), 'utf8'))

interface Argument {
  type: 'positional' | 'named'
  value?: string
  valueHint?: string
}
interface Listing {
  name: string
  version: string
  packages: {
    registryType: string
    identifier: string
    version: string
    transport: { type: string }
    packageArguments: Argument[]
  }[]
}

const listing: Listing = read('server.json')
const sandbox = read('packages/avow-sandbox/package.json')
const sdk = read('packages/sdk/package.json')
const [npm] = listing.packages
const SANDBOX_CLI = join(ROOT, 'packages/avow-sandbox', sandbox.bin[sandbox.name])
const MCP_SERVER = join(ROOT, 'packages/sdk/dist/node/mcp.js')
/** The one argument a person fills in, which is the agent's folder. */
const FOLDER = 'agent_folder'

/** The command line a client builds from the listing, with the agent's folder filled in. */
const argvFor = (dir: string) =>
  npm?.packageArguments.map((a) => (a.valueHint === FOLDER ? dir : a.value)) ?? []

let client: Client | null = null
afterEach(async () => {
  await client?.close()
  client = null
})

describe('the MCP Registry listing', () => {
  it('names the package npx runs, at the version this repo releases, which carries its name', () => {
    expect(listing.packages).toHaveLength(1)
    expect(npm?.registryType).toBe('npm')
    expect(npm?.transport).toEqual({ type: 'stdio' })
    expect(npm?.identifier).toBe(sandbox.name)
    // npx runs a package's only command, so the package has exactly one.
    expect(Object.keys(sandbox.bin)).toEqual([sandbox.name])
    // A release bumps every public package together, and the listing moves with them.
    expect(npm?.version).toBe(sandbox.version)
    expect(listing.version).toBe(sandbox.version)
    expect(sdk.version).toBe(sandbox.version)
    // The registry accepts the listing only from the package that names it.
    expect(sandbox.mcpName).toBe(listing.name)
  })

  it("runs the SDK's own command", () => {
    expect(readFileSync(SANDBOX_CLI, 'utf8')).toMatch(/^import '@avow-finance\/sdk\/cli'$/m)
    expect(sdk.exports['./cli']).toBe(sdk.bin['avow-sandbox'])
    expect(argvFor('/work/agent')[0]).toBe('mcp')
  })

  it('passes the agent folder the way avow-sandbox mcp add does', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'avow-listing-')))
    const run = spawnSync(process.execPath, [MCP_SERVER, 'add', 'config'], {
      cwd: dir,
      encoding: 'utf8',
    })
    expect(run.status).toBe(0)
    const servers: Record<string, { args: string[] }> = JSON.parse(run.stdout).mcpServers
    const [name, launch] = Object.entries(servers)[0] ?? []
    expect(listing.name.split('/')[1]).toBe(name)
    // `add` starts mcp.js itself, and the listing starts it through `avow-sandbox mcp`, with the
    // same arguments after that.
    expect(argvFor(dir).slice(1)).toEqual(launch?.args.slice(1))
  }, 30_000)

  it('starts the server from the command line a client builds from it, for the folder it names', async () => {
    // The folder holds a connected agent, and the server runs from somewhere else, so only the
    // folder in the command line can tell the server about that agent.
    const dir = mkdtempSync(join(tmpdir(), 'avow-listing-'))
    const made = await folderWithAgent('sandbox-listing', { suppliers: [], categories: [] })
    const agent = await made.store.read('agent')
    if (agent === null) throw new Error('the folder has no agent')
    await fileStore(join(dir, SANDBOX_DIR)).write('agent', agent)
    const elsewhere = mkdtempSync(join(tmpdir(), 'avow-elsewhere-'))

    client = new Client({ name: 'avow-test', version: '0.0.0' })
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [SANDBOX_CLI, ...(argvFor(dir) as string[])],
        cwd: elsewhere,
        stderr: 'ignore',
      }),
    )
    expect(client.getServerVersion()).toEqual({
      name: listing.name.split('/')[1],
      version: listing.version,
    })
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(MCP_TOOLS.map((t) => t.name))
    const status = await client.callTool({ name: 'status', arguments: {} })
    expect(status.structuredContent).toMatchObject({
      at: 'connected',
      businessId: 'sandbox-listing',
    })
    expect(existsSync(join(elsewhere, SANDBOX_DIR))).toBe(false)
  }, 30_000)
})
