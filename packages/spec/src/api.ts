import type { Address, Hex } from 'viem'
import { z } from 'zod'
import {
  type ApiRequest,
  type Approval,
  apiRequestTypedData,
  digestOf,
  type HumanApproval,
  type Signed,
  type SignedAgreement,
  type StartReceipt,
  type SupplierAuthorization,
  type Timestamp,
} from './eip712.js'
import { address, bytes32, hexBytes, u64 } from './json-fields.js'
import { REASON_CODES, type ReasonCode } from './reasons.js'
import type { Mandate, ReserveRequest } from './types.js'
import {
  approvalJson,
  humanApprovalJson,
  mandateJson,
  type Parsed,
  parseSigned,
  parseSignedAgreement,
  reserveRequestJson,
  startReceiptJson,
  supplierAuthorizationJson,
  timestampJson,
} from './wire.js'

/**
 * The bodies Avow's API takes and answers with, which the SDK sends, a supplier's adapter sends and
 * the API reads. Every request is signed as an `ApiRequest`, and every body travels as JSON with
 * amounts and times as decimal strings.
 */
export const API_PATHS = {
  enrollments: '/v1/enrollments',
  reserveApprovals: '/v1/reserve-approvals',
  sponsorships: '/v1/sponsorships',
  supplierAuthorizations: (commitmentId: Hex) =>
    `/v1/commitments/${commitmentId.toLowerCase()}/supplier-authorizations`,
  cancellations: (commitmentId: Hex) =>
    `/v1/commitments/${commitmentId.toLowerCase()}/cancellations`,
  startRequests: (commitmentId: Hex) =>
    `/v1/commitments/${commitmentId.toLowerCase()}/start-requests`,
  startReceipts: (commitmentId: Hex) =>
    `/v1/commitments/${commitmentId.toLowerCase()}/start-receipts`,
} as const

/**
 * What an agent asks Avow's reserve check to approve. Avow reads the business, its administrator,
 * the agent, the supplier and the mandate from its own records, and the open reserves from the
 * lock, so the request carries only what the agent and the supplier agreed.
 */
export interface ReserveApprovalRequest {
  request: ReserveRequest
  /** The commitment's salt. Avow passes it to the supplier in its authorization. */
  salt: Hex
  agreement: SignedAgreement
  /** Which key funds the reserve, the agent's or the administrator's. */
  fundedBy: 'agent' | 'administrator'
  /** The administrator's approval, when the mandate asks for one. */
  humanApproval?: Signed<HumanApproval>
}

/** Avow's answer to a reserve request, with the id of the decision Avow recorded either way. */
export type ReserveApproval =
  | { ok: true; decisionId: string; approval: Signed<Approval> }
  | { ok: false; decisionId: string; reason: ReasonCode }

/**
 * An agent enrolling with Avow once its key is on the chain. The mandate the administrator signed
 * names the business, the agent and its key, and the transaction put that key on the business
 * account with the mandate's hash. The agent signs the request with that key.
 */
export interface EnrollmentRequest {
  mandate: Signed<Mandate>
  keyAuthorizedIn: Hex
}

export interface Enrollment {
  businessId: string
  agentId: string
  agentKey: Address
  mandateHash: Hex
}

/** A transaction an agent signed with `feePayer: true`, which Avow's relay co-signs or refuses. */
export interface SponsorshipRequest {
  transaction: Hex
}

export interface Sponsorship {
  transaction: Hex
}

/**
 * Avow's answer to a supplier asking for a fresh authorization for a commitment's reserve. With it
 * come Avow's approval the reserve was funded under and the buyer's signed mandate, which the
 * supplier's verifier checks against its own terms and the lock before it accepts. Avow's word on
 * either is never taken, since the verifier checks the approval against the digest the lock
 * stored and the mandate against the business account's signature.
 */
export type SupplierAuthorizationAnswer =
  | {
      ok: true
      authorization: Signed<SupplierAuthorization>
      approval: Signed<Approval>
      mandate: Signed<Mandate>
    }
  | { ok: false; reason: ReasonCode }

/**
 * Avow's answer to a business cancelling a commitment once free cancellation has ended: when Avow
 * received the cancellation, and Avow's timestamp on the signed request that carried it. A late
 * cancellation charge rests on this record. Avow records a cancellation from the end of free
 * cancellation until the no-show charge can be reported, or until the charge deadline when the
 * terms carry no no-show charge. Before free cancellation ends the business cancels on the lock,
 * and Avow refuses with `commitment.cancel_on_lock`. Once the no-show charge can be reported, a
 * cancellation can no longer change the charge, and Avow refuses with `commitment.cancel_closed`.
 * From the charge deadline on it refuses with `commitment.ended`.
 *
 * A commitment has one cancellation, so a later request to cancel it gets the first one's answer,
 * whatever the time. That answer's timestamp names the first request, and `cancelledBy` carries
 * what the later caller needs to rebuild that request's digest.
 */
export interface CancellationAnswer {
  cancelledAt: bigint
  timestamp: Signed<Timestamp>
  /** The request that cancelled the commitment, present when it isn't the one this answers. */
  cancelledBy?: CancelledBy
}

/**
 * What a later caller can't know about the signed request that cancelled a commitment: the key
 * that signed it, its request id, its expiry and its body's hash. With the caller's own audience,
 * `POST` and the commitment's cancellations path, they rebuild that request's digest, which Avow's
 * timestamp names.
 */
export type CancelledBy = Pick<ApiRequest, 'signer' | 'requestId' | 'expiry' | 'bodyHash'>

/**
 * Avow's answer to a business asking to start a job: the digest of the signed request, which the
 * supplier's start receipt names, and Avow's timestamp on it. The job can't have started before
 * the timestamp.
 */
export interface StartRequestAnswer {
  startRequestHash: Hex
  requestedAt: bigint
  timestamp: Signed<Timestamp>
}

/** The supplier's start receipt, which the business's agent passes on for Avow to record. */
export interface StartReceiptRequest {
  receipt: Signed<StartReceipt>
}

/** Avow's answer to a start receipt: recorded, or refused with the reason. */
export type StartReceiptAnswer = { ok: true } | { ok: false; reason: ReasonCode }

/**
 * What the API answers when it refuses a request outright, with a status of 400 or more, as
 * `{ "error": { "reason": "<code>", "message": "<sentence>" } }`. A refusal by Avow's relay adds
 * the fields `SponsorshipRefusal` gives for its code. Readers ignore any other field.
 */
export interface ApiError {
  error: { reason: ReasonCode; message: string }
}

/** The caps Avow's relay holds a transaction to: its gas, its fee per gas, and the most it could pay in fees. */
export const SPONSORSHIP_CAPS = ['gas', 'fee_per_gas', 'fee'] as const
export type SponsorshipCap = (typeof SPONSORSHIP_CAPS)[number]

/** The budgets of Avow's relay, each counting gas over the last 24 hours. */
export const SPONSORSHIP_BUDGETS = ['agent_key', 'business', 'supplier', 'relay'] as const
export type SponsorshipBudget = (typeof SPONSORSHIP_BUDGETS)[number]

/**
 * What a refusal by Avow's relay adds to its error, so an agent can act on it without reading the
 * message. Times are unix seconds by Avow's clock.
 *
 * - `sponsorship.over_cap` names the cap and its limit, in gas for `gas`, in attodollars a gas for
 *   `fee_per_gas`, and in base units of the fee token for `fee`.
 * - `sponsorship.rate_limited` gives the time the signing key can ask again.
 * - `sponsorship.simulation_failed` carries the revert data the simulation returned, which is `0x`
 *   when the transaction ran out of gas.
 * - `sponsorship.budget_spent` names the budget and the time enough of it frees up for the
 *   transaction at the latest. Gas held for a transaction that never lands frees up sooner.
 */
export type SponsorshipRefusal =
  | { reason: 'sponsorship.over_cap'; cap: SponsorshipCap; limit: bigint }
  | { reason: 'sponsorship.rate_limited'; retryAt: bigint }
  | { reason: 'sponsorship.simulation_failed'; revert: Hex }
  | { reason: 'sponsorship.budget_spent'; budget: SponsorshipBudget; retryAt: bigint }

const sponsorshipRefusalJson = z.discriminatedUnion('reason', [
  z.object({
    reason: z.literal('sponsorship.over_cap'),
    cap: z.enum(SPONSORSHIP_CAPS),
    limit: u64,
  }),
  z.object({ reason: z.literal('sponsorship.rate_limited'), retryAt: u64 }),
  z.object({ reason: z.literal('sponsorship.simulation_failed'), revert: hexBytes }),
  z.object({
    reason: z.literal('sponsorship.budget_spent'),
    budget: z.enum(SPONSORSHIP_BUDGETS),
    retryAt: u64,
  }),
])

const reasonCode = z.enum(Object.keys(REASON_CODES) as [ReasonCode, ...ReasonCode[]])
const decisionId = z.string().min(1).max(128)
const objectJson = z.record(z.string(), z.unknown())

/**
 * Parses a reserve approval request. Its agreement and any human approval have to be for this chain
 * and for the lock the request was signed under.
 */
export function parseReserveApprovalRequest(
  json: unknown,
  expected: { chainId: number; lock: Address },
): Parsed<ReserveApprovalRequest> {
  const outer = z
    .strictObject({
      request: objectJson,
      salt: bytes32,
      agreement: objectJson,
      fundedBy: z.enum(['agent', 'administrator']),
      humanApproval: objectJson.optional(),
    })
    .safeParse(json)
  if (!outer.success) return { ok: false, reason: 'message.invalid' }
  const request = reserveRequestJson.safeParse(outer.data.request)
  if (!request.success) return { ok: false, reason: 'message.invalid' }
  const agreement = parseSignedAgreement(outer.data.agreement, expected)
  if (!agreement.ok) return agreement
  let humanApproval: Signed<HumanApproval> | undefined
  if (outer.data.humanApproval !== undefined) {
    const parsed = parseSigned(
      outer.data.humanApproval,
      'HumanApproval',
      humanApprovalJson,
      expected,
    )
    if (!parsed.ok) return parsed
    humanApproval = parsed.value
  }
  return {
    ok: true,
    value: {
      request: request.data,
      salt: outer.data.salt,
      agreement: agreement.value,
      fundedBy: outer.data.fundedBy,
      ...(humanApproval ? { humanApproval } : {}),
    },
  }
}

/** Parses Avow's answer to a reserve request. An approval has to be for this chain and lock. */
export function parseReserveApproval(
  json: unknown,
  expected: { chainId: number; lock: Address },
): Parsed<ReserveApproval> {
  const refused = z
    .strictObject({ ok: z.literal(false), decisionId, reason: reasonCode })
    .safeParse(json)
  if (refused.success) return { ok: true, value: refused.data }
  const approved = z
    .strictObject({ ok: z.literal(true), decisionId, approval: objectJson })
    .safeParse(json)
  if (!approved.success) return { ok: false, reason: 'message.invalid' }
  const approval = parseSigned(approved.data.approval, 'Approval', approvalJson, expected)
  if (!approval.ok) return approval
  return {
    ok: true,
    value: { ok: true, decisionId: approved.data.decisionId, approval: approval.value },
  }
}

/** Parses an enrollment. The mandate has to be for this chain and the lock the request was signed under. */
export function parseEnrollmentRequest(
  json: unknown,
  expected: { chainId: number; lock: Address },
): Parsed<EnrollmentRequest> {
  const outer = z.strictObject({ mandate: objectJson, keyAuthorizedIn: bytes32 }).safeParse(json)
  if (!outer.success) return { ok: false, reason: 'message.invalid' }
  const mandate = parseSigned(outer.data.mandate, 'Mandate', mandateJson, expected)
  if (!mandate.ok) return mandate
  return {
    ok: true,
    value: { mandate: mandate.value, keyAuthorizedIn: outer.data.keyAuthorizedIn },
  }
}

export function parseEnrollment(json: unknown): Parsed<Enrollment> {
  const parsed = z
    .strictObject({
      businessId: z.string().min(1),
      agentId: z.string().min(1),
      agentKey: z
        .string()
        .regex(/^0x[0-9a-fA-F]{40}$/)
        .transform((s) => s.toLowerCase() as Address),
      mandateHash: bytes32,
    })
    .safeParse(json)
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, reason: 'message.invalid' }
}

const transactionJson = z.strictObject({ transaction: hexBytes.refine((s) => s.length >= 4) })

export function parseSponsorshipRequest(json: unknown): Parsed<SponsorshipRequest> {
  const parsed = transactionJson.safeParse(json)
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, reason: 'message.invalid' }
}

export function parseSponsorship(json: unknown): Parsed<Sponsorship> {
  return parseSponsorshipRequest(json)
}

/** Parses Avow's answer to a supplier's request. An authorization has to be for this chain and lock. */
export function parseSupplierAuthorizationAnswer(
  json: unknown,
  expected: { chainId: number; lock: Address },
): Parsed<SupplierAuthorizationAnswer> {
  const refused = z.strictObject({ ok: z.literal(false), reason: reasonCode }).safeParse(json)
  if (refused.success) return { ok: true, value: refused.data }
  const issued = z
    .strictObject({
      ok: z.literal(true),
      authorization: objectJson,
      approval: objectJson,
      mandate: objectJson,
    })
    .safeParse(json)
  if (!issued.success) return { ok: false, reason: 'message.invalid' }
  const authorization = parseSigned(
    issued.data.authorization,
    'SupplierAuthorization',
    supplierAuthorizationJson,
    expected,
  )
  if (!authorization.ok) return authorization
  const approval = parseSigned(issued.data.approval, 'Approval', approvalJson, expected)
  if (!approval.ok) return approval
  const mandate = parseSigned(issued.data.mandate, 'Mandate', mandateJson, expected)
  if (!mandate.ok) return mandate
  return {
    ok: true,
    value: {
      ok: true,
      authorization: authorization.value,
      approval: approval.value,
      mandate: mandate.value,
    },
  }
}

/**
 * Parses a Timestamp Avow signed, which has to be for this chain and lock and name `requestHash`
 * and `receivedAt`.
 */
function parseTimestamp(
  json: unknown,
  expected: { chainId: number; lock: Address },
  names: { requestHash: Hex; receivedAt: bigint },
): Parsed<Signed<Timestamp>> {
  const parsed = parseSigned(json, 'Timestamp', timestampJson, expected)
  if (!parsed.ok) return parsed
  const t = parsed.value.message
  if (t.requestHash !== names.requestHash.toLowerCase() || t.receivedAt !== names.receivedAt) {
    return { ok: false, reason: 'message.invalid' }
  }
  return parsed
}

const cancelledByJson = z.strictObject({
  signer: address,
  requestId: bytes32,
  expiry: u64,
  bodyHash: bytes32,
})

/**
 * Parses Avow's answer to a cancellation. Its timestamp has to be for this chain and lock and give
 * the same time as the answer. Without `cancelledBy`, the timestamp has to name `requestHash`, the
 * digest of the request the caller signed. With it, an earlier request cancelled the commitment,
 * and the timestamp has to name that request's digest, rebuilt from the caller's `audience`,
 * `POST`, the commitment's cancellations path and what `cancelledBy` carries. Either way the
 * timestamp names a request to cancel this commitment on this deployment, chain and lock.
 */
export function parseCancellationAnswer(
  json: unknown,
  expected: {
    chainId: number
    lock: Address
    audience: string
    commitmentId: Hex
    requestHash: Hex
  },
): Parsed<CancellationAnswer> {
  const outer = z
    .strictObject({
      cancelledAt: u64,
      timestamp: objectJson,
      cancelledBy: cancelledByJson.optional(),
    })
    .safeParse(json)
  if (!outer.success) return { ok: false, reason: 'message.invalid' }
  const { cancelledAt, cancelledBy } = outer.data
  const requestHash = cancelledBy
    ? digestOf(
        apiRequestTypedData(
          {
            audience: expected.audience,
            method: 'POST',
            path: API_PATHS.cancellations(expected.commitmentId),
            ...cancelledBy,
          },
          { chainId: expected.chainId, verifyingContract: expected.lock },
        ),
      )
    : expected.requestHash
  const timestamp = parseTimestamp(outer.data.timestamp, expected, {
    requestHash,
    receivedAt: cancelledAt,
  })
  if (!timestamp.ok) return timestamp
  return {
    ok: true,
    value: { cancelledAt, timestamp: timestamp.value, ...(cancelledBy ? { cancelledBy } : {}) },
  }
}

/**
 * Parses Avow's answer to a start request. Its hash has to be `requestHash`, the digest of the
 * request the caller signed, and its timestamp has to be for this chain and lock and name that
 * hash and the answer's time.
 */
export function parseStartRequestAnswer(
  json: unknown,
  expected: { chainId: number; lock: Address; requestHash: Hex },
): Parsed<StartRequestAnswer> {
  const outer = z
    .strictObject({ startRequestHash: bytes32, requestedAt: u64, timestamp: objectJson })
    .safeParse(json)
  if (!outer.success) return { ok: false, reason: 'message.invalid' }
  const { startRequestHash, requestedAt } = outer.data
  if (startRequestHash !== expected.requestHash.toLowerCase()) {
    return { ok: false, reason: 'message.invalid' }
  }
  const timestamp = parseTimestamp(outer.data.timestamp, expected, {
    requestHash: startRequestHash,
    receivedAt: requestedAt,
  })
  if (!timestamp.ok) return timestamp
  return { ok: true, value: { startRequestHash, requestedAt, timestamp: timestamp.value } }
}

/** Parses a start receipt the agent passes on. It has to be for this chain and lock. */
export function parseStartReceiptRequest(
  json: unknown,
  expected: { chainId: number; lock: Address },
): Parsed<StartReceiptRequest> {
  const outer = z.strictObject({ receipt: objectJson }).safeParse(json)
  if (!outer.success) return { ok: false, reason: 'message.invalid' }
  const receipt = parseSigned(outer.data.receipt, 'StartReceipt', startReceiptJson, expected)
  if (!receipt.ok) return receipt
  return { ok: true, value: { receipt: receipt.value } }
}

/** Parses Avow's answer to a start receipt. */
export function parseStartReceiptAnswer(json: unknown): Parsed<StartReceiptAnswer> {
  const parsed = z
    .union([
      z.strictObject({ ok: z.literal(true) }),
      z.strictObject({ ok: z.literal(false), reason: reasonCode }),
    ])
    .safeParse(json)
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, reason: 'message.invalid' }
}

/**
 * Reads an error body, or returns null when the body isn't one. Other fields are ignored, and a
 * reason code this package doesn't know reads as null, so a newer API's refusals still read.
 */
export function parseApiError(
  json: unknown,
): { reason: ReasonCode | null; message: string } | null {
  const parsed = z
    .object({ error: z.object({ reason: z.string(), message: z.string() }) })
    .safeParse(json)
  if (!parsed.success) return null
  const { reason, message } = parsed.data.error
  return { reason: Object.hasOwn(REASON_CODES, reason) ? (reason as ReasonCode) : null, message }
}

/**
 * Reads what a refusal by Avow's relay adds to an error body, or returns null for any other body,
 * including a relay refusal whose fields don't parse. Other fields are ignored.
 */
export function parseSponsorshipRefusal(json: unknown): SponsorshipRefusal | null {
  const outer = z.object({ error: z.unknown() }).safeParse(json)
  if (!outer.success) return null
  const parsed = sponsorshipRefusalJson.safeParse(outer.data.error)
  return parsed.success ? parsed.data : null
}
