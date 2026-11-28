import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fileStore, prepareSandboxBusiness } from '@avow-finance/sdk'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { Toolbox, ToolResult } from './conversation.js'

/**
 * The world each model runs in: a test business made for that model on Moderato, with an agent
 * that may hold $500 at once and move $1,000 a day with Avow's demo GPU supplier, reached through
 * the MCP server as any client starts it. Its keys are made at run time in a folder of its own and
 * never leave it.
 */
export const WORLD = {
  name: 'Compatibility check (test business)',
  authority: 500,
  dailyLimit: 1000,
  suppliers: [{ id: 'avow-demo-gpu', url: 'https://supplier.testnet.avow.finance' }],
}

/** The skill Avow ships for agents, which the model hears after the server's instructions. */
export const SKILL_PATH = fileURLToPath(
  new URL('../../../skills/avow-commitments/SKILL.md', import.meta.url),
)

/** The system prompt: what the server tells every client, then the skill without its front matter. */
export function systemPrompt(instructions: string, skill = readFileSync(SKILL_PATH, 'utf8')) {
  return `${instructions}\n\n${skill.replace(/^---\n[\s\S]*?\n---\n/, '').trim()}`
}

/** Makes the test business in a fresh folder, and answers with the folder. */
export async function prepareWorld(log: (line: string) => void): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'avow-compat-'))
  // The passphrase only seals this run's keys in its own folder, and nothing prints it.
  const passphrase = randomBytes(24).toString('base64url')
  await prepareSandboxBusiness({
    config: WORLD,
    prompts: {
      newPassphrase: async () => passphrase,
      passphrase: async () => passphrase,
      confirm: async () => true,
    },
    store: fileStore(join(dir, '.avow')),
    session: null,
    log,
  })
  return dir
}

/** The MCP server for the folder's agent, started as a client starts it, through the SDK's command. */
export async function mcpToolbox(dir: string): Promise<Toolbox & { close(): Promise<void> }> {
  const cli = fileURLToPath(import.meta.resolve('@avow-finance/sdk/cli'))
  const client = new Client({ name: 'avow-compat', version: '0.0.0' })
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [cli, 'mcp', '--dir', dir],
      // The server gets this process's environment, as a client passes its own, so a proxy the
      // machine needs reaches it too.
      env: Object.fromEntries(
        Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
      ),
      stderr: 'ignore',
    }),
  )
  const { tools } = await client.listTools()
  return {
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      parameters: t.inputSchema as Record<string, unknown>,
    })),
    instructions: client.getInstructions() ?? '',
    async call(name, args): Promise<ToolResult> {
      // Bookings wait for the supplier, so a call may take longer than the client's default.
      const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 })
      const content = Array.isArray(r.content) ? r.content : []
      return {
        text: content
          .flatMap((c: { type?: unknown; text?: unknown }) =>
            c.type === 'text' && typeof c.text === 'string' ? [c.text] : [],
          )
          .join('\n'),
        structured:
          typeof r.structuredContent === 'object' && r.structuredContent !== null
            ? (r.structuredContent as Record<string, unknown>)
            : null,
        isError: r.isError === true,
      }
    },
    close: () => client.close(),
  }
}
