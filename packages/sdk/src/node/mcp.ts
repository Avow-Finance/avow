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
import {
  formatUsd,
  isSessionId,
  SANDBOX_TOOLS,
  type SandboxTool,
  toWire,
  whenRetryPasses,
} from '@avow-finance/spec'
import { Refusal, type SandboxAgent, sandboxAgent } from '../sandbox/agent.js'
import { SANDBOX_CONSOLE_URL } from '../sandbox/connect.js'
import { sessionUrl } from '../sandbox/session.js'
import { type Connection, mcpConnection } from './mcp-connection.js'
import { fileStore, SANDBOX_DIR, takeRun } from './platform.js'

/**
 * `avow-sandbox-mcp` gives a model in Claude Code, Claude Desktop or any other MCP client an agent
 * for one folder. It connects the agent to a business itself, asking for authority with a key it
 * makes and keeps in the folder, and once the administrator approves it commits through the same
 * SDK calls agent.ts makes. It never holds the business's key. Each commitment tool call reports to
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

/** The tools that set the agent up, which run before it has any authority to report. */
type SetupTool = 'connect' | 'status'

/** The tools, kept to what shows the authority model and nothing more. */
export const MCP_TOOLS = [
  {
    name: 'connect',
    description:
      "Asks a business for the authority to commit for it, with a key this agent makes and keeps on this machine. It answers with a pairing code and a link for your person to review the request on their phone, and keeps waiting in the background. Only the business's administrator can approve, with their passkey, and the approval sets this agent's limits. Calling it again for the same business answers with the same request.",
    inputSchema: {
      type: 'object',
      properties: {
        business: {
          type: 'string',
          description: 'The business ID your person copies from the console',
        },
        name: {
          type: 'string',
          description:
            'The name the administrator sees, which says what this agent does, such as "Research agent"',
        },
        sell: {
          type: 'boolean',
          description:
            'Also ask to quote and accept jobs for the business, with a signing key of its own. Leave it out to only buy.',
        },
      },
      required: ['business'],
      additionalProperties: false,
    },
  },
  {
    name: 'status',
    description:
      'Where this agent stands with its business. It is not connected yet, waiting for approval with its pairing code and link, connected under a mandate with the date it ends, or failed with the reason.',
    inputSchema: noInput,
  },
  {
    name: 'authority',
    description:
      "What your agent can commit right now. It has two limits. It holds at most so much in bookings at once, which Avow refuses past and the lock checks against Avow's approval. Its key moves at most so much a day, a limit the business set on chain. It names the suppliers the agent may book too.",
    inputSchema: noInput,
  },
  {
    name: 'book',
    description:
      "Books GPU capacity with one of your agent's suppliers, backed by a reserve in your business's own lock. Avow checks the booking against the mandate and what the lock holds before any money moves, the agent's machine runs the open verifier, and the supplier accepts on the lock. A refusal comes back with its reason code, the layer that refused it, the amounts and when the same booking could pass. A reserve that never landed with no reason given comes back as a failure. Held reserves come back as bookings end or are cancelled, the key's daily limit starts again each day, Avow's relay can be limiting how much it takes for now, and anything else in the mandate changes only when the business signs a new one.",
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
] as const satisfies readonly {
  name: SandboxTool | SetupTool
  description: string
  inputSchema: object
}[]

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

const when = (seconds: number) => new Date(seconds * 1000).toISOString()

/**
 * What the model hears about the agent's connection. `asked` is the business a connect call named,
 * so a folder already connected elsewhere says so.
 */
function connectionAnswer(c: Connection, asked?: string): ToolAnswer {
  const answer = (text: string | string[], isError = false): ToolAnswer => ({
    text: Array.isArray(text) ? text.join(' ') : text,
    structured: { ...c },
    isError,
  })
  switch (c.at) {
    case 'none':
      return answer(
        `This agent isn't connected to a business yet. Ask your person for their business ID, which the console at ${SANDBOX_CONSOLE_URL} shows, then call connect with it.`,
      )
    case 'saved':
      return answer(
        `This agent asked ${c.businessId} for authority earlier, and nothing is waiting on that request now. Call connect with the same business to keep waiting, with the same pairing code.`,
      )
    case 'waiting':
      return answer([
        `Asked ${c.businessId} for authority, as "${c.label}", with pairing code ${c.pairingCode}.`,
        `Send your person this link to review the request, on their phone or anywhere else: ${c.link}`,
        'The console shows the same code, so they can check the request came from you. The link grants nothing by itself, and only their passkey approves.',
        `Avow holds the request until ${when(c.expiresAt)}. This server keeps waiting in the background, and status says once it's approved.`,
        'Your key stays in .avow on this machine. Never print it or send it to anyone, your person included.',
      ])
    case 'enrolling':
      return answer(
        `${c.businessId} approved this agent as ${c.agentId}. It's picking up its authority from Avow, and status says once it has.`,
      )
    case 'connected':
      return answer(
        asked !== undefined && asked !== c.businessId
          ? `This folder's agent is already connected to ${c.businessId} as ${c.agentId}. Connect an agent for ${asked} from a fresh folder.`
          : `Connected to ${c.businessId} as ${c.agentId}, under a mandate that runs until ${when(c.expiry)} unless the business revokes it first. Call authority to see what it can commit now.`,
      )
    case 'failed':
      return answer(
        `Connecting to ${c.businessId} failed. ${c.reason} Call connect to try again.`,
        true,
      )
  }
}

/** The MCP agent for one folder, answering each tool call through the SDK's agent. */
export function mcpAgent(dir: string, options: { fetch?: typeof fetch } = {}) {
  const store = fileStore(join(dir, SANDBOX_DIR))
  const log = (line: string) => process.stderr.write(`${line}\n`)
  const connection = mcpConnection({
    store,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })

  async function connect(args: Record<string, unknown>): Promise<ToolAnswer> {
    const business = typeof args.business === 'string' ? args.business.trim() : ''
    if (business === '') throw new RangeError('connect needs the business ID from the console')
    const c = await connection.start({
      businessId: business,
      label: typeof args.name === 'string' && args.name.trim() !== '' ? args.name.trim() : null,
      sell: args.sell === true,
    })
    return connectionAnswer(c, business)
  }

  /** Answers for a tool that needs authority, while the agent has none yet. */
  async function unready(): Promise<ToolAnswer | null> {
    const c = await connection.state()
    if (c.at === 'connected') return null
    const told = connectionAnswer(c)
    return {
      ...told,
      text: c.at === 'none' ? told.text : `This agent has no authority yet. ${told.text}`,
      isError: true,
    }
  }

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
      // A reserve that never landed with no reason given is a failure, and nothing refused it.
      const failed = error.layer === 'unknown'
      return {
        text: failed
          ? `The booking failed, with reason code ${error.code}. ${error.message}`
          : `Refused by ${error.layer === 'sdk' ? 'the SDK' : error.layer}, with reason code ${error.code}. ${error.message}`,
        structured: {
          status: failed ? 'failed' : 'refused',
          code: error.code,
          layer: error.layer,
          sentence: error.message,
          retry: whenRetryPasses(error),
          amounts: {
            needed: dollars(error.amounts.needed),
            left: dollars(error.amounts.left),
            heldAtOnce: dollars(error.amounts.authority),
            perCommitment: dollars(error.amounts.capPerCommitment),
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
        if (name === 'connect') return await connect(args)
        if (name === 'status') return connectionAnswer(await connection.state())
        if (!SANDBOX_TOOLS.includes(name as SandboxTool)) {
          return { text: `There's no tool named ${name}.`, structured: {}, isError: true }
        }
        const waiting = await unready()
        if (waiting) return waiting
        if (name === 'authority') return await authority()
        if (name === 'book') return await book(args)
        return await commitments()
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
              "These tools act as one business's agent on Avow's sandbox, on Tempo's testnet, with test dollars. Until the agent is connected, connect asks the business for authority and gives a pairing code and a link for the business's administrator to approve on their phone. Only the administrator approves, and the agent's key never leaves this machine. Once connected, the agent commits the business only within the mandate the business signed. A refusal comes from the SDK checking the mandate on this machine, from Avow, from Avow's relay, from the lock or from the account's keychain. It names which, gives the reason code and the amounts, and says when the same booking could pass. A reserve that never landed with no reason given comes back as a failure, and the same booking might pass on another try.",
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
  const ask = existsSync(join(dir, SANDBOX_DIR, 'agent.json'))
    ? 'ask it to book $200 of GPU compute'
    : 'ask it to connect to your Avow business, with the business ID your console shows'
  if (client === 'claude-code') {
    const shell = process.platform === 'win32'
    // An entry an earlier version added for this folder would stop the new one, so it goes first.
    // Removing one that isn't there fails quietly.
    spawnSync('claude', ['mcp', 'remove', SERVER.name], { stdio: 'ignore', shell })
    const line = ['claude', 'mcp', 'add', SERVER.name, '--', process.execPath, ...args]
    const result = spawnSync(line[0] as string, line.slice(1), {
      stdio: 'inherit',
      shell,
    })
    if (result.error || result.status !== 0) {
      console.log(
        `\nClaude Code didn't take it. Run this in this folder yourself:\n\n  ${line.map((a) => JSON.stringify(a)).join(' ')}\n`,
      )
      return 1
    }
    console.log(`\nAdded. Run claude in this folder and ${ask}.`)
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
    console.log(`Added to ${file}. Restart Claude Desktop and ${ask}.`)
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
/**
 * `avow-sandbox-mcp [add <client> | --dir <folder>]`, which `avow-sandbox mcp` runs too, so npx
 * finds it with nothing installed first.
 */
export function mcpCommand(argv: readonly string[]): void {
  if (argv[0] === 'add') {
    process.exitCode = add(argv[1], process.cwd())
    return
  }
  const at = argv.indexOf('--dir')
  const dir = resolve(at >= 0 ? (argv[at + 1] ?? '.') : '.')
  // Standard output carries the protocol, so anything the SDK prints goes to standard error.
  console.log = (...items: unknown[]) => console.error(...items)
  serve(dir)
}

if (isMain) mcpCommand(process.argv.slice(2))

export { SANDBOX_TOOLS }
