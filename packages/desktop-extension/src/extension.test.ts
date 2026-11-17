import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { unpackExtension } from '@anthropic-ai/mcpb'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
// The server the extension bundles, read from the SDK's build in this repo.
import { MCP_TOOLS } from '../../sdk/dist/node/mcp.js'

// The build runs before the tests, so the packed extension is there to open.
const PACKED = fileURLToPath(new URL('../dist/avow-sandbox.mcpb', import.meta.url))

/** Sends MCP messages to the server as Claude Desktop would, and gathers its answers by id. */
function talk(entry: string, dir: string, messages: object[]): Promise<Map<number, unknown>> {
  return new Promise((resolve, reject) => {
    // Started from another folder, so nothing outside the extension can be found by accident.
    const child = spawn(process.execPath, [entry, '--dir', dir], { cwd: tmpdir() })
    const answers = new Map<number, unknown>()
    let buffered = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`The server answered ${answers.size} of ${messages.length} messages`))
    }, 20_000)
    child.stdout.on('data', (chunk: Buffer) => {
      buffered += chunk.toString()
      for (let end = buffered.indexOf('\n'); end >= 0; end = buffered.indexOf('\n')) {
        const line = buffered.slice(0, end)
        buffered = buffered.slice(end + 1)
        const answer = JSON.parse(line) as { id?: number }
        if (typeof answer.id === 'number') answers.set(answer.id, answer)
        if (answers.size === messages.length) {
          clearTimeout(timer)
          child.kill()
          resolve(answers)
        }
      }
    })
    child.on('error', reject)
    for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`)
  })
}

describe('the Claude Desktop extension', () => {
  let unpacked: string
  let agentFolder: string

  beforeAll(async () => {
    unpacked = mkdtempSync(join(tmpdir(), 'avow-extension-'))
    agentFolder = mkdtempSync(join(tmpdir(), 'avow-agent-'))
    expect(await unpackExtension({ mcpbPath: PACKED, outputDir: unpacked, silent: true })).toBe(
      true,
    )
  })
  afterAll(() => {
    rmSync(unpacked, { recursive: true, force: true })
    rmSync(agentFolder, { recursive: true, force: true })
  })

  it('carries one bundled server, its manifest and icon, and no node_modules', () => {
    expect(existsSync(join(unpacked, 'server', 'index.js'))).toBe(true)
    expect(existsSync(join(unpacked, 'icon.png'))).toBe(true)
    expect(existsSync(join(unpacked, 'node_modules'))).toBe(false)
  })

  it('runs the server in the agent folder, from the manifest as Claude Desktop does', () => {
    const manifest = JSON.parse(readFileSync(join(unpacked, 'manifest.json'), 'utf8'))
    expect(manifest.server.mcp_config).toEqual({
      command: 'node',
      args: ['${__dirname}/server/index.js', '--dir', '${user_config.agent_folder}'],
    })
    // Installing asks nothing, since the folder has a default in the person's home folder.
    expect(manifest.user_config.agent_folder).toMatchObject({
      type: 'directory',
      required: false,
      default: '${HOME}/avow-agent',
    })
    expect(manifest.tools.map((t: { name: string }) => t.name)).toEqual(
      MCP_TOOLS.map((t) => t.name),
    )
  })

  it('answers MCP with every tool the manifest lists, using nothing outside the extension', async () => {
    const answers = await talk(join(unpacked, 'server', 'index.js'), agentFolder, [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '0' },
        },
      },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'status', arguments: {} },
      },
    ])
    expect(answers.get(1)).toMatchObject({ result: { serverInfo: { name: 'avow-sandbox' } } })
    const tools = (answers.get(2) as { result: { tools: { name: string }[] } }).result.tools
    expect(tools.map((t) => t.name)).toEqual(MCP_TOOLS.map((t) => t.name))
    // A new agent folder has asked no business for anything yet.
    expect(answers.get(3)).toMatchObject({ result: { structuredContent: { at: 'none' } } })
  })

  it("starts in an agent folder that doesn't exist yet, and serves the approval card", async () => {
    const fresh = join(agentFolder, 'not-made-yet')
    const answers = await talk(join(unpacked, 'server', 'index.js'), fresh, [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: { extensions: { 'io.modelcontextprotocol/ui': {} } },
          clientInfo: { name: 'test', version: '0' },
        },
      },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'status', arguments: {} } },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'resources/read',
        params: { uri: 'ui://avow-sandbox/approval' },
      },
    ])
    expect(answers.get(2)).toMatchObject({ result: { structuredContent: { at: 'none' } } })
    expect(answers.get(3)).toMatchObject({
      result: { contents: [{ mimeType: 'text/html;profile=mcp-app' }] },
    })
  })
})
