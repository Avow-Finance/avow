import type { Address, Hex } from 'viem'
import type { ReasonCode } from './reasons.js'

/**
 * Money in terms and mandates is in micros, millionths of the currency unit, so $500 is
 * 500_000_000n. A USD token on Tempo has 6 decimals, so its base units equal micros. Times are
 * unix seconds and durations are seconds.
 */

/** ISO 4217. V1 runs in US dollars only. */
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

/** An identity the agent holds outside Avow. V1 records these and no check reads them. */
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
 * The terms of a GPU reservation, from the master spec's compute terms. Nothing here names a
 * rail, so the same terms and terms hash work on any rail that backs them.
 */
export interface ComputeTerms {
  kind: 'compute'
  resource: { gpu: string; count: number; region: string; sku: string }
  currency: Currency
  windowStart: bigint
  windowDuration: bigint
  /** The last moment the supplier can accept, the window's start by default. */
  acceptBy: bigint
  /** Usage, paid like any other purchase and never from the reserve. */
  price: { perGpuHour: bigint }
  /** The most the supplier can charge, which equals the largest charge below. */
  reserve: bigint
  freeCancelBy: bigint
  lateCancellation: bigint
  noShow: bigint
  gracePeriod: bigint
  chargeDeadline: bigint
  contestWindow: bigint
  releaseDate: bigint
}

/** An agent's request to reserve money for a supplier under terms. */
export interface ReserveRequest {
  commitmentId: Hex
  agentKey: Address
  /** The supplier's business id, as the mandate names it. */
  supplier: string
  /** The supplier's payout address on the rail, which receives any charge. */
  payee: Address
  category: string
  terms: ComputeTerms
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
