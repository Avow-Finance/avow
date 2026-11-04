#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { formatUsd, isSessionId, SANDBOX_TOOLS, type SandboxTool, toWire } from '@avow-finance/spec'
import { Refusal, type SandboxAgent, sandboxAgent } from '../sandbox/agent.js'
import { sessionUrl } from '../sandbox/session.js'
import { fileStore, SANDBOX_DIR, takeRun } from './platform.js'

/**
 * `avow-sandbox-mcp` gives a model in Claude Code, Claude Desktop or any other MCP client the
 * starter's agent, with three tools. It runs as the agent, with only the agent's key, through the
 * same SDK calls agent.ts makes, and it never opens the business's key. Each tool call reports to
 * the screen the runner opened, marked as the MCP agent's.
 *
 *   avow-sandbox-mcp [--dir <folder>]          serves MCP over stdio for the agent in <folder>
 *   avow-sandbox-mcp add claude-code           adds the server to Claude Code for this folder
 *   avow-sandbox-mcp add claude-desktop        adds the server to Claude Desktop
 */

const SERVER = { name: 'avow-sandbox', version: '0.0.0' }
const PROTOCOL = '2025-06-18'
/** How long a booking waits for the supplier's acceptance before it answers. */
const ACCEPTANCE_WAIT_MS = 45_000

const usd = (dollars: number | null) =>
  dollars === null ? 'no limit' : formatUsd(BigInt(Math.round(dollars * 1_000_000)))

const noInput = { type: 'object', properties: {}, additionalProperties: false } as const

/** The tools, kept to what shows the authority model and nothing more. */
export const MCP_TOOLS = [
  {
    name: 'authority',
    description:
      "What your agent can commit right now. It has two limits. It holds at most so much in bookings at once, which Avow refuses past and the lock checks against Avow's approval. Its key moves at most so much a day, a limit the business set on chain. It names the suppliers the agent may book too.",
    inputSchema: noInput,
  },
  {
    name: 'book',
    description:
      "Books GPU capacity with one of your agent's suppliers, backed by a reserve in your business's own lock. Avow checks the booking against the mandate and what the lock holds before any money moves, the agent's machine runs the open verifier, and the supplier accepts on the lock. A refusal comes back with its reason code, the layer that refused it and the amounts. It stands, and asking again gets the same answer until the business changes the limits.",
    inputSchema: {
      type: 'object',
      properties: {
        reserve: { type: 'number', description: 'The reserve in dollars, such as 200' },
        gpu: { type: 'string', description: 'The GPU model, H100 when left out' },
        count: { type: 'integer', description: 'How many GPUs, 8 when left out' },
        hours: { type: 'number', description: 'How many hours, 1 when left out' },
        supplier: {
          type: 'string',
          description: "The supplier's business id, the agent's first supplier when left out",
        },
      },
      required: ['reserve'],
      additionalProperties: false,
    },
  },
  {
    name: 'commitments',
    description:
      'Lists every commitment your agent made, with its state on the lock, whether the current authority made it, and a link anyone can open to check it.',
    inputSchema: noInput,
  },
] as const satisfies readonly { name: SandboxTool; description: string; inputSchema: object }[]

export interface ToolAnswer {
  text: string
  structured: Record<string, unknown>
  isError: boolean
}

/** The session the runner opened in this folder, while the runner still runs. */
function runnerSession(dir: string): string | null {
  try {
    const { id, pid } = JSON.parse(
      readFileSync(join(dir, SANDBOX_DIR, 'session.json'), 'utf8'),
    ) as {
      id: unknown
      pid: unknown
    }
    if (typeof id !== 'string' || !isSessionId(id) || typeof pid !== 'number') return null
    process.kill(pid, 0)
    return id
  } catch {
    return null
  }
}

/** The MCP agent for one folder, answering each tool call through the SDK's agent. */
export function mcpAgent(dir: string, options: { fetch?: typeof fetch } = {}) {
  const store = fileStore(join(dir, SANDBOX_DIR))
  const log = (line: string) => process.stderr.write(`${line}\n`)

  async function open(tool: SandboxTool): Promise<SandboxAgent> {
    const id = runnerSession(dir)
    return sandboxAgent({
      store,
      session: id ? { id, run: takeRun(join(dir, SANDBOX_DIR), id) } : null,
      source: 'mcp',
      tool,
      log,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    })
  }

  const screen = () => {
    const id = runnerSession(dir)
    return id ? sessionUrl(id) : null
  }

  async function authority(): Promise<ToolAnswer> {
    const agent = await open('authority')
    const left = await agent.left()
    const dailyLeft = await agent.dailyLeft()
    const now = dailyLeft === null ? left : Math.min(left, dailyLeft)
    return {
      text: [
        `Your agent can commit up to ${usd(now)} more right now.`,
        `It holds at most ${usd(agent.authority)} in bookings at once, which Avow refuses past and the lock checks against Avow's approval, and ${usd(left)} of that is free.`,
        `Its key moves at most ${usd(agent.dailyLimit)} a day, a limit your business set on chain, and ${usd(dailyLeft)} of today's is left.`,
        `It may book with ${agent.suppliers.map((s) => s.id).join(', ')} only.`,
      ].join(' '),
      structured: {
        canCommitNow: now,
        heldAtOnce: { limit: agent.authority, left },
        movedPerDay: { limit: agent.dailyLimit, left: dailyLeft },
        suppliers: agent.suppliers,
        business: agent.business,
        mandateHash: agent.mandateHash,
        screen: screen(),
      },
      isError: false,
    }
  }

  async function book(args: Record<string, unknown>): Promise<ToolAnswer> {
    const reserve = args.reserve
    if (typeof reserve !== 'number') throw new RangeError('The booking needs a reserve in dollars')
    const agent = await open('book')
    const gpu = typeof args.gpu === 'string' ? args.gpu : 'H100'
    const count = typeof args.count === 'number' ? args.count : 8
    const hours = typeof args.hours === 'number' ? args.hours : 1
    const supplier =
      typeof args.supplier === 'string' ? args.supplier : (agent.suppliers[0]?.id ?? '')
    try {
      const c = await agent.book({ supplier, resource: { gpu, count, hours }, reserve })
      const checks = await c.verify()
      const accepted = await Promise.race([
        c.accepted(),
        new Promise<null>((done) => setTimeout(() => done(null), ACCEPTANCE_WAIT_MS).unref()),
      ])
      const passed = checks.filter((k) => k.passed).length
      return {
        text: [
          `Committed ${usd(c.amount)} with ${supplier} for ${count} ${gpu} for ${hours} hour${hours === 1 ? '' : 's'}.`,
          accepted === true
            ? 'The supplier checked the commitment and accepted it on the lock.'
            : accepted === false
              ? "The supplier didn't accept it in time, so the reserve goes back to the business."
              : "The supplier hasn't accepted it yet, and the commitments tool shows when it does.",
          `On this machine the open verifier passed ${passed} of ${checks.length} checks.`,
          `Your agent has ${usd(c.left)} left of its ${usd(agent.authority)} held at once.`,
          `Anyone can check the commitment at ${c.link}`,
        ].join(' '),
        structured: {
          status: 'committed',
          reserve: c.amount,
          supplier,
          resource: { gpu, count, hours },
          accepted,
          checks,
          reference: toWire(c.reference),
          link: c.link,
          left: c.left,
          screen: screen(),
        },
        isError: false,
      }
    } catch (error) {
      if (!(error instanceof Refusal)) throw error
      const dollars = (micros: bigint | null) =>
        micros === null ? null : Number(micros) / 1_000_000
      return {
        text: `Refused by ${error.layer}, with reason code ${error.code}. ${error.message}`,
        structured: {
          status: 'refused',
          code: error.code,
          layer: error.layer,
          sentence: error.message,
          amounts: {
            needed: dollars(error.amounts.needed),
            left: dollars(error.amounts.left),
            heldAtOnce: dollars(error.amounts.authority),
            movedPerDay: dollars(error.amounts.dailyLimit),
            movedToday: dollars(error.amounts.dailyLeft),
          },
          screen: screen(),
        },
        isError: false,
      }
    }
  }

  async function commitments(): Promise<ToolAnswer> {
    const agent = await open('commitments')
    const list = await agent.commitments()
    return {
      text:
        list.length === 0
          ? 'Your agent has made no commitments yet.'
          : list
              .map(
                (c) =>
                  `${usd(c.amount)} with ${c.supplier}, ${c.state}${c.current ? '' : ', made under an earlier authority'}, at ${new Date(Number(c.madeAt) * 1000).toISOString()}. Check it at ${c.link}`,
              )
              .join('\n'),
      structured: {
        commitments: list.map((c) => ({
          amount: c.amount,
          supplier: c.supplier,
          state: c.state,
          current: c.current,
          madeAt: Number(c.madeAt),
          releaseDate: c.releaseDate === null ? null : Number(c.releaseDate),
          reference: toWire(c.reference),
          link: c.link,
        })),
      },
      isError: false,
    }
  }

  return {
    async call(name: string, args: Record<string, unknown>): Promise<ToolAnswer> {
      try {
        if (name === 'authority') return await authority()
        if (name === 'book') return await book(args)
        if (name === 'commitments') return await commitments()
        return { text: `There's no tool named ${name}.`, structured: {}, isError: true }
      } catch (error) {
        return {
          text: error instanceof Error ? error.message : String(error),
          structured: {},
          isError: true,
        }
      }
    },
  }
}

type Message = { jsonrpc?: string; id?: string | number | null; method?: string; params?: unknown }

/** Serves MCP over stdio, a JSON-RPC message per line, for the agent in `dir`. */
export function serve(dir: string, io = { input: process.stdin, output: process.stdout }): void {
  const agent = mcpAgent(dir)
  const write = (message: object) =>
    io.output.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  const lines = createInterface({ input: io.input })
  lines.on('line', async (line) => {
    if (line.trim() === '') return
    let message: Message
    try {
      message = JSON.parse(line) as Message
    } catch {
      write({ id: null, error: { code: -32700, message: 'Parse error' } })
      return
    }
    const { id, method } = message
    // A notification, which has no id, gets no answer.
    if (id === undefined || id === null) return
    const params = (message.params ?? {}) as Record<string, unknown>
    switch (method) {
      case 'initialize': {
        const asked = params.protocolVersion
        write({
          id,
          result: {
            protocolVersion:
              typeof asked === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : PROTOCOL,
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER,
            instructions:
              "These tools act as one business's agent on Avow's sandbox, on Tempo's testnet, with test dollars. The agent commits the business only within the mandate the business signed. A refusal is the real answer from Avow, its relay, the lock or the account's keychain, and it stands.",
          },
        })
        return
      }
      case 'ping':
        write({ id, result: {} })
        return
      case 'tools/list':
        write({ id, result: { tools: MCP_TOOLS } })
        return
      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : ''
        const args = (params.arguments ?? {}) as Record<string, unknown>
        const answer = await agent.call(name, args)
        write({
          id,
          result: {
            content: [{ type: 'text', text: answer.text }],
            structuredContent: answer.structured,
            isError: answer.isError,
          },
        })
        return
      }
      default:
        write({ id, error: { code: -32601, message: `Method not found: ${method}` } })
    }
  })
}

/** Where Claude Desktop keeps its MCP servers on this platform. */
export function claudeDesktopConfig(): string {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
  }
  if (process.platform === 'win32') {
    return join(
      process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
      'Claude',
      'claude_desktop_config.json',
    )
  }
  return join(homedir(), '.config', 'Claude', 'claude_desktop_config.json')
}

/** Adds the server to Claude Code for this folder, or to Claude Desktop, against this folder's agent. */
function add(client: string | undefined, dir: string): number {
  const server = realpathSync(fileURLToPath(import.meta.url))
  const args = [server, '--dir', dir]
  if (!existsSync(join(dir, SANDBOX_DIR, 'agent.json'))) {
    console.log('This folder has no agent yet. Run npm start first, then add the server.')
  }
  if (client === 'claude-code') {
    const line = ['claude', 'mcp', 'add', SERVER.name, '--', process.execPath, ...args]
    const result = spawnSync(line[0] as string, line.slice(1), {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
    if (result.error || result.status !== 0) {
      console.log(
        `\nClaude Code didn't take it. Run this in this folder yourself:\n\n  ${line.map((a) => JSON.stringify(a)).join(' ')}\n`,
      )
      return 1
    }
    console.log('\nAdded. Run claude in this folder and ask it to book $200 of GPU compute.')
    return 0
  }
  if (client === 'claude-desktop') {
    const file = claudeDesktopConfig()
    let config: { mcpServers?: Record<string, unknown> } = {}
    if (existsSync(file)) {
      config = JSON.parse(readFileSync(file, 'utf8')) as typeof config
      copyFileSync(file, `${file}.bak`)
    }
    config.mcpServers = {
      ...(config.mcpServers ?? {}),
      [SERVER.name]: { command: process.execPath, args },
    }
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`)
    console.log(`Added to ${file}. Restart Claude Desktop and ask it to book $200 of GPU compute.`)
    return 0
  }
  console.error('Use avow-sandbox-mcp add claude-code, or avow-sandbox-mcp add claude-desktop.')
  return 1
}

/** Runs only as the command, so a test can import the server. */
const isMain = (() => {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()
if (isMain) {
  const argv = process.argv.slice(2)
  if (argv[0] === 'add') {
    process.exitCode = add(argv[1], process.cwd())
  } else {
    const at = argv.indexOf('--dir')
    const dir = resolve(at >= 0 ? (argv[at + 1] ?? '.') : '.')
    // Standard output carries the protocol, so anything the SDK prints goes to standard error.
    console.log = (...items: unknown[]) => console.error(...items)
    serve(dir)
  }
}

export { SANDBOX_TOOLS }
