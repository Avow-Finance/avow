import { type Hex, hashTypedData, keccak256, stringToHex, zeroHash } from 'viem'
import { z } from 'zod'
import { AGENT_REQUEST_LIFETIME, heldAgentLabelJson } from './agent-connect.js'
import { canonicalJson } from './canonical.js'
import { type AvowDomain, domain, mandateHash } from './eip712.js'
import { BUSINESS_ID } from './fields.js'
import { address, bytes32, hexBytes, u64, u256 } from './json-fields.js'
import {
  coversSale,
  SALE_APPROVAL_LASTS,
  type SaleContent,
  saleContentJson,
} from './sale-approval.js'
import {
  carriesSellerMandateTerms,
  type SellerMandate,
  sellerMandateTermsJson,
  sellerMandateTermsProblem,
} from './seller-mandate.js'
import { reasonCodeJson } from './session-fields.js'
import type { Mandate, ReplacementMandate } from './types.js'
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
 * request is active. A request to approve one sale is the exception. It has no change to land, so
 * the sale can be made while the request is approved, and it's active once the sale was made.
 */

/** What a request asks a person to change. */
export const APPROVAL_KINDS = [
  'agent_authority',
  'raise_limit',
  'name_supplier',
  'open_mode',
  'seller_mandate',
  'sale',
] as const
export type ApprovalKind = (typeof APPROVAL_KINDS)[number]

/**
 * The kinds an agent the business already knows asks for, which a business decides its agents may
 * ask for. Each changes a buying agent's authority, or sets what a selling agent may promise. A
 * request to approve one sale changes no authority, so it isn't one of these, and the limits on
 * asking for one aren't set yet.
 */
export const APPROVAL_CHANGE_KINDS = [
  'raise_limit',
  'name_supplier',
  'open_mode',
  'seller_mandate',
] as const
export type ApprovalChangeKind = (typeof APPROVAL_CHANGE_KINDS)[number]

const DAY = 86_400n

/**
 * How long each kind waits for a decision, in seconds, before it lapses. A change to authority
 * waits a day. Agent authority keeps the hour an agent's request has always waited, since anyone can
 * ask, and a request holds one of the business's few waiting places. Opening a request's link never
 * moves its expiry.
 */
export const APPROVAL_LIFETIMES: { readonly [K in ApprovalKind]: bigint } = {
  agent_authority: AGENT_REQUEST_LIFETIME,
  raise_limit: DAY,
  name_supplier: DAY,
  open_mode: DAY,
  seller_mandate: DAY,
  sale: DAY,
}

/** The window an agent's asks are counted over, in seconds. */
export const APPROVAL_ASK_WINDOW = DAY

/**
 * The most changes one agent can ask one business for in `APPROVAL_ASK_WINDOW`, merged repeats
 * aside. Asking for agent authority, which `connect` does, isn't counted.
 */
export const APPROVAL_ASKS_PER_DAY = 10

/**
 * How long an approved request of each kind has before it lapses, in seconds from its approval. A
 * change has an hour to start, so an approval can't be held back and applied much later. An
 * approved sale has `SALE_APPROVAL_LASTS` to be made, since it waits on the buyer's next order.
 */
export const APPROVAL_EXECUTION_WINDOWS: { readonly [K in ApprovalKind]: bigint } = {
  agent_authority: 60n * 60n,
  raise_limit: 60n * 60n,
  name_supplier: 60n * 60n,
  open_mode: 60n * 60n,
  seller_mandate: 60n * 60n,
  sale: SALE_APPROVAL_LASTS,
}

/**
 * How long after a decline an agent waits before it can ask the same again, in seconds. The same
 * means the same kind, and for a supplier, the same supplier.
 */
export const APPROVAL_DECLINE_COOLDOWN = DAY

/**
 * Why an agent asked, from a fixed list, each with the words Avow shows for it. An agent gives no
 * text of its own, so a request can't carry instructions to whoever reads it. The one thing an
 * agent writes is what it would sell: its names in an ask for a seller's mandate, and its name, its
 * summary and what counts as delivery in an ask for one sale. Each reads on one line with no hidden
 * mark in it, and a card shows each in quotes under a label of its own. They are still an agent's
 * words, and the quotes are what tell a person so.
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
  new_seller: {
    kind: 'seller_mandate',
    text: 'The agent holds no authority to sell yet',
  },
  sale_needs_person: {
    kind: 'sale',
    text: "The sale is one a person decides under the seller's mandate",
  },
  seller_limits: {
    kind: 'seller_mandate',
    text: 'The agent needs other limits on what it sells than the ones it holds',
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

/** The hash of a seller's mandate, which is never the zero hash, since no mandate has it. */
const mandateHashJson = bytes32.refine((h) => h !== zeroHash, 'a mandate hash')

/**
 * Each kind's terms, as the agent asks for them, and the state Avow read when the request arrived,
 * which the request is checked against again when it executes. Agent authority's limits are the
 * ones the administrator sets when approving, so its terms are the agent's name and keys.
 */
const KIND_FIELDS = {
  agent_authority: {
    terms: z.strictObject({ label: heldAgentLabelJson, signingKey: address.nullable() }),
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
    terms: z.strictObject({ supplier: z.string().regex(BUSINESS_ID) }),
    /**
     * The hash of the mandate the supplier would be added to, the account the lock would name, and
     * how many times that account's place on the lock had changed. The lock names the supplier
     * only while that count stands, so a removal after the approval is never undone by it.
     */
    basis: z.strictObject({ mandate: bytes32, supplier: address, supplierChanges: u256 }),
  },
  open_mode: {
    /** The cap on what the lock holds with listed suppliers at once. */
    terms: z.strictObject({ cap: u256 }).refine((t) => t.cap > 0n, 'open mode is a cap above zero'),
    /**
     * The cap the lock held when the request arrived, zero being closed, and how many times it had
     * changed. The lock sets the new cap only while both stand, so a change in between, even one
     * that put the cap back, makes the request stale.
     */
    basis: z.strictObject({ openCap: u256, openCapChanges: u256 }),
  },
  sale: {
    /**
     * The content of the one sale the agent asks a person to approve: the signing key that would
     * make it, the buyer, the whole offer version and the units. Approving it lets that key make
     * that sale once within `SALE_APPROVAL_LASTS`, and widens nothing.
     */
    terms: saleContentJson,
    /**
     * The hash of the seller's mandate the sale would be made under. A mandate that replaces it,
     * or its revocation, makes the request stale, so an approval never outlives the limits the
     * administrator read it against.
     */
    basis: z.strictObject({ sellerMandate: mandateHashJson }),
  },
  seller_mandate: {
    /**
     * The exact terms of the seller's mandate the agent asks for, with the signing key the mandate
     * would bind among them. The request's `agentKey` is the key of the agent that asks, which may
     * be another key of the same agent. An approval is carried out only by a mandate the root key
     * signs that carries these terms and nothing else, as `carriesOutSellerRequest` checks.
     */
    terms: sellerMandateTermsJson.refine(
      (t) => sellerMandateTermsProblem(t) === null,
      "well-formed terms of a seller's mandate",
    ),
    /**
     * The hash of the seller's mandate the signing key holds, which the new one would replace, or
     * null when it holds none. Another mandate signed in between makes the request stale. It is
     * never the zero hash, which no mandate can replace.
     */
    basis: z.strictObject({ sellerMandate: mandateHashJson.nullable() }),
  },
} as const

/**
 * What an agent sends to ask for a change to authority it holds, or for authority to sell. Avow
 * reads the basis itself.
 */
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
  z.strictObject({
    kind: z.literal('seller_mandate'),
    terms: KIND_FIELDS.seller_mandate.terms,
    reason: z.enum(reasonsFor('seller_mandate')),
  }),
  z.strictObject({
    kind: z.literal('sale'),
    terms: KIND_FIELDS.sale.terms,
    reason: z.enum(reasonsFor('sale')),
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
 * approved request whose change never started within its kind's `APPROVAL_EXECUTION_WINDOWS` lapses. The last five states are final.
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
  /** When it was approved, for one that lapsed before its change started, or null. */
  z.strictObject({ state: z.literal('expired'), approvedAt: at.nullable() }),
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

/**
 * The hash of a console link that opens one request on its signing page. It names the request by
 * its id and grants nothing, since whoever opens it still signs in, and only the account's root key
 * decides what the page shows.
 */
export function signingHash(id: string): string {
  if (!isApprovalRequestId(id)) throw new RangeError(`${id} isn't a request id`)
  return `#sign-${id}`
}

/** The request a console link's hash names for signing, or null when it names none. */
export function signingIdOf(hash: string): string | null {
  const id = hash.startsWith('#sign-') ? hash.slice('#sign-'.length) : ''
  return isApprovalRequestId(id) ? id : null
}

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
  z
    .strictObject({
      ...recordBase,
      kind: z.literal('seller_mandate'),
      businessId: z.string().min(1).max(200),
      terms: KIND_FIELDS.seller_mandate.terms,
      reason: z.enum(reasonsFor('seller_mandate')),
      basis: KIND_FIELDS.seller_mandate.basis,
    })
    .refine(
      (r) => (r.reason === 'new_seller') === (r.basis.sellerMandate === null),
      "a first seller's mandate replaces none, and a change of limits replaces one",
    ),
  z
    .strictObject({
      ...recordBase,
      kind: z.literal('sale'),
      businessId: z.string().min(1).max(200),
      terms: KIND_FIELDS.sale.terms,
      reason: z.enum(reasonsFor('sale')),
      basis: KIND_FIELDS.sale.basis,
    })
    .refine(
      (r) => r.terms.offer.supplier === r.businessId,
      'a business is asked to approve a sale of its own offer',
    )
    // An approved sale is made by the buyer's order. It has no change of its own to land, so it's
    // never on its way, never fails to land, and no transaction carried it.
    .refine(
      ({ status: s }) =>
        s.state !== 'executing' &&
        s.state !== 'failed' &&
        (s.state !== 'active' || s.transaction === null),
      'a sale has no change to land',
    ),
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

/**
 * The daily limit the root key set on an agent's key for a token, in its base units, as the
 * mandate records it, or null when the mandate sets none for that token.
 */
export const dailyLimitOf = (mandate: Mandate, token: Hex): bigint | null =>
  mandate.paymentLimits.find(
    (l) => l.token.toLowerCase() === token.toLowerCase() && l.period === DAY_SECONDS,
  )?.amount ?? null

const DAY_SECONDS = 86_400n

/**
 * The one mandate that carries out an approved change to an agent's mandate: its current mandate
 * with only what was asked for changed, the next nonce, and the mandate the request was asked
 * against named as the one it replaces. A raise raises the one limit asked for, and naming a
 * supplier adds it to the mandate's suppliers. The console signs it, and Avow takes nothing else
 * for the request, since anything else changes more than the administrator approved. It refuses
 * a current mandate other than the one the request was asked against, since that change no longer
 * applies and signing it would sign something nobody approved.
 */
export function changedMandate(
  current: Mandate,
  request: ApprovalRequest & { kind: 'raise_limit' | 'name_supplier' },
  domain: AvowDomain,
): ReplacementMandate {
  if (mandateHash(current, domain).toLowerCase() !== request.basis.mandate.toLowerCase()) {
    throw new RangeError("The agent's mandate changed since it asked, so this change can't apply")
  }
  const changed =
    request.kind === 'raise_limit'
      ? request.terms.limit === 'per_commitment'
        ? { capPerCommitment: request.terms.to }
        : { capOpenReserves: request.terms.to }
      : { suppliers: [...current.suppliers, request.terms.supplier] }
  return {
    ...current,
    ...changed,
    nonce: current.nonce + 1n,
    replaces: request.basis.mandate,
  }
}

/**
 * Whether a seller's mandate carries out an approved request for one. The mandate is well formed
 * and for the request's business, it replaces exactly the mandate the request was asked against,
 * and it carries the terms asked for with nothing moved, the signing key among them. Whoever
 * records the mandate also checks that the business account's root key signed it.
 */
export function carriesOutSellerRequest(request: ApprovalRequest, mandate: SellerMandate): boolean {
  if (request.kind !== 'seller_mandate') return false
  if (!carriesSellerMandateTerms(mandate, request.terms)) return false
  return (
    mandate.businessId === request.businessId && mandate.replaces === request.basis.sellerMandate
  )
}

/**
 * Whether a sale can be made on a request for one, as the request stands at `now`. The request is
 * approved and within `SALE_APPROVAL_LASTS` of its approval, it was asked against the seller's
 * mandate the sale is made under, and the sale is exactly the one approved, by the same signing
 * key. Whoever records the sale marks the request used by that sale in the same step, since a
 * request doesn't say which sale used it. Once the sale was made the request is active and covers
 * nothing, so a later check of that same sale goes by the record keeper's note of which sale used
 * the approval.
 */
export function saleRequestCovers(
  request: ApprovalRequest,
  sale: SaleContent,
  sellerMandate: Hex,
  now: bigint,
): boolean {
  if (request.kind !== 'sale' || request.status.state !== 'approved') return false
  if (typeof now !== 'bigint' || now >= request.status.at + SALE_APPROVAL_LASTS) return false
  if (typeof sellerMandate !== 'string') return false
  if (request.basis.sellerMandate !== sellerMandate.toLowerCase()) return false
  return coversSale(request.terms, sale)
}
