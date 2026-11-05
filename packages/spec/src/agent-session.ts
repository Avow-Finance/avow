import type { Hex } from 'viem'
import { z } from 'zod'
import { type ComputeOffer, computeOfferJson, MAX_COMPUTE_OFFERS } from './compute-offers.js'
import { type PinnedBlock, pinnedBlockJson } from './dependencies.js'
import { type FactBody, factBodyShape, VERIFIERS, type VerifiedBy } from './facts.js'
import { type JobVerification, jobVerificationJson } from './job-verification.js'
import { bytes32, u256 } from './json-fields.js'
import { RAIL_STATES, type RailState } from './rail.js'
import type { ReasonCode } from './reasons.js'
import { type CommitmentReference, commitmentReferenceJson } from './references.js'
import {
  type AgentSource,
  agentSourceJson,
  REFUSAL_LAYERS,
  type RefusalLayer,
  reasonCodeJson,
  runJson,
} from './session-fields.js'
import { orderIdJson } from './test-customer.js'

/**
 * The events of the developer's agent session, beside a job's own events, so the terminal and the
 * screen draw the same lines from the same events. Speech, tool calls with their results, facts and
 * receipts are kinds of their own, so speech is never drawn as evidence and evidence never as
 * speech. Each names its run, and the order when it belongs to a job. Each job is its own run, and
 * a turn the developer starts is its own run with no order.
 *
 * A signed event is an attributed statement. The agent key's signature says who posted it, never
 * that what it says is true. So each fact and receipt names who verified it, the commitment on the
 * chain and the block, and a reader checks from the chain what it can. The developer's own
 * messages stay in their terminal and are never posted.
 */

/** The tools the agent session gives a model, and nothing else. */
export const JOB_TOOLS = [
  'read_order',
  'compute_offers',
  'book_compute',
  'cancel_compute',
  'submit_quote',
  'authority',
  'commitments',
] as const
export type JobTool = (typeof JOB_TOOLS)[number]

/** Who spoke: a model by its id, `scripted` for the deterministic fixture, or the customer. */
export type Speaker = { kind: 'model'; model: string } | { kind: 'customer' }

/** The model id scripted runs speak as, so every line they draw says it was scripted. */
export const SCRIPTED_MODEL = 'scripted'

interface SessionEventBase {
  run: number
  source: AgentSource
  /** The order the event belongs to, or null for a turn the developer started. */
  orderId: string | null
}

/** Words a model or the customer said, drawn as speech and never as evidence. */
export interface Said extends SessionEventBase {
  type: 'said'
  speaker: Speaker
  text: string
}

/** A tool the model called, with a summary code wrote of what it was called with. */
export type ToolCall = SessionEventBase & {
  type: 'tool_call'
  /** Pairs the call with its result, counting from 1 within the run. */
  call: number
  summary: string
} & (
    | { tool: Exclude<JobTool, 'book_compute'> }
    | { tool: 'book_compute'; offer: string; quantity: number }
  )

/** The limits that applied when the model compared offers, in micros. */
export interface ToolLimits {
  /** The most `service.ts` lets a booking cost per GPU-hour. */
  budgetPerGpuHour: bigint
  /** Whether `service.ts` books compute at all. */
  computeSwitch: 'on' | 'off'
  /** The agent's authority, the most it can hold in bookings at once. */
  authority: bigint
  /** What the agent had left of it. */
  authorityLeft: bigint
}

/**
 * What a tool returned, in a summary code wrote. A refusal names its reason code and the layer
 * that refused. A listing of offers carries them and the limits that applied, so the comparison can
 * be shown as it was. A result shown again, as evidence beside an answer, names the call it records
 * and is never a new call.
 */
export type ToolResult = SessionEventBase & {
  type: 'tool_result'
  call: number
  tool: JobTool
  summary: string
  /** For a result shown again, the run and call that made it. */
  recalled: { run: number; call: number } | null
  /** For `compute_offers`, the offers the model saw. */
  offers: ComputeOffer[] | null
  /** For `compute_offers`, the limits that applied to them. */
  limits: ToolLimits | null
} & ({ ok: true } | { ok: false; code: ReasonCode; layer: RefusalLayer })

/** A fact code outside the model verified, with who verified it and what it rests on. */
export interface SessionFact extends SessionEventBase, FactBody {
  type: 'fact'
}

/**
 * A commitment as a receipt: what it is, whose it is, what it holds and its state on the lock, as
 * a check read it, with who verified it and where. A job commitment carries what a link to verify it
 * carries, so the screen builds its own link and checks it from the chain.
 */
export interface CommitmentReceipt extends SessionEventBase {
  type: 'commitment'
  /** `compute` is the business's booking of compute, and `job` the customer's commitment. */
  role: 'compute' | 'job'
  reference: CommitmentReference
  /** The reserve, in micros. */
  amount: bigint
  state: RailState
  verifiedBy: VerifiedBy
  block: PinnedBlock
  transactionHash: Hex | null
  /** For a job, what a link to verify it carries, and null for compute. */
  verification: JobVerification | null
}

/** One event of the agent session. */
export type AgentSessionEvent = Said | ToolCall | ToolResult | SessionFact | CommitmentReceipt

/** The longest speech one event carries. A longer answer goes in several. */
export const SAID_TEXT_MAX = 4000
/** The longest summary a tool call or result carries. */
export const SUMMARY_MAX = 500

const base = { run: runJson, source: agentSourceJson, orderId: orderIdJson.nullable() }
const call = z.number().int().positive().max(10_000)
const summary = z.string().min(1).max(SUMMARY_MAX)
const otherTools = JOB_TOOLS.filter((t) => t !== 'book_compute') as [
  Exclude<JobTool, 'book_compute'>,
  ...Exclude<JobTool, 'book_compute'>[],
]

const limitsJson = z.strictObject({
  budgetPerGpuHour: u256,
  computeSwitch: z.enum(['on', 'off']),
  authority: u256,
  authorityLeft: u256,
})

const toolResultFields = {
  ...base,
  type: z.literal('tool_result'),
  call,
  tool: z.enum(JOB_TOOLS),
  summary,
  recalled: z.strictObject({ run: runJson, call }).nullable(),
  offers: z.array(computeOfferJson).min(1).max(MAX_COMPUTE_OFFERS).nullable(),
  limits: limitsJson.nullable(),
}

/** Offers and limits come only with a listing of offers. */
const listingOnly = (r: { tool: JobTool; offers: unknown; limits: unknown }) =>
  r.tool === 'compute_offers' || (r.offers === null && r.limits === null)

/** Each agent session event's JSON form, which the session's event schema takes beside its own. */
export const AGENT_SESSION_EVENT_SCHEMAS = [
  z.strictObject({
    ...base,
    type: z.literal('said'),
    speaker: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('model'), model: z.string().min(1).max(100) }),
      z.strictObject({ kind: z.literal('customer') }),
    ]),
    text: z.string().min(1).max(SAID_TEXT_MAX),
  }),
  z.union([
    z.strictObject({
      ...base,
      type: z.literal('tool_call'),
      call,
      tool: z.literal('book_compute'),
      summary,
      offer: z.string().min(1).max(64),
      quantity: z.number().int().positive().max(1024),
    }),
    z.strictObject({
      ...base,
      type: z.literal('tool_call'),
      call,
      tool: z.enum(otherTools),
      summary,
    }),
  ]),
  z.union([
    z.strictObject({ ...toolResultFields, ok: z.literal(true) }).refine(listingOnly),
    z
      .strictObject({
        ...toolResultFields,
        ok: z.literal(false),
        code: reasonCodeJson,
        layer: z.enum(REFUSAL_LAYERS),
      })
      .refine(listingOnly),
  ]),
  z.strictObject({ ...base, type: z.literal('fact'), ...factBodyShape }),
  z
    .strictObject({
      ...base,
      type: z.literal('commitment'),
      role: z.enum(['compute', 'job']),
      reference: commitmentReferenceJson,
      amount: u256,
      state: z.enum(RAIL_STATES),
      verifiedBy: z.enum(VERIFIERS),
      block: pinnedBlockJson,
      transactionHash: bytes32.nullable(),
      verification: jobVerificationJson.nullable(),
    })
    .refine(
      (c) => (c.role === 'job') === (c.verification !== null),
      'a job, and only a job, carries its verification',
    )
    .refine(
      (c) =>
        c.verification === null ||
        (c.verification.commitment.lock.toLowerCase() === c.reference.lock.toLowerCase() &&
          c.verification.commitment.commitmentId.toLowerCase() ===
            c.reference.commitmentId.toLowerCase()),
      'the verification names the receipt’s commitment',
    ),
] as const

/** Every agent session event type. */
export const AGENT_SESSION_EVENT_TYPES = [
  'said',
  'tool_call',
  'tool_result',
  'fact',
  'commitment',
] as const satisfies readonly AgentSessionEvent['type'][]
