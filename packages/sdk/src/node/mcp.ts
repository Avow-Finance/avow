#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import {
  AGENT_LABEL_MAX,
  AGENT_LABEL_RULE,
  type ApprovalRequest,
  agentLabelOf,
  agentLabelProblem,
  DECLINE_RETRY_MAX,
  type DeclineReason,
  describeReason,
  formatUsd,
  isApprovalRequestId,
  isJobOfferVersion,
  isSessionId,
  type OfferVersion,
  type OrderDeclineRequest,
  offerIdOf,
  offerVersionId,
  publishedOffer,
  quotedLabel,
  refusalSentence,
  SANDBOX_TOOLS,
  type SandboxTool,
  SERVICE_QUANTITY_MAX,
  type ServiceOfferVersion,
  type ServiceOrder,
  sellerMandateTermsJson,
  serviceOfferQuote,
  TEST_BUSINESS_LABEL,
  threadStateAt,
  toWire,
  whenRetryPasses,
} from '@avow-finance/spec'
import type { Hex } from 'viem'
import { setRequestClient } from '../http.js'
import {
  agentRequest,
  agentTopUp,
  PREFLIGHT_UNCHECKED,
  Refusal,
  type SandboxAgent,
  SERVICE_PREFLIGHT_UNCHECKED,
  sandboxAgent,
} from '../sandbox/agent.js'
import { sandboxCommitmentEvents } from '../sandbox/commitment-events.js'
import { type AskedChange, changeWords } from '../sandbox/requests.js'
import { SellerMandateRefusal } from '../sandbox/seller-mandate.js'
import {
  type SandboxServices,
  type ServiceBuyOutcome,
  sandboxServices,
} from '../sandbox/services.js'
import { sessionUrl, verifyUrl } from '../sandbox/session.js'
import { checkShared, isPayee, sharedJson, sharedSentences } from '../sandbox/shared.js'
import { toDollars } from '../sandbox/terms.js'
import { sandboxTestSellers } from '../sandbox/test-sellers.js'
import { APPROVAL_CARD_MIME, APPROVAL_CARD_URI, approvalCardHtml } from './approval-card.js'
import { addToClient, isMcpClient, MCP_CLIENTS, mcpServersJson } from './mcp-clients.js'
import { type Connection, mcpConnection } from './mcp-connection.js'
import { fileStore, SANDBOX_DIR, takeRun } from './platform.js'
import {
  bookingSentence,
  declineSentence,
  declineWaiting,
  type OfferInput,
  offerSentences,
  orderSentence,
  outcomeSentence,
  readOfferInput,
  readSharedOffer,
  SELLER_DECLINE_REASONS,
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
 *   avow-sandbox-mcp add cursor                adds it to this folder's .cursor/mcp.json
 *   avow-sandbox-mcp add vscode                adds it to VS Code through code --add-mcp
 *   avow-sandbox-mcp add codex                 adds it to Codex through codex mcp add
 *   avow-sandbox-mcp add config                prints the mcpServers block any other client reads
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
 * The tools that need no authority: setting the agent up, checking a commitment someone else
 * shared, and reading the test sellers the sandbox lists, which any agent can do without
 * connecting.
 */
type FreeTool = 'connect' | 'status' | 'verify' | 'test_sellers'

/**
 * The tools for services between two agents. `order` and `withdraw_order` are a buyer's, and
 * `order` funds under the agent's mandate like any other commitment. The first four, `sell` and
 * `decline` are a supplier's, and `thread` reads a thread order for either side, for an agent
 * connected to sell. A supplier's agent is held by its signing key, the offers in its folder and,
 * once Avow serves one, the seller's mandate its own SDK holds it to, and the tools say which
 * stand. `list_offer` and `withdraw_listing` reach Avow, which lists an offer only where it holds
 * seller's mandates and only after checking the offer against the agent's newest one. None reports
 * to the runner's screen.
 */
const SERVICE_TOOLS = [
  'publish_offer',
  'offers',
  'list_offer',
  'withdraw_listing',
  'order',
  'orders',
  'sell',
  'decline',
  'withdraw_order',
  'thread',
] as const
type ServiceTool = (typeof SERVICE_TOOLS)[number]

/**
 * The tools for the business's own test dollars, which need authority but widen nothing an agent
 * may commit, and report nothing to the runner's screen.
 */
const FUNDS_TOOLS = ['top_up'] as const
type FundsTool = (typeof FUNDS_TOOLS)[number]

/**
 * The tools that ask the business for a change to the agent's authority, and read where it stands.
 * They ask and read: only the business's administrator decides, with their passkey.
 */
const REQUEST_TOOLS = ['request_change', 'request_seller_mandate', 'request_status'] as const
type RequestTool = (typeof REQUEST_TOOLS)[number]

/**
 * The tools that read what a lock logged, from the chain alone. They open no key, sign nothing and
 * report nothing to the runner's screen.
 */
const EVENT_TOOLS = ['commitment_events'] as const
type EventTool = (typeof EVENT_TOOLS)[number]

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
          maxLength: AGENT_LABEL_MAX,
          description: `The name the administrator sees, which says what this agent does, such as "Research agent". ${AGENT_LABEL_RULE}.`,
        },
        sell: {
          type: 'boolean',
          description:
            'Also ask to quote and accept jobs and service orders for the business, with a signing key of its own. No limit the administrator sets applies to what it sells. Leave it out to only buy.',
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
    title: 'Check a booking or an order',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    description:
      "Says whether a GPU booking or a service order would pass right now, without booking, ordering or moving any money. Give a reserve to check a GPU booking, or an offer to check an order for a service. Either way it runs the mandate check Avow runs, under the mandate your agent holds now, against what the lock holds under it and what the key can still move today. For an order it also prices the offer in that quantity and asks Avow whether it knows the seller. The mandate's limits count the reserve. A service's price is paid outside the lock and no limit counts it, so the answer gives the price for you to weigh. A check that wouldn't pass comes back with the reason code, the layer that would refuse it, the amounts and when it could pass. It can't know Avow's relay budget or the other side's answer, and for an order it can't know whether the seller still publishes that offer or has capacity left.",
    inputSchema: {
      type: 'object',
      properties: {
        reserve: {
          type: 'number',
          description: 'For a GPU booking, the reserve in dollars, such as 200',
        },
        gpu: { type: 'string', description: 'The GPU model, H100 when left out' },
        count: { type: 'integer', description: 'How many GPUs, 8 when left out' },
        hours: { type: 'number', description: 'How many hours, 1 when left out' },
        supplier: {
          type: 'string',
          description: "The supplier's business id, the agent's first supplier when left out",
        },
        offer: {
          type: 'object',
          description:
            "For a service order, the offer, whole, as the supplier's agent gave it. Leave reserve out",
        },
        quantity: { type: 'integer', description: 'How many units of the offer, 1 when left out' },
      },
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
    name: 'commitment_events',
    title: "Read a commitment's events",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    description:
      "Reads what your business's lock logged for one of the commitments `commitments` lists, from Tempo's final blocks, oldest first: the reserve landing, the supplier's acceptance, each charge and its outcome, and the release. It reads the lock and never Avow, so Avow's own records, such as its approval, aren't in it. An event is a notice that grants nothing and proves nothing on its own, so before you act on one, check the commitment with `verify`, which reads the lock. One call reads a bounded run of blocks, and when it stops short of the latest final block it gives `next`, the block to read from on the next call.",
    inputSchema: {
      type: 'object',
      properties: {
        commitmentId: {
          type: 'string',
          description: "The commitment's id, from its reference in `commitments`",
        },
        from: {
          type: 'string',
          description:
            'The block to read from, as the last call gave it in next. Left out, the read starts where the commitment did',
        },
      },
      required: ['commitmentId'],
      additionalProperties: false,
    },
  },
  {
    name: 'top_up',
    title: "Top up the business's test dollars",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    description:
      "Asks the sandbox faucet to send your business more test dollars, when it's running low. They go to the business's own account, never its lock, so they change nothing your agent may commit: its mandate still sets that. A business gets one top-up a day, and asking again sooner sends nothing and says when it can. Test dollars have no value.",
    inputSchema: noInput,
  },
  {
    name: 'request_change',
    title: 'Ask for a change to authority',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    description:
      "Asks your business's administrator for a change to what your agent may commit, when a booking needs it: a higher limit, a supplier named on the lock and in your mandate, or the lock opened to suppliers listed in the testnet's registry up to a cap. It only asks. It answers with a link for your person to open, where the administrator approves or declines with their passkey, and nothing changes until then. The request lapses after a day unanswered. Keep within your current authority until request_status says the request is active, and asking again while it waits answers with the same request.",
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['raise_limit', 'name_supplier', 'open_mode'],
          description:
            'raise_limit for a higher limit, name_supplier for one supplier, or open_mode for every supplier the testnet registry lists, up to a cap',
        },
        limit: {
          type: 'string',
          enum: ['per_commitment', 'open_reserves'],
          description:
            'For raise_limit: per_commitment for the most one booking can reserve, or open_reserves for the most held in bookings at once',
        },
        to: {
          type: 'number',
          description: 'For raise_limit: the new limit in dollars, above what it is now',
        },
        supplier: {
          type: 'string',
          description: "For name_supplier: the supplier's Avow business id",
        },
        cap: {
          type: 'number',
          description:
            'For open_mode: the most in dollars the lock may hold with listed suppliers at once, for every agent of the business',
        },
      },
      required: ['kind'],
      additionalProperties: false,
    },
    // A client that renders MCP Apps shows the request card with the answer, which waits on the
    // request. The text answer carries the same link, for every client that doesn't.
    _meta: { ui: { resourceUri: APPROVAL_CARD_URI } },
  },
  {
    name: 'request_seller_mandate',
    title: "Ask for a seller's mandate",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    description:
      "Asks your business's administrator for a seller's mandate: the limits on what your agent may sell, for the signing key it sells with. Ask your person for every limit and never choose them yourself. It only asks. It answers with a link for your person to open, where the administrator approves or declines with their passkey, and nothing changes until then. Avow doesn't take seller's mandate requests yet, and then it says so and nothing is asked. Avow doesn't enforce seller limits yet either. Your agent holds itself to its newest mandate before it publishes, quotes or accepts. Call request_status to see where the request stands.",
    inputSchema: {
      type: 'object',
      properties: {
        terms: {
          type: 'object',
          description:
            'The mandate\'s terms exactly as the spec writes a SellerMandate without mandateId, businessId, account, nonce and replaces: signingKey, currency, limits, maxOrderValue, maxOutstanding, maxDeliveryHorizon, minLateCancellationBps, minNoShowBps, maxFreeCancelWindow, buyers, excludedBuyers, excludedCountries, requiresBusinessCheck, negotiable, approvalRule and expiry. Amounts are decimal strings of micros, so $40 is "40000000", and times are decimal strings of seconds',
        },
      },
      required: ['terms'],
      additionalProperties: false,
    },
    _meta: { ui: { resourceUri: APPROVAL_CARD_URI } },
  },
  {
    name: 'request_status',
    title: 'Where a request stands',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    description:
      "Where one of your agent's requests stands: waiting for the administrator, approved and landing, active so your agent can use the change, or ended as declined, lapsed, out of date or failed.",
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The request id request_change or request_seller_mandate answered with',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
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
      "Publishes an offer of a service your business sells by the unit at a fixed price, such as a transcript or a design review, for an agent connected to sell. It keeps the offer in this folder and answers with the offer to hand a buyer's agent, which orders from it. Nothing is sent to Avow until list_offer lists it. Take the price and both charges from your person and never choose them yourself. No limit your administrator approved applies to what this agent sells, so the offer is the only bound on what sell will sign. A booking reserves the larger of the two charges from the buyer, and the supplier can charge nothing else. Publishing an item of the same name again replaces its offer, and orders for the old one are no longer quoted.",
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
    name: 'list_offer',
    title: 'List an offer with Avow',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    description:
      "Lists an offer your business published from this folder with Avow, for Avow's directory of offers, for an agent connected to sell. Give the id publish_offer or offers answered with. It becomes its item's current listing with Avow, in place of any version of the item listed before, and a version Avow no longer lists can never be listed again, so publish a new one instead. Listing the current version again checks it against the newest mandate again. Your agent holds the offer to its newest seller's mandate first, and Avow checks it against the same mandate and lists nothing it doesn't allow, with the reason. A listing grants nothing, and every order is checked again. When Avow holds no seller's mandates it lists nothing, and the answer says so. Buying agents can't search the directory yet.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The id of an offer this business published here' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'withdraw_listing',
    title: "Withdraw an offer from Avow's listing",
    annotations: {
      readOnlyHint: false,
      // A withdrawn version is never listed again, so the change can't be undone.
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    description:
      "Withdraws an item's current listing with Avow, by the id of its version, for an agent connected to sell. The offer stays published in this folder, and a booking already accepted stands. Avow never lists that version again, so publish and list a new one to offer the item again.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The id of the version Avow lists now' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'test_sellers',
    title: 'List the test sellers',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    description:
      "Lists Avow's test sellers, labelled test businesses that sell simple services through the sandbox at any hour, each with its business ID and its offers, whole. Nothing a test seller sells is delivered or billed, and no test business is verified, so call each one a test business. Order from one by giving order one of its offers as it is, after check says it would pass. Your mandate has to name the seller's business, so when check says it isn't allowed, ask your person with request_change to name it. It needs no connection.",
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
      "Orders units of a service from the offer a supplier's agent gave you, and sees the order through. It sends the order with nothing reserved, waits for the supplier's quote, checks the quote carries exactly the terms the offer builds, funds the commitment under your mandate and waits for the supplier to accept. The reserve is the larger of the offer's two charges, and it backs only those charges. The price is paid separately, by the route the offer names. Each step waits on the other agent, so the tool answers with where the order stands after a while, and this server keeps seeing the order through while it runs. Call it again with the order's id to read where it got to, which never makes a second commitment. Calling it with the offer again carries on an order that's still open, and sends a new order once the first has ended. A refusal comes back with its reason code.",
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
      "Takes the next step on a service order to your business, for an agent connected to sell. A new order is quoted, which signs your business's agreement to the terms the offer builds, so the buyer can fund it. A funded order is accepted on the buyer's lock, after the open verifier's checks pass, and only when its quote is one this agent signed. It quotes only an offer your business published from this folder, since the offer in an order is the buyer's copy, and it refuses an order past the offer's bookings for the day. When Avow serves a seller's mandate for your signing key, it also refuses a quote or an acceptance the mandate doesn't allow, with the reason. Avow serves none and enforces no seller limit yet, and the answer says which applies. An order it won't quote it declines with a reason the buyer hears: a version you replaced, an item you don't publish, a day already full, or a sale your seller's mandate or Avow refuses, which the buyer hears only as supplier.not_authorized. Call decline to turn an order away for another reason.",
    inputSchema: {
      type: 'object',
      properties: {
        order: { type: 'string', description: 'The id of the order, from orders' },
      },
      required: ['order'],
      additionalProperties: false,
    },
  },
  {
    name: 'decline',
    title: 'Decline an order',
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    description:
      "Declines a service order to your business before the buyer funds it, for an agent connected to sell, so the buyer's agent learns why instead of waiting for the order to lapse. Give a reason code from the list, and only the fields it allows. Use supplier.not_authorized when your seller's mandate refuses the order, since a buyer never hears a seller's limits. offer.superseded names the version of the item you publish now, which this server reads from your folder. A time to ask again is advice to the buyer, and nothing holds either side to it. Nothing is reserved, and a declined order takes no quote.",
    inputSchema: {
      type: 'object',
      properties: {
        order: { type: 'string', description: 'The id of the order, from orders' },
        reason: {
          type: 'string',
          enum: [...SELLER_DECLINE_REASONS],
          description: 'Why you decline it',
        },
        retry_minutes: {
          type: 'integer',
          description:
            'For capacity.exhausted, in how many minutes the buyer could ask again, at most a week after the order was taken',
        },
        available: {
          type: 'integer',
          description:
            'For capacity.exhausted or quantity.out_of_range, how many units you would take',
        },
      },
      required: ['order', 'reason'],
      additionalProperties: false,
    },
  },
  {
    name: 'withdraw_order',
    title: 'Withdraw an order',
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    description:
      "Withdraws a service order your business sent, before it's funded, so the supplier stops working on it. Any active agent of the business can withdraw one, including an order another of its agents sent. Nothing is reserved, and a quote that came back can no longer be funded. Once the lock holds the reserve, the lock decides the order and it can't be withdrawn here.",
    inputSchema: {
      type: 'object',
      properties: {
        order: { type: 'string', description: 'The id of an order your business sent' },
      },
      required: ['order'],
      additionalProperties: false,
    },
  },
  {
    name: 'thread',
    title: 'Read a thread order',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    description:
      "Reads a thread order, a service order carried as a signed record of moves, as either side. It replays every move with the open spec's threadProblem before saying where the thread stands, and says so when the record doesn't replay. No offer opens a term to bargaining, so a thread is a proposal the supplier accepts or declines. An agreed thread is no commitment until the supplier's acceptance is on the buyer's lock.",
    inputSchema: {
      type: 'object',
      properties: {
        order: { type: 'string', description: 'The id of the thread order' },
      },
      required: ['order'],
      additionalProperties: false,
    },
  },
] as const satisfies readonly {
  name: SandboxTool | FreeTool | ServiceTool | FundsTool | RequestTool | EventTool
  /** What a client shows for the tool. */
  title: string
  /**
   * How the tool acts, for clients that ask before running one. Booking and ordering add a
   * commitment and move money into a reserve, so they're neither read-only nor idempotent.
   * Withdrawing a listing, declining an order and withdrawing one can't be undone, so those are
   * destructive, and nothing else is. Every tool reaches Avow or the chain, so each is open-world,
   * but the two that only read and keep a supplier's offers in its folder.
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
  // A card shows the name as `quotedLabel` gives it, so a name Avow held from before the rule for
  // new names can't hide or reorder what the card says.
  const answer = (text: string | string[], isError = false): ToolAnswer => ({
    text: Array.isArray(text) ? text.join(' ') : text,
    structured: c.at === 'waiting' ? { ...c, shownLabel: quotedLabel(c.label) } : { ...c },
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
          ? `Asked ${c.businessId} for authority, as ${quotedLabel(c.label)}, with pairing code ${c.pairingCode}.`
          : `Asked for authority, as ${quotedLabel(c.label)}, with pairing code ${c.pairingCode}, from whichever business approves it.`,
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
export function mcpAgent(
  dir: string,
  options: { fetch?: typeof fetch; pollEvery?: number; orderWait?: number } = {},
) {
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
    // Left out or blank, the agent asks under the name it asked before, or the default one.
    const named = typeof args.name === 'string' && args.name.trim() !== '' ? args.name : null
    const label = named === null ? null : agentLabelOf(named)
    if (named !== null && label === null) {
      throw new RangeError(
        `The name can't be used, since ${agentLabelProblem(named) ?? "it isn't plain text"}. ${AGENT_LABEL_RULE}.`,
      )
    }
    const c = await connection.start({ businessId: business, label, sell: args.sell === true })
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

  /** Whether an order from an offer would pass, as `check` answers for a service. */
  async function checkOrder(args: Record<string, unknown>): Promise<ToolAnswer> {
    const offer = readSharedOffer(args.offer)
    if (!offer) throw new RangeError("Give the offer, whole, as the supplier's agent gave it.")
    const quantity = args.quantity === undefined ? 1 : args.quantity
    if (typeof quantity !== 'number') throw new RangeError('The quantity is a number of units')
    const agent = await open('check')
    const answer = await agent.checkOrder({ offer, quantity })
    const dollars = (micros: bigint | null) => (micros === null ? null : Number(micros) / 1_000_000)
    const amounts = answer.amounts && {
      needed: dollars(answer.amounts.needed),
      heldAtOnceLeft: dollars(answer.amounts.left),
      heldAtOnce: dollars(answer.amounts.authority),
      perCommitment: dollars(answer.amounts.capPerCommitment),
      movedPerDay: dollars(answer.amounts.dailyLimit),
      movedTodayLeft: dollars(answer.amounts.dailyLeft),
    }
    const what = `${quantity} of ${offer.item.name} from ${offer.supplier}`
    const price = dollars(answer.price)
    const unchecked = `It can't check ${SERVICE_PREFLIGHT_UNCHECKED.join(', ')}. The order can still be refused or lapse for any of those.`
    const shared = { supplier: offer.supplier, item: offer.item.name, quantity, price, amounts }
    if (answer.passes) {
      return {
        text: [
          `Ordering ${what} would pass now, and nothing was ordered.`,
          `It would reserve ${usd(amounts?.needed ?? null)}, which is what your mandate's limits count. The price is ${usd(price)}, paid outside the lock, and no limit in your mandate counts it.`,
          `Your agent has ${usd(amounts?.heldAtOnceLeft ?? null)} left of its ${usd(amounts?.heldAtOnce ?? null)} held at once, and its key ${usd(amounts?.movedTodayLeft ?? null)} of today's ${usd(amounts?.movedPerDay ?? null)}.`,
          unchecked,
        ].join(' '),
        structured: {
          status: 'would_pass',
          ...shared,
          unchecked: [...SERVICE_PREFLIGHT_UNCHECKED],
        },
        isError: false,
      }
    }
    const layer = answer.layer === 'sdk' ? 'the SDK' : answer.layer
    const refused = answer.amounts && {
      code: answer.code,
      layer: answer.layer,
      amounts: answer.amounts,
    }
    return {
      text: [
        `Ordering ${what} wouldn't pass: ${layer} would refuse it, with reason code ${answer.code}. Nothing was ordered.`,
        ...(refused
          ? [refusalSentence(refused), whenRetryPasses(refused)]
          : [
              "The offer can't be priced in that quantity, so check the offer and how many units it takes in one booking.",
            ]),
      ].join(' '),
      structured: {
        status: 'would_be_refused',
        code: answer.code,
        layer: answer.layer,
        ...(refused ? { sentence: refusalSentence(refused), retry: whenRetryPasses(refused) } : {}),
        ...shared,
      },
      isError: false,
    }
  }

  async function check(args: Record<string, unknown>): Promise<ToolAnswer> {
    if (args.offer !== undefined) {
      if (args.reserve !== undefined) {
        throw new RangeError('Give a reserve to check a GPU booking, or an offer to check an order')
      }
      return checkOrder(args)
    }
    const reserve = args.reserve
    if (typeof reserve !== 'number') {
      throw new RangeError('The check needs a reserve in dollars, or an offer to order from')
    }
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

  async function commitmentEvents(args: Record<string, unknown>): Promise<ToolAnswer> {
    const id = typeof args.commitmentId === 'string' ? args.commitmentId.trim() : ''
    if (!/^0x[0-9a-fA-F]{64}$/.test(id)) {
      throw new RangeError("The read needs a commitment's id, 0x and 64 hex characters")
    }
    const from = typeof args.from === 'string' ? args.from.trim() : ''
    if (from !== '' && !/^[0-9]{1,20}$/.test(from))
      throw new RangeError(`${from} isn't a block number`)
    const read = await sandboxCommitmentEvents(id as Hex, {
      store,
      ...(from !== '' ? { from: BigInt(from) } : {}),
    })
    const lines = read.events.map(
      (e) =>
        `${e.code} at ${new Date(Number(e.at) * 1000).toISOString()}, block ${e.blockNumber}, transaction ${e.transactionHash}.`,
    )
    const more =
      read.next === null
        ? 'That reads up to the latest final block.'
        : `The read stopped at block ${read.readTo}. Call again with from ${read.next} for later blocks.`
    const unread =
      read.unread.length === 0
        ? ''
        : ` The lock also logged ${read.unread.length} step${read.unread.length === 1 ? '' : 's'} for it that this SDK can't state.`
    return {
      text: `${
        lines.length === 0
          ? 'The lock logged nothing for that commitment in the blocks read.'
          : lines.join('\n')
      }\n${more}${unread} These are notices of what the lock logged. They grant nothing and prove nothing on their own, so check the commitment with verify before you act on one.`,
      structured: {
        reference: toWire(read.reference),
        events: toWire(read.events),
        readTo: read.readTo.toString(),
        next: read.next === null ? null : read.next.toString(),
        unread: read.unread,
      },
      isError: false,
    }
  }

  async function topUp(): Promise<ToolAnswer> {
    const t = await agentTopUp({ store, ...(options.fetch ? { fetch: options.fetch } : {}) })
    const next = new Date(Number(t.nextAt) * 1000).toISOString()
    if (t.state === 'not_yet') {
      return {
        text: `Your business had its top-up for today, so nothing was sent. It can ask again at ${next}.`,
        structured: { state: t.state, nextAt: Number(t.nextAt) },
        isError: false,
      }
    }
    const dollars = toDollars(BigInt(t.amount))
    return {
      text: `The sandbox faucet is sending your business ${usd(dollars)} in test dollars, to its account and not its lock, so your agent's limits are the same. The transfer is ${t.outcome === 'landed' ? 'on Tempo' : 'on its way to Tempo'}: ${t.transactionHash}. Your business can top up again at ${next}.`,
      structured: {
        state: t.state,
        amount: dollars,
        transactionHash: t.transactionHash,
        outcome: t.outcome,
        nextAt: Number(t.nextAt),
      },
      isError: false,
    }
  }

  /** Where a request stands, in the words an agent acts on. */
  function requestSentence(asked: AskedChange): string {
    const { request, link } = asked
    const s = request.status
    // One sale changes no limit, so none of the words about a change landing fit it.
    if (request.kind === 'sale') return saleSentence(request.status.state, link)
    switch (s.state) {
      case 'waiting':
        return `It waits for your business's administrator until ${new Date(Number(request.expiresAt) * 1000).toISOString()}. Send your person this link to decide it with their passkey: ${link}. Keep within your current limits until it's active.`
      case 'approved':
        return "It's approved, and the administrator's passkey still has to sign the new limit within an hour of approving. Keep within your current limits until it's active."
      case 'executing':
        return "It's approved and the change is landing. Keep within your current limits until it's active."
      case 'active':
        return request.kind === 'seller_mandate'
          ? "It is active. Your agent reads its seller's mandate before it next publishes, quotes or accepts, and holds itself to it. Avow doesn't enforce seller limits yet."
          : 'It is active. Your agent picks up the new limit the next time it reads its mandates, within half a minute.'
      case 'declined':
        return 'Your business declined it, so nothing changed.'
      case 'expired':
        return 'It lapsed before the change landed, so nothing changed.'
      case 'stale':
        return "Your agent's limits changed since it asked, so it can never apply. Check authority and ask again if you still need to."
      case 'failed':
        return `The change didn't land, so nothing changed. ${describeReason(s.reason)}.`
    }
  }

  /** Where a request to approve one sale stands. It can be made while approved, once. */
  function saleSentence(state: ApprovalRequest['status']['state'], link: string): string {
    switch (state) {
      case 'waiting':
        return `It waits for your business's administrator. Send your person this link to decide it with their passkey: ${link}. Don't make the sale until it's approved.`
      case 'approved':
        return 'Your administrator approved this one sale. It can be made once, within a day of the approval, and no limit changed.'
      case 'active':
        return 'This sale was made on its approval, which is now used up.'
      case 'declined':
        return 'Your business declined this sale.'
      case 'expired':
        return 'It lapsed, so this sale needs asking for again.'
      case 'stale':
        return "The seller's mandate changed since it was asked, so this approval can never be used."
      case 'executing':
      case 'failed':
        throw new RangeError('a request for one sale has no change to land')
    }
  }

  function requestFacts(asked: AskedChange) {
    const { request, link } = asked
    return {
      id: request.id,
      kind: request.kind,
      state: request.status.state,
      expiresAt: Number(request.expiresAt),
      link,
      change: changeWords(request),
      sentence: requestSentence(asked),
    }
  }

  /** The change the model asked for, from the tool's arguments, refused when they don't fit. */
  async function asked(agent: SandboxAgent, args: Record<string, unknown>): Promise<AskedChange> {
    switch (args.kind) {
      case 'raise_limit': {
        const limit = args.limit
        if (limit !== 'per_commitment' && limit !== 'open_reserves') {
          throw new RangeError('limit is per_commitment or open_reserves')
        }
        if (typeof args.to !== 'number') throw new RangeError('to is the new limit in dollars')
        return agent.askToRaise({ limit, to: args.to })
      }
      case 'name_supplier':
        if (typeof args.supplier !== 'string' || args.supplier.trim() === '') {
          throw new RangeError("supplier is the supplier's Avow business id")
        }
        return agent.askToNameSupplier(args.supplier.trim())
      case 'open_mode':
        if (typeof args.cap !== 'number') throw new RangeError('cap is the most in dollars')
        return agent.askToOpen(args.cap)
      default:
        throw new RangeError('kind is raise_limit, name_supplier or open_mode')
    }
  }

  async function requestChange(args: Record<string, unknown>): Promise<ToolAnswer> {
    // Asking reads the authority the agent holds now, which is where a raise starts from.
    const made = await asked(await open('authority'), args)
    const facts = requestFacts(made)
    const rows = facts.change.rows.map((r) =>
      'value' in r ? `${r.label} ${r.value}` : `${r.label} from ${r.before} to ${r.after}`,
    )
    return {
      text: `Asked your business to ${facts.change.title.toLowerCase()}${rows.length ? `: ${rows.join(', ')}` : ''}, request ${made.request.id}. ${facts.sentence}`,
      structured: facts,
      isError: false,
    }
  }

  async function requestSellerMandate(args: Record<string, unknown>): Promise<ToolAnswer> {
    const read = sellerMandateTermsJson.safeParse(args.terms)
    if (!read.success) {
      throw new RangeError(
        "terms has to be a seller's mandate's terms as the spec writes them, with amounts and times as decimal strings",
      )
    }
    const outcome = await (await services()).askToSell(read.data)
    if (!outcome.ok) {
      return {
        text: outcome.notice,
        structured: { asked: false, reason: outcome.reason, notice: outcome.notice },
        isError: false,
      }
    }
    const facts = requestFacts(outcome.asked)
    return {
      text: `Asked your business to ${facts.change.title.toLowerCase()}, request ${outcome.asked.request.id}. ${facts.sentence}`,
      structured: { asked: true, ...facts },
      isError: false,
    }
  }

  async function requestStatus(args: Record<string, unknown>): Promise<ToolAnswer> {
    if (typeof args.id !== 'string' || !isApprovalRequestId(args.id)) {
      throw new RangeError(
        'id is the request id request_change or request_seller_mandate answered with',
      )
    }
    const asked = await agentRequest(args.id, {
      store,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    })
    return { text: requestSentence(asked), structured: requestFacts(asked), isError: false }
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

  const shared = (version: OfferVersion) => ({
    id: offerIdOf(version),
    offer: toWire(version),
  })

  async function publishOffer(args: Record<string, unknown>): Promise<ToolAnswer> {
    const draft = readOfferInput(args as OfferInput)
    if ('error' in draft) throw new RangeError(draft.error)
    const { version, id, standing } = await (await services()).publish(draft)
    return {
      text: [
        `Published offer ${id}, kept in this folder. The offer wasn't sent to Avow, and list_offer lists it there.`,
        ...(standing ? [standing.notice] : []),
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
                [`Offer ${offerIdOf(v)}.`, ...offerSentences(v), JSON.stringify(toWire(v))].join(
                  ' ',
                ),
              )
              .join('\n'),
      structured: { offers: published.map(shared) },
      isError: false,
    }
  }

  /** The id a tool was given, read as a version's id, or why it isn't one. */
  const versionIdOf = (args: Record<string, unknown>): Hex => {
    const id = args.id
    if (typeof id !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(id)) {
      throw new RangeError("Give the offer's id, as publish_offer or offers answered with it.")
    }
    return id.toLowerCase() as Hex
  }

  async function listOffer(args: Record<string, unknown>): Promise<ToolAnswer> {
    const listed = await (await services()).listWithAvow(versionIdOf(args))
    if (!listed.ok) {
      return {
        text: listed.notice,
        structured: { listed: false, reason: listed.reason },
        isError: false,
      }
    }
    const { listing, standing } = listed
    return {
      text: [
        `Avow lists offer ${listing.id} as its item's current listing, checked against seller's mandate ${listing.sellerMandate}.`,
        ...(listing.replaced
          ? [`It replaces ${listing.replaced}, which Avow no longer lists.`]
          : []),
        standing.notice,
        'A listing grants nothing, and every order is checked again.',
      ].join(' '),
      structured: { listed: true, listing: toWire(listing) },
      isError: false,
    }
  }

  async function withdrawListing(args: Record<string, unknown>): Promise<ToolAnswer> {
    const { id, withdrawnAt } = await (await services()).withdrawFromAvow(versionIdOf(args))
    return {
      text: `Avow no longer lists offer ${id}. It stays published in this folder, and a booking already accepted stands.`,
      structured: toWire({ id, withdrawnAt }) as Record<string, unknown>,
      isError: false,
    }
  }

  /**
   * The test sellers the sandbox lists, each as a test business with its offers whole, for the
   * model to order from. A sandbox that lists none says so.
   */
  async function testSellers(): Promise<ToolAnswer> {
    const found = await sandboxTestSellers(options.fetch ? { fetch: options.fetch } : {})
    if (!found.listed) {
      return {
        text: 'The sandbox lists no test sellers, so there is none to order from here. Order from an offer another business gave you instead.',
        structured: { sellers: [] },
        isError: false,
      }
    }
    return {
      text: [
        ...found.sellers.map((s) =>
          [
            `${s.name}, the ${TEST_BUSINESS_LABEL} ${s.businessId}. Nothing it sells is delivered or billed.`,
            ...s.offers.map((v) =>
              [`Offer ${offerVersionId(v)}.`, ...offerSentences(v), JSON.stringify(toWire(v))].join(
                ' ',
              ),
            ),
          ].join('\n'),
        ),
        "To order, call check with one of these offers, whole, and a quantity, then order with the same two once it would pass. Your mandate has to name the seller's business. When check says it isn't allowed, ask your person with request_change to name it.",
      ].join('\n\n'),
      structured: {
        sellers: found.sellers.map((s) => ({
          businessId: s.businessId,
          name: s.name,
          label: TEST_BUSINESS_LABEL,
          offers: s.offers.map(shared),
        })),
      },
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
      // An order for the same offer and quantity that's still open is carried on, so asking twice
      // while it's open sends one order. Once it has ended, asking again is a new order.
      const left = await unfinishedFor(mine, offer, quantity)
      orderId = left ?? (await mine.order({ offer, quantity })).orderId
      if (left) said.push('You had sent this order already, so it carries on from where it stood.')
    }
    const known = (await mine.unfinished()).some((r) => r.orderId === orderId)
    const run = buying.get(orderId) ?? (known ? seeThrough(mine, orderId) : null)
    if (run) {
      const started = Date.now()
      const wait = options.orderWait ?? ORDER_WAIT_MS
      while (!run.ended && !run.failed && Date.now() - started < wait) {
        await new Promise((done) => setTimeout(done, Math.min(500, wait)).unref())
      }
    }
    if (run?.failed) {
      // An order the folder still keeps is picked up by the next call.
      buying.delete(orderId)
      throw run.failed.error
    }
    const outcome = run?.ended ?? null
    if (outcome) buying.delete(orderId)
    // An order this folder no longer keeps was seen through earlier, and the mailbox still has it.
    const now = outcome ? outcome.order : await mine.read(orderId)
    const link = linkOf(now)
    const open = now.status !== 'accepted' && now.status !== 'expired'
    return {
      text: [
        ...said,
        orderSentence(now),
        outcome
          ? outcomeSentence(outcome)
          : !open
            ? ''
            : run
              ? `This server keeps seeing it through while it runs. Call order again with order ${orderId} to read where it got to.`
              : "This agent isn't seeing that order through, so this is only where it stands.",
        link ? `Anyone can check the commitment at ${link}` : '',
      ]
        .filter(Boolean)
        .join(' '),
      structured: {
        ...orderFacts(now),
        ended: outcome ? (outcome.ok ? 'accepted' : outcome.reason) : null,
        seeingThrough: run !== null && outcome === null,
        link,
      },
      isError: false,
    }
  }

  async function orders(): Promise<ToolAnswer> {
    const mine = await services()
    // An agent connected only to buy has no inbox. One connected to sell hears why a read failed.
    const selling = mine.sells ? await mine.inbox() : null
    // A service order is quoted only from a service this business published.
    const offered = selling
      ? (await mine.published()).filter((v): v is ServiceOfferVersion => !isJobOfferVersion(v))
      : []
    // One order that can't be read doesn't hide the rest.
    const kept = await mine.unfinished()
    const read = await Promise.allSettled(kept.map((r) => mine.read(r.orderId)))
    const sent = read.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
    const unread = kept.filter((_, i) => read[i]?.status === 'rejected').map((r) => r.orderId)
    const next = (o: ServiceOrder) =>
      o.status === 'requested'
        ? publishedOffer(o, offered)
          ? 'Call sell to quote it.'
          : "It names an offer you haven't published, so sell won't quote it."
        : o.status === 'reserved'
          ? 'Call sell to accept it.'
          : ''
    const lines = [
      ...(selling ?? []).map((o) => `To your business. ${orderSentence(o)} ${next(o)}`.trim()),
      ...sent.map((o) =>
        buying.has(o.orderId)
          ? `From you. ${orderSentence(o)}`
          : `From you. ${orderSentence(o)} Call order with order ${o.orderId} to carry it on.`,
      ),
      ...unread.map(
        (id) => `From you. Order ${id} couldn't be read. Call order with order ${id} to hear why.`,
      ),
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
        unread,
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
    if (waiting.status !== 'requested' && waiting.status !== 'reserved') {
      // Nothing was done, so nothing is said to have been.
      return {
        text: `${orderSentence(waiting)} There's no step for your business to take on it now.`,
        structured: { ...orderFacts(waiting), step: null, acceptedIn: null },
        isError: false,
      }
    }
    let acceptedIn: string | null = null
    let notice = ''
    let declined: OrderDeclineRequest | null = null
    try {
      await mine.sell(waiting, (step) => {
        notice = step.standing?.notice ?? ''
        if (step.step === 'accepted') acceptedIn = step.acceptedIn
        if (step.step === 'declined') declined = step.decline
      })
    } catch (error) {
      if (!(error instanceof SellerMandateRefusal)) throw error
      return {
        text:
          waiting.status === 'requested'
            ? `${error.message} No quote was sent, so the order is left to lapse.`
            : `${error.message} The order isn't accepted, so the buyer's reserve goes back once the acceptance deadline passes.`,
        structured: { ...orderFacts(waiting), step: null, acceptedIn: null, refused: error.reason },
        isError: true,
      }
    }
    if (declined) {
      const sent: OrderDeclineRequest = declined
      return {
        text: `Declined order ${orderId}, so the buyer's agent hears why and nothing is reserved. ${declineSentence(sent)} ${notice}`.trim(),
        structured: { ...orderFacts(waiting), step: 'declined', reason: sent.reason },
        isError: false,
      }
    }
    const quoted = waiting.status === 'requested'
    return {
      text: `${
        quoted
          ? `Quoted, which signed your business's agreement to these terms. ${bookingSentence(waiting.offer, waiting.quantity)} The buyer's agent funds it next. Call orders to see once it has, then sell again to accept.`
          : `Accepted order ${orderId} on the buyer's lock, so the commitment stands. Deliver by the terms' deadline.`
      } ${notice}`.trim(),
      structured: { ...orderFacts(waiting), step: quoted ? 'quoted' : 'accepted', acceptedIn },
      isError: false,
    }
  }

  async function declineTool(args: Record<string, unknown>): Promise<ToolAnswer> {
    const orderId = typeof args.order === 'string' ? args.order.trim() : ''
    if (orderId === '') throw new RangeError('Give the id of the order, from orders')
    const reason = args.reason
    if (
      typeof reason !== 'string' ||
      !(SELLER_DECLINE_REASONS as readonly string[]).includes(reason)
    ) {
      throw new RangeError(`Give one of these reasons: ${SELLER_DECLINE_REASONS.join(', ')}`)
    }
    const whole = (v: unknown, most: number) =>
      v === undefined
        ? null
        : Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= most
          ? (v as number)
          : NaN
    // A week at most, and `declineWaiting` holds it to a week from when Avow took the order.
    const minutes = whole(args.retry_minutes, Number(DECLINE_RETRY_MAX / 60n))
    const available = whole(args.available, SERVICE_QUANTITY_MAX)
    if (Number.isNaN(minutes))
      throw new RangeError('retry_minutes is a whole number of minutes, at most a week')
    if (Number.isNaN(available)) throw new RangeError('available is a whole number of units')
    const declined = await declineWaiting(await services(), {
      order: orderId,
      reason: reason as DeclineReason,
      retryMinutes: minutes,
      available,
    })
    if (!declined.ok) {
      return { text: declined.why, structured: { order: orderId, step: null }, isError: true }
    }
    return {
      text: `Declined order ${orderId}, so the buyer's agent hears why and nothing is reserved. ${declineSentence(declined.sent)}`,
      structured: { ...orderFacts(declined.order), step: 'declined', reason },
      isError: false,
    }
  }

  async function withdrawTool(args: Record<string, unknown>): Promise<ToolAnswer> {
    const orderId = typeof args.order === 'string' ? args.order.trim() : ''
    if (orderId === '') throw new RangeError('Give the id of an order your business sent')
    const order = await (await services()).withdrawOrder(orderId)
    return {
      text: `Withdrew order ${orderId}. Nothing is reserved, and the supplier can no longer be funded for it.`,
      structured: orderFacts(order),
      isError: false,
    }
  }

  async function threadTool(args: Record<string, unknown>): Promise<ToolAnswer> {
    const orderId = typeof args.order === 'string' ? args.order.trim() : ''
    if (orderId === '') throw new RangeError('Give the id of the thread order')
    const { order, problem } = await (await services()).readThread(orderId)
    const moves = order.thread.moves.map((m) =>
      m.move.kind === 'decline'
        ? `${m.move.side} declined with ${m.move.reason}`
        : `${m.move.side} ${m.move.kind === 'propose' ? 'proposed' : `${m.move.kind}ed`} ${m.move.quantity} at ${formatUsd(m.move.unitPrice)} a unit`,
    )
    if (problem) {
      return {
        text: `Thread ${orderId} doesn't replay (${problem}), so don't act on it. Its moves: ${moves.join('; ')}.`,
        structured: { order: orderId, status: order.status, problem },
        isError: true,
      }
    }
    const state =
      order.status === 'reserved' || order.status === 'accepted'
        ? order.status
        : threadStateAt(order.thread, BigInt(Math.floor(Date.now() / 1000))).status
    return {
      text: `Thread ${orderId} on ${order.thread.base.item.name} from ${order.thread.base.supplier} stands ${state}. Its moves: ${moves.join('; ')}. An agreed thread is no commitment until the supplier's acceptance is on the lock.`,
      structured: {
        order: orderId,
        status: state,
        moves: order.thread.moves.length,
        problem: null,
      },
      isError: false,
    }
  }

  const isEventTool = (name: string): name is EventTool =>
    (EVENT_TOOLS as readonly string[]).includes(name)
  const isFundsTool = (name: string): name is FundsTool =>
    (FUNDS_TOOLS as readonly string[]).includes(name)
  const isRequestTool = (name: string): name is RequestTool =>
    (REQUEST_TOOLS as readonly string[]).includes(name)
  const isServiceTool = (name: string): name is ServiceTool =>
    (SERVICE_TOOLS as readonly string[]).includes(name)

  return {
    async call(name: string, args: Record<string, unknown>): Promise<ToolAnswer> {
      try {
        if (name === 'connect') return await connect(args)
        if (name === 'status') return connectionAnswer(await connection.status())
        if (name === 'verify') return await verify(args)
        if (name === 'test_sellers') return await testSellers()
        if (
          !SANDBOX_TOOLS.includes(name as SandboxTool) &&
          !isServiceTool(name) &&
          !isFundsTool(name) &&
          !isRequestTool(name) &&
          !isEventTool(name)
        ) {
          return { text: `There's no tool named ${name}.`, structured: {}, isError: true }
        }
        const waiting = await unready()
        if (waiting) return waiting
        if (name === 'top_up') return await topUp()
        if (name === 'commitment_events') return await commitmentEvents(args)
        if (name === 'request_change') return await requestChange(args)
        if (name === 'request_seller_mandate') return await requestSellerMandate(args)
        if (name === 'request_status') return await requestStatus(args)
        if (name === 'publish_offer') return await publishOffer(args)
        if (name === 'offers') return await offers()
        if (name === 'list_offer') return await listOffer(args)
        if (name === 'withdraw_listing') return await withdrawListing(args)
        if (name === 'order') return await order(args)
        if (name === 'orders') return await orders()
        if (name === 'sell') return await sell(args)
        if (name === 'decline') return await declineTool(args)
        if (name === 'withdraw_order') return await withdrawTool(args)
        if (name === 'thread') return await threadTool(args)
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

/**
 * Adds the server to one MCP client, or prints the block any other client reads, against this
 * folder's agent.
 */
function add(client: string | undefined, dir: string): number {
  const server = realpathSync(fileURLToPath(import.meta.url))
  const launch = { name: SERVER.name, command: process.execPath, args: [server, '--dir', dir] }
  if (client === 'config') {
    process.stdout.write(mcpServersJson(launch))
    return 0
  }
  if (!isMcpClient(client)) {
    console.error(
      `Use avow-sandbox mcp add with one of ${MCP_CLIENTS.join(', ')}, or avow-sandbox mcp add config for the block any other MCP client reads.`,
    )
    return 1
  }
  const next = existsSync(join(dir, SANDBOX_DIR, 'agent.json'))
    ? 'ask it to book $200 of GPU compute'
    : 'ask it to connect to your Avow business'
  const added = addToClient(client, launch, { dir, next })
  console.log(`\n${added.message}`)
  return added.ok ? 0 : 1
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
 * `avow-sandbox-mcp [add <client> | add config | --dir <folder>]`, which `avow-sandbox mcp` runs too, so npx
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
