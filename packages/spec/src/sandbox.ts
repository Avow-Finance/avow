import type { Address, Hex } from 'viem'
import { z } from 'zod'
import { isApiAudience } from './api-request.js'
import { address, bytes32, u256 } from './json-fields.js'
import { isTestnetChain } from './networks.js'
import { describeReason, REASON_CODES, type ReasonCode } from './reasons.js'
import type { CommitmentReference } from './references.js'
import { commitmentReferenceJson, type Parsed } from './wire.js'

/**
 * Avow's sandbox on testnet. A developer's machine registers a sandbox business, which Avow pays
 * in test dollars, and reports what the business's agent does to a session. A screen at the
 * session's link shows each event as it arrives, relayed through Avow's API.
 */

/** A session id: 16 random bytes as 32 lower-case hex characters, which no one can guess. */
const SESSION_ID = /^[0-9a-f]{32}$/

/** Whether text is a session id, the only form a session's path and link carry. */
export const isSessionId = (text: string): boolean => SESSION_ID.test(text)

/** A new session id from the platform's random source. */
export function newSessionId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('')
}

/** Where a sandbox business and a sandbox supplier register, and where a session's events go. */
export const SANDBOX_PATHS = {
  businesses: '/v1/sandbox/businesses',
  suppliers: '/v1/sandbox/suppliers',
  sessionEvents: (sessionId: string) => {
    if (!isSessionId(sessionId)) throw new RangeError(`${sessionId} isn't a session id`)
    return `/v1/sandbox/sessions/${sessionId}/events`
  },
} as const

/** Where the sandbox's screen publishes the facts of the deployment it runs against. */
export const SANDBOX_DEPLOYMENT_PATH = '/config.json'

/** What a sandbox client needs to know about the testnet deployment it registers and books on. */
export interface SandboxDeployment {
  /** The chain every message is signed for. The sandbox runs only on a testnet. */
  chainId: number
  rpcUrl: string
  /** Avow's API, the audience every request names. */
  apiUrl: string
  /** Avow's demo supplier's adapter. */
  supplierUrl: string
  /** The factory that makes each business's lock. */
  factory: Address
  /** The token reserves are held in, which the sandbox pays its test dollars in. */
  token: Address
  /** The fallback arbiter Avow's approvals name, which a booking's terms have to name too. */
  arbiter: Address
  /** The supplier's share of a disputed charge at day 90, which Avow's approvals name. */
  day90SupplierShareBps: number
}

const origin = z.string().refine(isApiAudience, 'an http or https origin, with no path')

/** The deployment's facts as the screen publishes them. Fields a client doesn't use are left out. */
export const sandboxDeploymentJson = z.object({
  chainId: z.number().int().refine(isTestnetChain, 'a testnet chain'),
  rpcUrl: z.url({ protocol: /^https?$/ }),
  apiUrl: origin,
  supplierUrl: origin,
  factory: address,
  token: address,
  arbiter: address,
  day90SupplierShareBps: z.number().int().min(0).max(10_000),
})

/** Reads the deployment's facts, refusing any chain that isn't a testnet. */
export function parseSandboxDeployment(json: unknown): Parsed<SandboxDeployment> {
  const parsed = sandboxDeploymentJson.safeParse(json)
  return parsed.success
    ? {
        ok: true,
        value: {
          chainId: parsed.data.chainId,
          rpcUrl: parsed.data.rpcUrl,
          apiUrl: parsed.data.apiUrl,
          supplierUrl: parsed.data.supplierUrl,
          factory: parsed.data.factory,
          token: parsed.data.token,
          arbiter: parsed.data.arbiter,
          day90SupplierShareBps: parsed.data.day90SupplierShareBps,
        },
      }
    : { ok: false, reason: 'message.invalid' }
}

/**
 * Who refused a booking. `sdk` is the agent's own SDK, which checks the mandate before anyone
 * signs. `avow` is Avow's API, which checks the mandate against what the lock holds before it
 * approves a reserve. `relay` is Avow's relay, which refuses to pay the fee for a transaction it
 * won't sponsor. `lock` is the business's lock on-chain, which reverts a reserve that breaks Avow's
 * approval, including the caps the approval carries. `keychain` is the business account's keychain,
 * which holds the agent's key to the daily limit the business's root key set. `unknown` is a
 * reserve that never landed when nothing on the way gave a reason.
 */
export const REFUSAL_LAYERS = ['sdk', 'avow', 'relay', 'lock', 'keychain', 'unknown'] as const
export type RefusalLayer = (typeof REFUSAL_LAYERS)[number]

/** The amounts behind a refusal, each in micros of a dollar. */
export interface RefusalAmounts {
  /** What the booking needed reserved. */
  needed: bigint
  /** The authority the agent had left: its cap on open reserves, less what its bookings hold. */
  left: bigint
  /** The agent's whole authority, the most it can hold in bookings at once. */
  authority: bigint
  /**
   * The most the agent's key can move in a day, the spending limit the business's root key set on
   * the account's keychain, or null when the key has no daily limit on the lock's token.
   */
  dailyLimit: bigint | null
  /** What the agent's key could still move that day when it was refused, or null when unread. */
  dailyLeft: bigint | null
}

/**
 * Who made an event. `business` is the runner, which alone holds the business's root key and
 * changes the authority. `script` is the developer's agent file, and `mcp` is the agent a model
 * drives through the sandbox's MCP server. Both act with only the agent's key.
 */
export const SESSION_SOURCES = ['business', 'script', 'mcp'] as const
export type SessionSource = (typeof SESSION_SOURCES)[number]

/** The tools the sandbox's MCP server gives a model. */
export const SANDBOX_TOOLS = ['authority', 'book', 'commitments'] as const
export type SandboxTool = (typeof SANDBOX_TOOLS)[number]

/** A run starting, once each time the developer runs their agent or a model calls a tool. */
export interface RunStarted {
  type: 'run_started'
  run: number
  source: SessionSource
  /** The tool the model called, or null for a run of the agent's file. */
  tool: SandboxTool | null
}

/** The agent's authority changed, so the business signed and enrolled a new mandate. */
export interface AuthorityChanged {
  type: 'authority_changed'
  run: number
  source: SessionSource
  /** The new mandate's cap on open reserves, in micros. */
  authority: bigint
  /** The previous mandate's cap, or null when the agent had no mandate before. */
  previous: bigint | null
  /** The business ids of the suppliers the new mandate allows. */
  suppliers: string[]
  /** The new mandate's hash under the business's lock, which its agent key carries on-chain. */
  mandateHash: Hex
}

/** A booking refused before any money moved, with the reason code and who refused it. */
export interface Refused {
  type: 'refused'
  run: number
  source: SessionSource
  code: ReasonCode
  layer: RefusalLayer
  amounts: RefusalAmounts
}

/** A reserve funded in the business's lock, which the reference names. */
export interface Committed {
  type: 'committed'
  run: number
  source: SessionSource
  reference: CommitmentReference
  /** The reserve, in micros. */
  amount: bigint
}

/** The supplier checked the commitment and its acceptance landed on the lock. */
export interface Accepted {
  type: 'accepted'
  run: number
  source: SessionSource
  reference: CommitmentReference
}

/** One thing a sandbox business's agent did, as its session's screen shows it. */
export type SessionEvent = RunStarted | AuthorityChanged | Refused | Committed | Accepted

export const SESSION_EVENT_TYPES = [
  'run_started',
  'authority_changed',
  'refused',
  'committed',
  'accepted',
] as const satisfies readonly SessionEvent['type'][]

/** The request body that posts one event to a session. */
export interface SessionEventPost {
  event: SessionEvent
}

/** Avow's answer to a posted event: its place in the session, counting from 1. */
export interface SessionEventAnswer {
  sequence: number
}

const run = z.number().int().positive().max(1_000_000)
const source = z.enum(SESSION_SOURCES)
const reasonCode = z.enum(Object.keys(REASON_CODES) as [ReasonCode, ...ReasonCode[]])
const businessId = z.string().min(1).max(100)

export const sessionEventJson = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('run_started'),
    run,
    source,
    tool: z.enum(SANDBOX_TOOLS).nullable(),
  }),
  z.strictObject({
    type: z.literal('authority_changed'),
    run,
    source,
    authority: u256,
    previous: u256.nullable(),
    suppliers: z.array(businessId).min(1).max(20),
    mandateHash: bytes32,
  }),
  z.strictObject({
    type: z.literal('refused'),
    run,
    source,
    code: reasonCode,
    layer: z.enum(REFUSAL_LAYERS),
    amounts: z.strictObject({
      needed: u256,
      left: u256,
      authority: u256,
      dailyLimit: u256.nullable(),
      dailyLeft: u256.nullable(),
    }),
  }),
  z.strictObject({
    type: z.literal('committed'),
    run,
    source,
    reference: commitmentReferenceJson,
    amount: u256,
  }),
  z.strictObject({
    type: z.literal('accepted'),
    run,
    source,
    reference: commitmentReferenceJson,
  }),
])

export const sessionEventPostJson = z.strictObject({ event: sessionEventJson })

export const sessionEventAnswerJson = z.strictObject({
  sequence: z.number().int().positive(),
})

/** Reads one session event from its JSON form, with amounts as decimal strings. */
export function parseSessionEvent(json: unknown): Parsed<SessionEvent> {
  const parsed = sessionEventJson.safeParse(json)
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, reason: 'message.invalid' }
}

/** Reads the body of a request that posts an event to a session, as Avow's API takes it. */
export function parseSessionEventPost(json: unknown): Parsed<SessionEventPost> {
  const parsed = sessionEventPostJson.safeParse(json)
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, reason: 'message.invalid' }
}

/** Reads Avow's answer to a posted event. */
export function parseSessionEventAnswer(json: unknown): Parsed<SessionEventAnswer> {
  const parsed = sessionEventAnswerJson.safeParse(json)
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, reason: 'message.invalid' }
}

/** An amount in micros as dollars, such as `$1,500` or `$12.50`. */
export function formatUsd(micros: bigint): string {
  const sign = micros < 0n ? '-' : ''
  const abs = micros < 0n ? -micros : micros
  const whole = (abs / 1_000_000n).toLocaleString('en-US')
  const fraction = abs % 1_000_000n
  if (fraction === 0n) return `${sign}$${whole}`
  const digits = fraction.toString().padStart(6, '0').replace(/0+$/, '').padEnd(2, '0')
  return `${sign}$${whole}.${digits}`
}

const WHO: Record<RefusalLayer, string> = {
  sdk: 'the SDK',
  avow: 'Avow',
  relay: "Avow's relay",
  lock: 'the lock',
  keychain: "your account's keychain",
  unknown: 'nothing on the way',
}

/**
 * A refusal in plain words with its amounts, so the developer's terminal and the session's screen
 * say the same thing from the same event. A refusal by the SDK or by Avow goes on to say what the
 * chain holds without trusting either. The lock takes no reserve without Avow's approval, and the
 * account's keychain holds the agent's key to the daily limit the business set. The caps the lock
 * checks are the ones Avow's approval carries, so the sentence never says the lock would refuse
 * what Avow approved.
 */
export function refusalSentence(r: Pick<Refused, 'code' | 'layer' | 'amounts'>): string {
  const who = WHO[r.layer]
  const { needed, left, authority, dailyLimit, dailyLeft } = r.amounts
  const onChain =
    r.layer !== 'sdk' && r.layer !== 'avow'
      ? ''
      : dailyLimit === null
        ? " The lock takes no reserve without Avow's approval."
        : ` The lock takes no reserve without Avow's approval, and your agent's key moves at most ${formatUsd(dailyLimit)} a day, a limit your business set on chain.`
  if (r.layer === 'unknown') {
    return `The reserve for this ${formatUsd(needed)} booking never landed, and nothing on the way said why, so no money moved.`
  }
  switch (r.code) {
    case 'keychain.over_daily_limit':
      return `This booking needs ${formatUsd(needed)}. Your agent had ${formatUsd(left)} left of its ${formatUsd(authority)} held at once, so Avow approved it, but ${
        dailyLimit === null || dailyLeft === null
          ? 'that is more than its key can still move today'
          : `its key has ${formatUsd(dailyLeft)} left of its ${formatUsd(dailyLimit)} a day`
      }, so ${who} refused it and no money moved. Your business set that daily limit on chain, and no approval from Avow lifts it.`
    case 'mandate.over_open_reserves_cap':
      return `This booking needs ${formatUsd(needed)} and your agent has ${formatUsd(left)} left of its ${formatUsd(authority)} held at once, so ${who} refused the reserve and no money moved.${onChain}`
    case 'mandate.over_commitment_cap':
      return `This booking needs ${formatUsd(needed)}, more than your agent's ${formatUsd(authority)} held at once, so ${who} refused the reserve and no money moved.${onChain}`
    default:
      return `${who.charAt(0).toUpperCase()}${who.slice(1)} refused this ${formatUsd(needed)} booking and no money moved. ${describeReason(r.code)}.${onChain}`
  }
}
