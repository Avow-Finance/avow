import type { Address, Hex } from 'viem'
import { z } from 'zod'
import type {
  Approval,
  HumanApproval,
  Signed,
  SignedAgreement,
  SupplierAuthorization,
} from './eip712.js'
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
  supplierAuthorizationJson,
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
 * What the API answers when it refuses a request outright, with a status of 400 or more, as
 * `{ "error": { "reason": "<code>", "message": "<sentence>" } }`. Readers ignore any other field.
 */
export interface ApiError {
  error: { reason: ReasonCode; message: string }
}

const hex = z.string().regex(/^0x([0-9a-fA-F]{2})*$/)
const bytes32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((s) => s.toLowerCase() as Hex)
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

const transactionJson = z.strictObject({
  transaction: hex.min(4).transform((s) => s.toLowerCase() as Hex),
})

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
