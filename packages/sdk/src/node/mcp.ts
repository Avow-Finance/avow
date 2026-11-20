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
  offerVersionId,
  refusalSentence,
  SANDBOX_TOOLS,
  type SandboxTool,
  type ServiceOrder,
  serviceOfferQuote,
  toWire,
  whenRetryPasses,
} from '@avow-finance/spec'
import { setRequestClient } from '../http.js'
import { PREFLIGHT_UNCHECKED, Refusal, type SandboxAgent, sandboxAgent } from '../sandbox/agent.js'
import {
  type SandboxServices,
  type ServiceBuyOutcome,
  sandboxServices,
} from '../sandbox/services.js'
import { sessionUrl, verifyUrl } from '../sandbox/session.js'
import { checkShared, isPayee, sharedJson, sharedSentences } from '../sandbox/shared.js'
import { APPROVAL_CARD_MIME, APPROVAL_CARD_URI, approvalCardHtml } from './approval-card.js'
import { type Connection, mcpConnection } from './mcp-connection.js'
import { fileStore, SANDBOX_DIR, takeRun } from './platform.js'
import {
  bookingSentence,
  type OfferInput,
  offerSentences,
  orderSentence,
  outcomeSentence,
  readOfferInput,
  readSharedOffer,
  unfinishedFor,
} from './services.js'

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
/** How long ordering a service waits for the other agent's next step before it answers. */
const ORDER_WAIT_MS = 45_000

const usd = (dollars: number | null) =>
  dollars === null ? 'no limit' : formatUsd(BigInt(Math.round(dollars * 1_000_000)))

const noInput = { type: 'object', properties: {}, additionalProperties: false } as const

/**
 * The tools that need no authority: setting the agent up, and checking a commitment someone else
 * shared, which any agent can do without connecting.
 */
type FreeTool = 'connect' | 'status' | 'verify'

/**
 * The tools for services between two agents. The first two and `sell` are a supplier's, for an
 * agent connected to sell, and `order` is a buyer's. They act under the same mandate and keys as
 * the rest, and none reports to the runner's screen.
 */
const SERVICE_TOOLS = ['publish_offer', 'offers', 'order', 'orders', 'sell'] as const
type ServiceTool = (typeof SERVICE_TOOLS)[number]

/** The tools, kept to what shows the authority model and nothing more. */
export const MCP_TOOLS = [
  {
    name: 'connect',
    title: 'Connect to a business',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    description:
      "Asks for the authority to commit for a business, with a key this agent makes and keeps on this machine. Leave business out unless your person gave you its ID: the link then lets them sign in, or set up their business, and approve in one place. It answers with a pairing code and a link for your person to open on their phone, and keeps waiting in the background. Only the business's administrator can approve, with their passkey, and the approval sets this agent's limits. Calling it again answers with the same request.",
    inputSchema: {
      type: 'object',
      properties: {
        business: {
          type: 'string',
          description:
            'The business ID, only if your person gave you one. Leave it out and whoever approves through the link chooses their business.',
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
      required: [],
      additionalProperties: false,
    },
    // A client that renders MCP Apps shows the approval card with the answer. The text answer
    // carries the same pairing code and link, for every client that doesn't.
    _meta: { ui: { resourceUri: APPROVAL_CARD_URI } },
  },
  {
    name: 'status',
    title: 'Connection status',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    description:
      'Where this agent stands with its business. It is not connected yet, waiting for approval with its pairing code and link, connected under a mandate with the date it ends, or failed with the reason.',
    inputSchema: noInput,
  },
  {
    name: 'authority',
    title: 'What the agent can commit',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    description:
      "What your agent can commit right now. It has two limits. It holds at most so much in bookings at once, which Avow refuses past and the lock checks against Avow's approval. Its key moves at most so much a day, a limit the business set on chain. It names the suppliers the agent may book too.",
    inputSchema: noInput,
  },
  {
    name: 'check',
    title: 'Check a booking',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    description:
      "Says whether a booking would pass right now, without booking it or moving any money. It runs the mandate check Avow runs, against what the lock holds under the mandate, and what the key can still move today. A booking that wouldn't pass comes back with the reason code, the layer that would refuse it, the amounts and when it could pass. Avow's relay budget and the supplier's own answer aren't checked, since only booking asks them.",
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
    name: 'book',
    title: 'Book GPU capacity',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
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
    name: 'verify',
    title: 'Check a shared commitment',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    description:
      "Checks a commitment another agent shared, such as a buyer's agent sending its link to a supplier. It reads the lock on Tempo through the factory this server trusts, never Avow, and needs no connection or authority. It says whether the chain backs the commitment, how much the lock holds, where it stands, who it pays, and when free cancellation ends and the reserve releases. Give payee, your payout address, and it says whether the commitment pays you. A commitment the chain doesn't back comes back with its reason code.",
    inputSchema: {
      type: 'object',
      properties: {
        link: {
          type: 'string',
          description: 'The link the other agent shared, with #verify=, or the token after it',
        },
        payee: {
          type: 'string',
          description: 'Your payout address, to check the commitment pays you',
        },
      },
      required: ['link'],
      additionalProperties: false,
    },
  },
  {
    name: 'commitments',
    title: 'List commitments',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    description:
      'Lists every commitment your agent made, with its state on the lock, whether the current authority made it, and a link anyone can open to check it.',
    inputSchema: noInput,
  },
  {
    name: 'publish_offer',
    title: 'Publish an offer',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description:
      "Publishes an offer of a service your business sells by the unit at a fixed price, such as a transcript or a design review, for an agent connected to sell. It keeps the offer in this folder and answers with the offer to hand a buyer's agent, which orders from it. Nothing is sent to Avow and no directory lists it. Both charges are yours to set, since a booking reserves the larger of them from the buyer and the supplier can charge nothing else. Publishing an item of the same name again replaces its offer, and orders for the old one are no longer quoted.",
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'What the offer sells, such as "Transcript"' },
        summary: { type: 'string', description: 'One sentence on what the buyer gets' },
        price: { type: 'number', description: 'The price of one unit in dollars, such as 50' },
        evidence: { type: 'string', description: 'What counts as evidence of delivery' },
        late_cancellation_percent: {
          type: 'number',
          description:
            'What cancelling after free cancellation ends can cost, as a percentage of the price from 0 to 100',
        },
        no_show_percent: {
          type: 'number',
          description:
            'What the buyer not being there to take delivery can cost, as a percentage of the price from 0 to 100. One of the two charges has to be above zero',
        },
        lead_hours: {
          type: 'number',
          description: 'How long after booking you deliver by, 24 hours when left out',
        },
        max_per_booking: {
          type: 'integer',
          description: 'The most units one booking takes, 1 when left out',
        },
        per_day: {
          type: 'integer',
          description:
            'How many bookings you take in a day, 10 when left out. This agent counts each order it quotes against it',
        },
        free_cancel_hours: {
          type: 'number',
          description:
            'How long after booking the buyer can cancel at no charge. Left out, no booking is free to cancel',
        },
        payment: {
          type: 'string',
          enum: ['transfer', 'invoice'],
          description:
            'How the buyer pays the price, transfer when left out. The reserve never secures the price',
        },
        payment_due_days: {
          type: 'number',
          description: 'How long after the delivery deadline payment is due, 7 days when left out',
        },
      },
      required: [
        'name',
        'summary',
        'price',
        'evidence',
        'late_cancellation_percent',
        'no_show_percent',
      ],
      additionalProperties: false,
    },
  },
  {
    name: 'offers',
    title: 'List published offers',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description:
      "Lists the offers your business has published from this folder, each with its id, its rules in words and the offer itself to hand a buyer's agent.",
    inputSchema: noInput,
  },
  {
    name: 'order',
    title: 'Order a service',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    description:
      "Orders units of a service from the offer a supplier's agent gave you, and sees the order through. It sends the order with nothing reserved, waits for the supplier's quote, checks the quote carries exactly the terms the offer builds, funds the commitment under your mandate and waits for the supplier to accept. The reserve is the larger of the offer's two charges, and it backs only those charges. The price is paid separately, by the route the offer names. Each step waits on the other agent, so the tool answers with where the order stands after a while, and this server keeps seeing the order through while it runs. Call it again with the order's id to read where it got to, which never makes a second commitment. A refusal comes back with its reason code.",
    inputSchema: {
      type: 'object',
      properties: {
        offer: {
          type: 'object',
          description:
            "The offer, whole, as the supplier's agent gave it. Leave it out when you give order",
        },
        quantity: { type: 'integer', description: 'How many units, 1 when left out' },
        order: {
          type: 'string',
          description: 'The id of an order you already sent, to carry it on',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'orders',
    title: 'List service orders',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    description:
      "Lists the service orders waiting on your agent. As a supplier, those are new orders to quote and funded ones to accept. As a buyer, those are the orders you sent and haven't seen through, each with where it stands.",
    inputSchema: noInput,
  },
  {
    name: 'sell',
    title: 'Quote or accept an order',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    description:
      "Takes the next step on a service order to your business, for an agent connected to sell. A new order is quoted, which signs your business's agreement to the terms the offer builds, so the buyer can fund it. A funded order is accepted on the buyer's lock, after the open verifier's checks pass. It quotes only an offer your business published from this folder, since the offer in an order is the buyer's copy, and it refuses an order past the offer's bookings for the day. To decline an order, leave it, and it lapses with nothing reserved.",
    inputSchema: {
      type: 'object',
      properties: {
        order: { type: 'string', description: 'The id of the order, from orders' },
      },
      required: ['order'],
      additionalProperties: false,
    },
  },
] as const satisfies readonly {
  name: SandboxTool | FreeTool | ServiceTool
  /** What a client shows for the tool. */
  title: string
  /**
   * How the tool acts, for clients that ask before running one. Booking and ordering add a
   * commitment and move money into a reserve, so they're neither read-only nor idempotent, and
   * nothing destroys. Every tool reaches Avow or the chain, so each is open-world, but the two
   * that only read and keep a supplier's offers in its folder.
   */
  annotations: {
    readOnlyHint: boolean
    destructiveHint: boolean
    idempotentHint: boolean
    openWorldHint: boolean
  }
  description: string
  inputSchema: object
  _meta?: { ui: { resourceUri: string } }
}[]

/** The card the server serves, as `resources/list` and `resources/read` describe it. */
const APPROVAL_CARD = {
  uri: APPROVAL_CARD_URI,
  name: 'approval-card',
  title: 'Approval request',
  description: "Where this agent's request for authority stands, with its pairing code and link.",
  mimeType: APPROVAL_CARD_MIME,
} as const

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
        "This agent isn't connected to a business yet. To connect it, call connect with no business unless your person gave you its ID, and send your person the link it gives.",
      )
    case 'saved':
      return answer(
        c.businessId
          ? `This agent asked ${c.businessId} for authority earlier, and nothing is waiting on that request now. Call connect with the same business to keep waiting, with the same pairing code.`
          : 'This agent asked for authority earlier without naming a business, and nothing is waiting on that request now. Call connect with no business to keep waiting, with the same pairing code.',
      )
    case 'waiting':
      return answer([
        c.businessId
          ? `Asked ${c.businessId} for authority, as "${c.label}", with pairing code ${c.pairingCode}.`
          : `Asked for authority, as "${c.label}", with pairing code ${c.pairingCode}, from whichever business approves it.`,
        c.businessId
          ? `Send your person this link to review the request, on their phone or anywhere else: ${c.link}`
          : `Send your person this link, on their phone or anywhere else. They sign in, or set up their business, and approve there: ${c.link}`,
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
        `Connecting${c.businessId ? ` to ${c.businessId}` : ''} failed. ${c.reason} Call connect to try again.`,
        true,
      )
  }
}

/** The MCP agent for one folder, answering each tool call through the SDK's agent. */
export function mcpAgent(dir: string, options: { fetch?: typeof fetch; pollEvery?: number } = {}) {
  const store = fileStore(join(dir, SANDBOX_DIR))
  const log = (line: string) => process.stderr.write(`${line}\n`)
  const connection = mcpConnection({
    store,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })

  async function connect(args: Record<string, unknown>): Promise<ToolAnswer> {
    // Left out, the agent asks whoever opens its link. Given, it has to be an ID.
    const business = typeof args.business === 'string' ? args.business.trim() : null
    if (business === '') {
      throw new RangeError(
        'Leave business out to ask whoever approves through the link, or give the business ID from the console.',
      )
    }
    const c = await connection.start({
      businessId: business,
      label: typeof args.name === 'string' && args.name.trim() !== '' ? args.name.trim() : null,
      sell: args.sell === true,
    })
    return connectionAnswer(c, business ?? undefined)
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

  async function check(args: Record<string, unknown>): Promise<ToolAnswer> {
    const reserve = args.reserve
    if (typeof reserve !== 'number') throw new RangeError('The check needs a reserve in dollars')
    const agent = await open('check')
    const gpu = typeof args.gpu === 'string' ? args.gpu : 'H100'
    const count = typeof args.count === 'number' ? args.count : 8
    const hours = typeof args.hours === 'number' ? args.hours : 1
    const supplier =
      typeof args.supplier === 'string' ? args.supplier : (agent.suppliers[0]?.id ?? '')
    const answer = await agent.check({ supplier, resource: { gpu, count, hours }, reserve })
    const dollars = (micros: bigint | null) => (micros === null ? null : Number(micros) / 1_000_000)
    const amounts = {
      needed: dollars(answer.amounts.needed),
      heldAtOnceLeft: dollars(answer.amounts.left),
      heldAtOnce: dollars(answer.amounts.authority),
      perCommitment: dollars(answer.amounts.capPerCommitment),
      movedPerDay: dollars(answer.amounts.dailyLimit),
      movedTodayLeft: dollars(answer.amounts.dailyLeft),
    }
    const unchecked = `It doesn't check ${PREFLIGHT_UNCHECKED.join(' or ')}, so booking can still be refused there.`
    if (answer.passes) {
      return {
        text: [
          `Booking ${usd(reserve)} with ${supplier} for ${count} ${gpu} for ${hours} hour${hours === 1 ? '' : 's'} would pass now, and nothing was booked.`,
          `Your agent has ${usd(amounts.heldAtOnceLeft)} left of its ${usd(amounts.heldAtOnce)} held at once, and its key ${usd(amounts.movedTodayLeft)} of today's ${usd(amounts.movedPerDay)}.`,
          unchecked,
        ].join(' '),
        structured: {
          status: 'would_pass',
          supplier,
          resource: { gpu, count, hours },
          amounts,
          unchecked: [...PREFLIGHT_UNCHECKED],
        },
        isError: false,
      }
    }
    const refused = { code: answer.code, layer: answer.layer, amounts: answer.amounts }
    return {
      text: [
        `Booking ${usd(reserve)} with ${supplier} wouldn't pass: ${answer.layer === 'sdk' ? 'the SDK' : answer.layer} would refuse it, with reason code ${answer.code}. Nothing was booked.`,
        refusalSentence(refused),
        whenRetryPasses(refused),
      ].join(' '),
      structured: {
        status: 'would_be_refused',
        code: answer.code,
        layer: answer.layer,
        sentence: refusalSentence(refused),
        retry: whenRetryPasses(refused),
        supplier,
        amounts,
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

  async function verify(args: Record<string, unknown>): Promise<ToolAnswer> {
    const link = typeof args.link === 'string' ? args.link : ''
    if (link.trim() === '') throw new RangeError('The check needs the link the other agent shared')
    const payee =
      typeof args.payee === 'string' && args.payee.trim() !== '' ? args.payee.trim() : null
    if (payee !== null && !isPayee(payee)) throw new RangeError(`${payee} isn't an address`)
    const checked = await checkShared(payee ? { link, payee } : { link })
    return {
      text: sharedSentences(checked).join(' '),
      structured: sharedJson(checked),
      isError: false,
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

  const services = (): Promise<SandboxServices> =>
    sandboxServices({ store, ...(options.fetch ? { fetch: options.fetch } : {}) })

  const shared = (version: Parameters<typeof offerVersionId>[0]) => ({
    id: offerVersionId(version),
    offer: toWire(version),
  })

  async function publishOffer(args: Record<string, unknown>): Promise<ToolAnswer> {
    const draft = readOfferInput(args as OfferInput)
    if ('error' in draft) throw new RangeError(draft.error)
    const { version, id } = await (await services()).publish(draft)
    return {
      text: [
        `Published offer ${id}, kept in this folder. Nothing was sent to Avow, and no directory lists it.`,
        ...offerSentences(version),
        "Hand the buyer's agent the offer below, whole, and it orders from it with its order tool. Call orders to see what comes, and sell to quote and accept.",
        JSON.stringify(toWire(version)),
      ].join(' '),
      structured: shared(version),
      isError: false,
    }
  }

  async function offers(): Promise<ToolAnswer> {
    const published = await (await services()).published()
    return {
      text:
        published.length === 0
          ? 'Your business has published no offers from this folder. Call publish_offer to make one.'
          : published
              .map((v) =>
                [
                  `Offer ${offerVersionId(v)}.`,
                  ...offerSentences(v),
                  JSON.stringify(toWire(v)),
                ].join(' '),
              )
              .join('\n'),
      structured: { offers: published.map(shared) },
      isError: false,
    }
  }

  /**
   * The orders this server is seeing through, by id. Buying waits on another agent, so it runs
   * past the tool call that started it, and a later call reads how it ended. An order outlives
   * the server in the folder, where the next call picks it up again.
   */
  const buying = new Map<
    string,
    { ended: ServiceBuyOutcome | null; failed: { error: unknown } | null }
  >()

  function seeThrough(mine: SandboxServices, orderId: string) {
    const run: NonNullable<ReturnType<typeof buying.get>> = { ended: null, failed: null }
    buying.set(orderId, run)
    const every = options.pollEvery ? { pollEvery: options.pollEvery } : {}
    mine.buy({ resume: orderId, ...every }).then(
      (outcome) => {
        run.ended = outcome
      },
      (error: unknown) => {
        run.failed = { error }
      },
    )
    return run
  }

  const orderFacts = (order: ServiceOrder) => {
    const quote = serviceOfferQuote(order.offer, order.quantity)
    const dollars = (micros: bigint) => Number(micros) / 1_000_000
    return {
      order: order.orderId,
      status: order.status,
      supplier: order.offer.supplier,
      buyer: order.buyer.businessId,
      item: order.offer.item.name,
      quantity: order.quantity,
      price: dollars(quote.total),
      reserve: dollars(quote.reserve),
      offer: offerVersionId(order.offer),
      commitmentId: order.commitmentId,
      expiry: Number(order.expiry),
    }
  }

  /** The link anyone can open to check a funded order's commitment. */
  const linkOf = (order: ServiceOrder) =>
    order.status === 'reserved' || order.status === 'accepted'
      ? verifyUrl({
          kind: 'commitment',
          chainId: order.buyer.chainId,
          lock: order.buyer.lock,
          commitmentId: order.commitmentId,
          side: 'buyer',
          termsHash: order.quote.agreement.termsHash,
        })
      : null

  async function order(args: Record<string, unknown>): Promise<ToolAnswer> {
    const mine = await services()
    let orderId = typeof args.order === 'string' ? args.order.trim() : ''
    const said: string[] = []
    if (orderId === '') {
      const offer = readSharedOffer(args.offer)
      if (!offer) {
        throw new RangeError(
          "Give the offer, whole, as the supplier's agent gave it, or the id of an order you sent.",
        )
      }
      const quantity = args.quantity === undefined ? 1 : args.quantity
      if (typeof quantity !== 'number') throw new RangeError('The quantity is a number of units')
      said.push(bookingSentence(offer, quantity))
      // An order for the same offer and quantity that was never seen through is carried on, so
      // asking twice sends one order.
      const left = await unfinishedFor(mine, offer, quantity)
      orderId = left ?? (await mine.order({ offer, quantity })).orderId
      if (left) said.push('You had sent this order already, so it carries on from where it stood.')
    }
    const known = (await mine.unfinished()).some((r) => r.orderId === orderId)
    const run = buying.get(orderId) ?? (known ? seeThrough(mine, orderId) : null)
    if (run) {
      const started = Date.now()
      while (!run.ended && !run.failed && Date.now() - started < ORDER_WAIT_MS) {
        await new Promise((done) => setTimeout(done, 500).unref())
      }
    }
    if (run?.failed) {
      // The order is still kept in the folder, so calling again picks it up.
      buying.delete(orderId)
      throw run.failed.error
    }
    const outcome = run?.ended ?? null
    if (outcome) buying.delete(orderId)
    // An order this folder no longer keeps was seen through earlier, and the mailbox still has it.
    const now = outcome ? outcome.order : await mine.read(orderId)
    const link = linkOf(now)
    return {
      text: [
        ...said,
        orderSentence(now),
        outcome
          ? outcomeSentence(outcome)
          : now.status === 'accepted' || now.status === 'expired'
            ? ''
            : `This server keeps seeing it through. Call order again with order ${orderId} to read where it got to.`,
        link ? `Anyone can check the commitment at ${link}` : '',
      ]
        .filter(Boolean)
        .join(' '),
      structured: {
        ...orderFacts(now),
        ended: outcome ? (outcome.ok ? 'accepted' : outcome.reason) : null,
        link,
      },
      isError: false,
    }
  }

  async function orders(): Promise<ToolAnswer> {
    const mine = await services()
    // An agent connected only to buy has no inbox, which isn't an error here.
    const selling = await mine.inbox().catch(() => null)
    const sent = await Promise.all((await mine.unfinished()).map((r) => mine.read(r.orderId)))
    const lines = [
      ...(selling ?? []).map(
        (o) =>
          `To your business. ${orderSentence(o)} ${o.status === 'requested' ? 'Call sell to quote it.' : 'Call sell to accept it.'}`,
      ),
      ...sent.map((o) => `From you. ${orderSentence(o)}`),
    ]
    return {
      text:
        lines.length === 0
          ? selling === null
            ? "You've sent no orders that are still open. This agent wasn't connected to sell, so it has no inbox."
            : 'No orders are waiting on your business, and you have none of your own still open.'
          : lines.join('\n'),
      structured: {
        selling: selling === null ? null : selling.map(orderFacts),
        buying: sent.map(orderFacts),
      },
      isError: false,
    }
  }

  async function sell(args: Record<string, unknown>): Promise<ToolAnswer> {
    const orderId = typeof args.order === 'string' ? args.order.trim() : ''
    if (orderId === '') throw new RangeError('Give the id of the order, from orders')
    const mine = await services()
    const waiting = (await mine.inbox()).find((o) => o.orderId === orderId)
    if (!waiting) {
      return {
        text: `No order ${orderId} is waiting on your business. It may have lapsed, or its next step is the buyer's.`,
        structured: { order: orderId, step: null },
        isError: true,
      }
    }
    let acceptedIn: string | null = null
    await mine.sell(waiting, (step) => {
      if (step.step === 'accepted') acceptedIn = step.acceptedIn
    })
    const quoted = waiting.status === 'requested'
    return {
      text: quoted
        ? `Quoted. ${bookingSentence(waiting.offer, waiting.quantity)} The buyer's agent funds it next. Call orders to see once it has, then sell again to accept.`
        : `Accepted order ${orderId} on the buyer's lock, so the commitment stands. Deliver by the terms' deadline.`,
      structured: { ...orderFacts(waiting), step: quoted ? 'quoted' : 'accepted', acceptedIn },
      isError: false,
    }
  }

  const isServiceTool = (name: string): name is ServiceTool =>
    (SERVICE_TOOLS as readonly string[]).includes(name)

  return {
    async call(name: string, args: Record<string, unknown>): Promise<ToolAnswer> {
      try {
        if (name === 'connect') return await connect(args)
        if (name === 'status') return connectionAnswer(await connection.status())
        if (name === 'verify') return await verify(args)
        if (!SANDBOX_TOOLS.includes(name as SandboxTool) && !isServiceTool(name)) {
          return { text: `There's no tool named ${name}.`, structured: {}, isError: true }
        }
        const waiting = await unready()
        if (waiting) return waiting
        if (name === 'publish_offer') return await publishOffer(args)
        if (name === 'offers') return await offers()
        if (name === 'order') return await order(args)
        if (name === 'orders') return await orders()
        if (name === 'sell') return await sell(args)
        if (name === 'authority') return await authority()
        if (name === 'check') return await check(args)
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
        // The business's console shows which client the agent says it runs in, from this.
        const info = params.clientInfo as { name?: unknown } | undefined
        setRequestClient(typeof info?.name === 'string' ? `MCP: ${info.name}` : 'MCP')
        write({
          id,
          result: {
            protocolVersion:
              typeof asked === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : PROTOCOL,
            capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
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
      case 'resources/list':
        write({ id, result: { resources: [APPROVAL_CARD] } })
        return
      case 'resources/read': {
        if (params.uri !== APPROVAL_CARD_URI) {
          write({
            id,
            error: { code: -32002, message: `Resource not found: ${String(params.uri)}` },
          })
          return
        }
        write({
          id,
          result: {
            contents: [
              {
                uri: APPROVAL_CARD_URI,
                mimeType: APPROVAL_CARD_MIME,
                text: approvalCardHtml(),
                // The card loads nothing from anywhere and opens the link through the client.
                _meta: {
                  ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } },
                },
              },
            ],
          },
        })
        return
      }
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
    : 'ask it to connect to your Avow business'
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
