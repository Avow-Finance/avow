import type { Address, Hex } from 'viem'
import type { Dependencies, DependencyCheck } from './dependencies.js'
import type { ChargeKind } from './eip712.js'
import type { ChainedGpuReservationTerms, GpuReservationTerms } from './gpu-reservation.js'
import type { ReasonCode } from './reasons.js'

/**
 * Money in terms and mandates is in micros, millionths of the currency unit, so $500 is
 * 500_000_000n. A USD token on Tempo has 6 decimals, so its base units equal micros. Times are
 * unix seconds and durations are seconds.
 */

/** ISO 4217. This release runs in US dollars only. */
export const CURRENCIES = ['USD'] as const
export type Currency = (typeof CURRENCIES)[number]

export type Side = 'buyer' | 'supplier'

/** A business-verification result. Results from a mock provider are always test data. */
export interface KybAttestation {
  provider: string
  reference: string
  verifiedAt: bigint
  testData: boolean
}

/** A verified company, on either side of a commitment. */
export interface Business {
  businessId: string
  legalName: string
  /** ISO 3166-1 alpha-2 */
  country: string
  kyb: KybAttestation | null
  /** The business's Tempo account. Its root key is the administrator's passkey. */
  account: Address
  lock: Address
}

/** What a business needs before it can receive charges. */
export interface SupplierProfile {
  businessId: string
  /**
   * The supplier's account on the rail. The business approves it on its lock, and the account's
   * root key or an admin key consents to a release or withdraws a report.
   */
  account: Address
  /** Where charges go. A change takes effect only after a delay. */
  payee: Address
  /** The key that records acceptance, signs start receipts and reports outcomes. */
  signingKey: Address
}

/** The person the business authorized to enroll agents and accept terms. */
export interface Administrator {
  adminId: string
  businessId: string
  /** The attestation that this person can bind the business, or null when none is recorded. */
  authorityReference: string | null
}

export type OutsideIdentityKind = 'visa' | 'mastercard' | 'erc-8004' | 'mppx'

/** An identity the agent holds outside Avow. This release records these and no check reads them. */
export interface OutsideIdentity {
  kind: OutsideIdentityKind
  reference: string
}

/** An AI agent, identified by a Tempo access key the business issued. */
export interface Agent {
  agentId: string
  businessId: string
  key: Address
  keyLocation: 'sdk' | 'self-hosted-mcp' | 'none'
  operator: string | null
  outsideIdentities: readonly OutsideIdentity[]
  revokedAt: bigint | null
}

export const MANDATE_ACTIONS = ['reserve', 'cancel', 'start', 'pay'] as const
export type MandateAction = (typeof MANDATE_ACTIONS)[number]

/** When the administrator has to approve a reserve in person. Amounts are micros. */
export type ApprovalRule =
  | { kind: 'never' }
  | { kind: 'above'; amount: bigint }
  | { kind: 'always' }

/**
 * A spending limit for one token, in the token's base units. It mirrors the agent key's limit
 * on the rail that the mandate's signature names.
 */
export interface PaymentLimit {
  token: Address
  amount: bigint
  /** 0 for a one-time limit. */
  period: bigint
}

/**
 * What one agent may commit to, signed by the business's administrator. An empty supplier or
 * category list puts no limit on that dimension, and at least one of the two must be non-empty.
 */
export interface Mandate {
  mandateId: Hex
  businessId: string
  agentId: string
  /** The business's account, whose root key signs the mandate. */
  account: Address
  /** The agent's key. The mandate's hash is bound into this key's authorization on Tempo. */
  agentKey: Address
  actions: readonly MandateAction[]
  currency: Currency
  capPerCommitment: bigint
  capOpenReserves: bigint
  /** Business ids of the suppliers the agent may commit to. */
  suppliers: readonly string[]
  categories: readonly string[]
  paymentLimits: readonly PaymentLimit[]
  approvalRule: ApprovalRule
  expiry: bigint
  nonce: bigint
}

/**
 * How a disputed charge ends when Avow doesn't rule. Avow's ruling key can rule until day 30 after
 * the charge is paused, the arbiter from day 30 until day 90, and a confirmed charge still unruled
 * at day 90 pays the supplier its share and the rest goes back to the business.
 */
export interface DisputeTerms {
  /** The fallback arbiter's key, which the lock names for the commitment. */
  arbiter: Address
  /** The supplier's share of a confirmed charge still unruled at day 90, from 0 to 10,000. */
  day90SupplierShareBps: number
}

/** The version of the terms a plain booking uses. A reader refuses any version it doesn't know. */
export const TERMS_VERSION = 2

/**
 * The version of the terms a booking uses when it relies on another business's booking. It's
 * version 2 with one more section, `dependencies`, so a plain booking stays on version 2.
 */
export const CHAINED_TERMS_VERSION = 3

/** Every amount in version 2 terms is an integer count of millionths of the terms' currency. */
export const AMOUNT_DECIMALS = 6

/**
 * The templates this code knows, by name and version. A template fixes what its subject holds and
 * the rules its terms follow, and its meaning never changes. A new meaning is a new version.
 */
export const TEMPLATE_IDS = ['gpu-reservation/1'] as const
export type TemplateId = (typeof TEMPLATE_IDS)[number]

/** What the buyer owes for the subject. The lock never reads it, so the terms describe it only. */
export type Consideration =
  /** An amount for each unit the template names, such as a GPU-hour. */
  | { kind: 'rate'; amount: bigint; unit: string }
  /** One amount for the whole subject. */
  | { kind: 'fixed'; amount: bigint }

/**
 * One charge the supplier can report, up to `amount`, from `earliest` until the charge deadline.
 * The kinds are the ones a lock can hold.
 */
export interface RemedyCharge {
  kind: ChargeKind
  amount: bigint
  earliest: bigint
}

/** What the buyer owes when it doesn't go ahead as agreed, with the deadlines around a charge. */
export interface Remedies {
  /** The last moment the supplier can accept. After it, the backing goes back. */
  acceptBy: bigint
  /** Until this moment the buyer can cancel without a charge. */
  freeCancelBy: bigint
  /** In the order of the lock's charge codes, one of each kind at most. */
  charges: readonly RemedyCharge[]
  /** The last moment the supplier can report a charge. */
  chargeDeadline: bigint
}

/** How a reported charge can be contested and who rules when Avow doesn't. */
export interface Resolution {
  /** How long the buyer has to contest a confirmed charge. */
  contestWindow: bigint
  /** The fallback arbiter's key, which the lock names for the commitment. */
  arbiter: Address
  /** The supplier's share of a confirmed charge still unruled at day 90, from 0 to 10,000. */
  day90SupplierShareBps: number
}

/**
 * Money the buyer reserves in its own lock for the supplier, which the lock pays charges from and
 * gives back at the release date. It's the only backing this release enforces.
 */
export interface ReserveBacking {
  kind: 'reserve'
  /** The side whose promise it backs. The other side benefits, and this release backs the buyer only. */
  side: 'buyer'
  /** Equal to the largest charge. */
  amount: bigint
  /** When a reserve nobody released or charged goes back to the business. */
  releaseDate: bigint
}

/** What secures a commitment. A change of backing changes the terms hash. */
export type Backing = ReserveBacking

/**
 * The terms of a commitment, version 2. The header (version, template, currency and amount
 * decimals) says how to read the five sections. Only the subject depends on the template.
 * Remedies, resolution and backing hold everything a lock enforces, and consideration is
 * described only. Nothing here names a rail, so the same terms and hash work on any EVM rail.
 */
export interface TermsOf<Subject, Template extends TemplateId> {
  version: typeof TERMS_VERSION
  template: Template
  currency: Currency
  amountDecimals: typeof AMOUNT_DECIMALS
  subject: Subject
  consideration: Consideration
  remedies: Remedies
  resolution: Resolution
  backing: Backing
}

/** Version 2 terms under any template this code knows. */
export type Terms = GpuReservationTerms

/**
 * The terms of a commitment that relies on other bookings, version 3. They hold version 2's header
 * and five sections and one more section, `dependencies`, which names each booking this one relies
 * on. The header gains `dependencyCheck`, which says who checks those bookings for the buyer. The
 * lock enforces nothing in either.
 */
export interface ChainedTermsOf<Subject, Template extends TemplateId>
  extends Omit<TermsOf<Subject, Template>, 'version'> {
  version: typeof CHAINED_TERMS_VERSION
  dependencyCheck: DependencyCheck
  dependencies: Dependencies
}

/** Version 3 terms under any template this code knows. */
export type ChainedTerms = ChainedGpuReservationTerms

/** An agent's request to reserve money for a supplier under terms. */
export interface ReserveRequest {
  commitmentId: Hex
  agentKey: Address
  /** The supplier's business id, as the mandate names it. */
  supplier: string
  /** The supplier's payout address on the rail, which receives any charge. */
  payee: Address
  category: string
  terms: Terms
}

export type DecisionResult = 'approved' | 'denied' | 'needs_human'

/** Every check Avow makes, whether it approves or denies. */
export interface Decision {
  decisionId: string
  checked: 'reserve'
  result: DecisionResult
  reason: ReasonCode
  policyVersion: string
  at: bigint
  /** References to the evidence the check used, such as the mandate hash and the terms hash. */
  evidence: readonly string[]
}
