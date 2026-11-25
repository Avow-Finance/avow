import { type Hex, hashTypedData, keccak256, stringToHex } from 'viem'
import { z } from 'zod'
import { AGENT_REQUEST_LIFETIME } from './agent-connect.js'
import { canonicalJson } from './canonical.js'
import { type AvowDomain, domain } from './eip712.js'
import { address, bytes32, hexBytes, u64, u256 } from './json-fields.js'
import { reasonCodeJson } from './session-fields.js'
import { MESSAGE_VERSIONS } from './version.js'
import type { Parsed } from './wire.js'

/**
 * A request for a person's approval. When an agent needs authority it doesn't hold, it asks, and
 * Avow stores what it asked for as one record of one shape, whichever harness, console or inbox
 * shows it. The agent gets the record's id and can read where it stands. It can never approve,
 * decline or change it, and a different ask is a different request.
 *
 * The business's administrator decides with the account's root key, which signs an
 * `ApprovalDecision` naming the request, the business, the agent, the exact terms, the state the
 * request was made against and its expiry. Signing in proves who the administrator is, and only
 * this signature decides a particular request. None of the kinds approves a single payment.
 *
 * Approval and execution are separate. A request waits, is approved once the root key signs, then
 * executes while its change lands, and is active only once it has. It can also end failed,
 * declined, expired or stale. An agent treats the authority it asked for as usable only once its
 * request is active.
 */

/** What a request asks a person to change. */
export const APPROVAL_KINDS = [
  'agent_authority',
  'raise_limit',
  'name_supplier',
  'open_mode',
] as const
export type ApprovalKind = (typeof APPROVAL_KINDS)[number]

/** The kinds that change authority an agent already holds, which a business decides its agents may ask for. */
export const APPROVAL_CHANGE_KINDS = ['raise_limit', 'name_supplier', 'open_mode'] as const
export type ApprovalChangeKind = (typeof APPROVAL_CHANGE_KINDS)[number]

const DAY = 86_400n

/**
 * How long each kind waits for a decision, in seconds, before it lapses. A change to authority
 * waits a day. Agent authority keeps the hour an agent's request has always waited.
 */
export const APPROVAL_LIFETIMES: { readonly [K in ApprovalKind]: bigint } = {
  agent_authority: AGENT_REQUEST_LIFETIME,
  raise_limit: DAY,
  name_supplier: DAY,
  open_mode: DAY,
}

/** The most requests one agent can make in a day, counting every kind, merged repeats aside. */
export const APPROVAL_ASKS_PER_DAY = 10

/**
 * How long after a decline an agent waits before it can ask the same again, in seconds. The same
 * means the same kind, and for a supplier, the same supplier.
 */
export const APPROVAL_DECLINE_COOLDOWN = DAY

/**
 * Why an agent asked, from a fixed list, each with the words Avow shows for it. An agent gives no
 * text of its own, so a request can't carry instructions to whoever reads it.
 */
export const APPROVAL_REASONS = {
  new_agent: {
    kind: 'agent_authority',
    text: 'The agent is new and holds no authority yet',
  },
  over_commitment_limit: {
    kind: 'raise_limit',
    text: 'A commitment the agent needs is above its limit per commitment',
  },
  reserves_limit_full: {
    kind: 'raise_limit',
    text: 'A commitment the agent needs would take its open reserves above its limit',
  },
  new_supplier: {
    kind: 'name_supplier',
    text: "The agent needs a supplier its limits don't name",
  },
  listed_suppliers: {
    kind: 'open_mode',
    text: "The agent needs suppliers listed in the testnet's supplier registry",
  },
} as const satisfies Record<string, { kind: ApprovalKind; text: string }>
export type ApprovalReason = keyof typeof APPROVAL_REASONS

/** The reasons that fit one kind. */
const reasonsFor = <K extends ApprovalKind>(kind: K) =>
  (Object.keys(APPROVAL_REASONS) as ApprovalReason[]).filter(
    (r) => APPROVAL_REASONS[r].kind === kind,
  ) as [ApprovalReason, ...ApprovalReason[]]

/** The words Avow shows for a reason. */
export const describeApprovalReason = (r: ApprovalReason): string => APPROVAL_REASONS[r].text

/** The limits of a mandate a raise can ask for, each a cap in the reserve token's base units. */
export const RAISABLE_LIMITS = ['per_commitment', 'open_reserves'] as const
export type RaisableLimit = (typeof RAISABLE_LIMITS)[number]

const label = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[^\p{Cc}]+$/u, 'printable characters only')

/**
 * Each kind's terms, as the agent asks for them, and the state Avow read when the request arrived,
 * which the request is checked against again when it executes. Agent authority's limits are the
 * ones the administrator sets when approving, so its terms are the agent's name and keys.
 */
const KIND_FIELDS = {
  agent_authority: {
    terms: z.strictObject({ label, signingKey: address.nullable() }),
    /** The agent holds no authority, which is what an approval would change. */
    basis: z.strictObject({ mandate: z.null() }),
  },
  raise_limit: {
    terms: z
      .strictObject({ limit: z.enum(RAISABLE_LIMITS), from: u256, to: u256 })
      .refine((t) => t.to > t.from, 'a raise is above the limit it replaces'),
    /** The hash of the mandate the raise would replace. */
    basis: z.strictObject({ mandate: bytes32 }),
  },
  name_supplier: {
    terms: z.strictObject({ supplier: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/) }),
    basis: z.strictObject({ mandate: bytes32 }),
  },
  open_mode: {
    /** The cap on what the lock holds with listed suppliers at once. */
    terms: z.strictObject({ cap: u256 }).refine((t) => t.cap > 0n, 'open mode is a cap above zero'),
    /** The cap the lock held when the request arrived, zero being closed. */
    basis: z.strictObject({ openCap: u256 }),
  },
} as const

/** What an agent sends to ask for a change to authority it holds. Avow reads the basis itself. */
export const approvalAskJson = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('raise_limit'),
    terms: KIND_FIELDS.raise_limit.terms,
    reason: z.enum(reasonsFor('raise_limit')),
  }),
  z.strictObject({
    kind: z.literal('name_supplier'),
    terms: KIND_FIELDS.name_supplier.terms,
    reason: z.enum(reasonsFor('name_supplier')),
  }),
  z.strictObject({
    kind: z.literal('open_mode'),
    terms: KIND_FIELDS.open_mode.terms,
    reason: z.enum(reasonsFor('open_mode')),
  }),
])
export type ApprovalAsk = z.infer<typeof approvalAskJson>

export function parseApprovalAsk(json: unknown): Parsed<ApprovalAsk> {
  const parsed = approvalAskJson.safeParse(json)
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, reason: 'message.invalid' }
}

/** Where a request stands. */
export const APPROVAL_STATES = [
  'waiting',
  'approved',
  'executing',
  'active',
  'failed',
  'declined',
  'expired',
  'stale',
] as const
export type ApprovalState = (typeof APPROVAL_STATES)[number]

/**
 * The moves a request can make, from each state. Approved moves to active directly where the
 * change lands with the approval itself, such as a mandate Avow holds, and through executing where
 * a transaction has to land. A request found stale when it would execute never executes, and an
 * approved request whose change never started by its expiry lapses. The last five states are final.
 */
export const APPROVAL_MOVES: { readonly [S in ApprovalState]: readonly ApprovalState[] } = {
  waiting: ['approved', 'declined', 'expired', 'stale'],
  approved: ['executing', 'active', 'failed', 'expired', 'stale'],
  executing: ['active', 'failed'],
  active: [],
  failed: [],
  declined: [],
  expired: [],
  stale: [],
}

export const canApprovalMove = (from: ApprovalState, to: ApprovalState): boolean =>
  APPROVAL_MOVES[from].includes(to)

export const isApprovalFinal = (state: ApprovalState): boolean => APPROVAL_MOVES[state].length === 0

const at = u64
export const approvalStatusJson = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('waiting') }),
  z.strictObject({ state: z.literal('expired') }),
  z.strictObject({ state: z.literal('approved'), at }),
  /** The transaction carrying the change, or null where none has been sent yet. */
  z.strictObject({ state: z.literal('executing'), at, transaction: bytes32.nullable() }),
  /** The transaction that carried the change, or null where the change was a mandate Avow holds. */
  z.strictObject({ state: z.literal('active'), at, transaction: bytes32.nullable() }),
  z.strictObject({ state: z.literal('failed'), at, reason: reasonCodeJson }),
  z.strictObject({ state: z.literal('declined'), at }),
  z.strictObject({ state: z.literal('stale'), at }),
])
export type ApprovalStatus = z.infer<typeof approvalStatusJson>

/** A request id: 16 random bytes as 32 lower-case hex characters. */
const ID = /^[0-9a-f]{32}$/
export const isApprovalRequestId = (text: string): boolean => ID.test(text)

const recordBase = {
  id: z.string().regex(ID),
  /** The key of the agent that asked. */
  agentKey: address,
  requestedAt: u64,
  expiresAt: u64,
  status: approvalStatusJson,
}

/**
 * A request as Avow holds it and answers it. Each kind carries its own terms, reasons and basis,
 * so a request can't name a basis or reason that doesn't fit what it asks. Only agent authority
 * asked before the agent knew its business names none, until an approval binds it.
 */
export const approvalRequestJson = z.discriminatedUnion('kind', [
  z.strictObject({
    ...recordBase,
    kind: z.literal('agent_authority'),
    businessId: z.string().min(1).max(200).nullable(),
    terms: KIND_FIELDS.agent_authority.terms,
    reason: z.enum(reasonsFor('agent_authority')),
    basis: KIND_FIELDS.agent_authority.basis,
  }),
  z.strictObject({
    ...recordBase,
    kind: z.literal('raise_limit'),
    businessId: z.string().min(1).max(200),
    terms: KIND_FIELDS.raise_limit.terms,
    reason: z.enum(reasonsFor('raise_limit')),
    basis: KIND_FIELDS.raise_limit.basis,
  }),
  z.strictObject({
    ...recordBase,
    kind: z.literal('name_supplier'),
    businessId: z.string().min(1).max(200),
    terms: KIND_FIELDS.name_supplier.terms,
    reason: z.enum(reasonsFor('name_supplier')),
    basis: KIND_FIELDS.name_supplier.basis,
  }),
  z
    .strictObject({
      ...recordBase,
      kind: z.literal('open_mode'),
      businessId: z.string().min(1).max(200),
      terms: KIND_FIELDS.open_mode.terms,
      reason: z.enum(reasonsFor('open_mode')),
      basis: KIND_FIELDS.open_mode.basis,
    })
    .refine((r) => r.terms.cap !== r.basis.openCap, 'open mode changes the cap the lock holds'),
])
export type ApprovalRequest = z.infer<typeof approvalRequestJson>

export function parseApprovalRequest(json: unknown): Parsed<ApprovalRequest> {
  const parsed = approvalRequestJson.safeParse(json)
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, reason: 'message.invalid' }
}

/** A list of requests, newest first. */
export const approvalRequestListJson = z.strictObject({
  requests: z.array(approvalRequestJson).max(200),
})
export type ApprovalRequestList = z.infer<typeof approvalRequestListJson>

export function parseApprovalRequestList(json: unknown): Parsed<ApprovalRequestList> {
  const parsed = approvalRequestListJson.safeParse(json)
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, reason: 'message.invalid' }
}

const hashOf = (value: unknown): Hex => keccak256(stringToHex(canonicalJson(value)))

/** The hash of what a request asks for: its kind, its reason and its exact terms. */
export const approvalTermsHash = (r: Pick<ApprovalRequest, 'kind' | 'reason' | 'terms'>): Hex =>
  hashOf({ kind: r.kind, reason: r.reason, terms: r.terms })

/** The hash of the state a request was made against. */
export const approvalBasisHash = (r: Pick<ApprovalRequest, 'basis'>): Hex => hashOf(r.basis)

/**
 * What a business has its agents may ask for. Agent authority is always open to ask, since a
 * request grants nothing until the root key signs. A business with no policy lets its agents ask
 * for every change.
 */
export const approvalPolicyJson = z.strictObject({
  agentsMayAsk: z
    .array(z.enum(APPROVAL_CHANGE_KINDS))
    .max(APPROVAL_CHANGE_KINDS.length)
    .refine((kinds) => new Set(kinds).size === kinds.length, 'each kind once'),
})
export type ApprovalPolicy = z.infer<typeof approvalPolicyJson>

export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = { agentsMayAsk: [...APPROVAL_CHANGE_KINDS] }

export function parseApprovalPolicy(json: unknown): Parsed<ApprovalPolicy> {
  const parsed = approvalPolicyJson.safeParse(json)
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, reason: 'message.invalid' }
}

/** What the root key decides about a request. */
export const APPROVAL_DECISIONS = ['approve', 'decline'] as const
export type ApprovalDecisionChoice = (typeof APPROVAL_DECISIONS)[number]

export const APPROVAL_DECISION_TYPES = {
  ApprovalDecision: [
    { name: 'requestId', type: 'bytes16' },
    { name: 'businessId', type: 'string' },
    { name: 'agentKey', type: 'address' },
    { name: 'kind', type: 'string' },
    { name: 'termsHash', type: 'bytes32' },
    { name: 'basisHash', type: 'bytes32' },
    { name: 'expiresAt', type: 'uint64' },
    { name: 'decision', type: 'string' },
  ],
} as const

/**
 * The typed data the account's root key signs to decide a request, under the business's lock. It
 * names the request, the business deciding it, the agent, the exact terms, the state they were
 * asked against and the expiry, so a signature decides that request and nothing else. A request
 * that named no business is decided by the business named here.
 */
export function approvalDecisionTypedData(
  r: ApprovalRequest,
  decided: { businessId: string; decision: ApprovalDecisionChoice },
  d: AvowDomain,
) {
  if (r.businessId !== null && r.businessId !== decided.businessId) {
    throw new RangeError(`Request ${r.id} is for ${r.businessId}, not ${decided.businessId}`)
  }
  return {
    domain: domain(d, MESSAGE_VERSIONS.ApprovalDecision),
    types: APPROVAL_DECISION_TYPES,
    primaryType: 'ApprovalDecision' as const,
    message: {
      requestId: `0x${r.id}` as Hex,
      businessId: decided.businessId,
      agentKey: r.agentKey,
      kind: r.kind,
      termsHash: approvalTermsHash(r),
      basisHash: approvalBasisHash(r),
      expiresAt: r.expiresAt,
      decision: decided.decision,
    },
  }
}

/** The digest the root key signs to decide a request. */
export const approvalDecisionDigest = (
  r: ApprovalRequest,
  decided: { businessId: string; decision: ApprovalDecisionChoice },
  d: AvowDomain,
): Hex => hashTypedData(approvalDecisionTypedData(r, decided, d))

/** What the signing page sends Avow: the decision, and the root key's signature on it. */
export const approvalDecisionJson = z.strictObject({
  decision: z.enum(APPROVAL_DECISIONS),
  /** The business deciding, which a request that named none is bound to. */
  businessId: z.string().min(1).max(200),
  signature: hexBytes,
})
export type ApprovalDecision = z.infer<typeof approvalDecisionJson>

export function parseApprovalDecision(json: unknown): Parsed<ApprovalDecision> {
  const parsed = approvalDecisionJson.safeParse(json)
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, reason: 'message.invalid' }
}
