import type { Address, Hex } from 'viem'
import { z } from 'zod'
import { COMMITMENT_STATES, type Commitment, OUTCOME_ENDINGS } from './commitment.js'
import {
  CHARGE_KINDS,
  type ChargeKind,
  checkEnvelope,
  type MessageType,
  type Signed,
} from './eip712.js'
import { GPU_RESERVATION } from './gpu-reservation.js'
import { RAIL_STATES } from './rail.js'
import type { ReasonCode } from './reasons.js'
import type { Attribution, Reference } from './references.js'
import {
  type AnyTerms,
  type SectionDisclosure,
  TERMS_SECTIONS,
  type TermsSection,
} from './terms.js'
import type { ComputeTermsV1 } from './terms-v1.js'
import type { Mandate, ReserveRequest, Terms } from './types.js'
import {
  AMOUNT_DECIMALS,
  CURRENCIES,
  MANDATE_ACTIONS,
  TEMPLATE_IDS,
  TERMS_VERSION,
} from './types.js'
import { COMMITMENT_RECORD_VERSION, isSupportedMessageVersion } from './version.js'

/**
 * JSON forms of the records and signed messages, for the API, the SDK and the verifier. JSON has
 * no bigint, so amounts and times travel as decimal strings and parse into bigints here.
 */
const uint = (bits: number) =>
  z
    .string()
    .regex(/^(0|[1-9][0-9]*)$/, 'a whole number as a decimal string')
    .transform((s) => BigInt(s))
    .refine((v) => v < 2n ** BigInt(bits), `a whole number below 2^${bits}`)
/** Times, durations and expiries, which signed messages carry as uint64. */
const u64 = uint(64)
/** Amounts and nonces. */
const u256 = uint(256)
// Hex parses to lower case, so a relay that changes letter case can't make two equal values
// compare as different, and a mixed-case address with a bad checksum can't make a check throw.
const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((s) => s.toLowerCase() as Address)
const bytes32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((s) => s.toLowerCase() as Hex)
const hexBytes = z
  .string()
  .regex(/^0x([0-9a-fA-F]{2})*$/)
  .transform((s) => s.toLowerCase() as Hex)
const side = z.enum(['buyer', 'supplier'])

/** Version 1 terms, flat and with no version field. Frozen, so commitments made under it stay readable. */
export const computeTermsV1Json = z.strictObject({
  kind: z.literal('compute'),
  resource: z.strictObject({
    gpu: z.string().min(1),
    count: z.number().int().positive(),
    region: z.string().min(1),
    sku: z.string().min(1),
  }),
  currency: z.enum(CURRENCIES),
  windowStart: u64,
  windowDuration: u64,
  acceptBy: u64,
  price: z.strictObject({ perGpuHour: u256 }),
  reserve: u256,
  freeCancelBy: u64,
  lateCancellation: u256,
  noShow: u256,
  gracePeriod: u64,
  chargeDeadline: u64,
  contestWindow: u64,
  releaseDate: u64,
  dispute: z.strictObject({
    arbiter: address,
    day90SupplierShareBps: z.number().int().min(0).max(10_000),
  }),
})

const chargeKind = z.enum(Object.keys(CHARGE_KINDS) as [ChargeKind, ...ChargeKind[]])

/** What a GPU reservation promises, the subject of the `gpu-reservation/1` template. */
export const gpuSubjectJson = z.strictObject({
  resource: z.strictObject({
    gpu: z.string().min(1),
    count: z.number().int().positive(),
    region: z.string().min(1),
    sku: z.string().min(1),
  }),
  windowStart: u64,
  windowDuration: u64,
})

export const considerationJson = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('rate'), amount: u256, unit: z.string().min(1) }),
  z.strictObject({ kind: z.literal('fixed'), amount: u256 }),
])

export const remediesJson = z.strictObject({
  acceptBy: u64,
  freeCancelBy: u64,
  // A lock holds up to four kinds of charge.
  charges: z
    .array(z.strictObject({ kind: chargeKind, amount: u256, earliest: u64 }))
    .min(1)
    .max(4),
  chargeDeadline: u64,
})

export const resolutionJson = z.strictObject({
  contestWindow: u64,
  arbiter: address,
  day90SupplierShareBps: z.number().int().min(0).max(10_000),
})

export const backingJson = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('reserve'),
    side: z.literal('buyer'),
    amount: u256,
    releaseDate: u64,
  }),
])

const termsHeaderShape = {
  version: z.literal(TERMS_VERSION),
  currency: z.enum(CURRENCIES),
  amountDecimals: z.literal(AMOUNT_DECIMALS),
}

/** Version 2 terms under the GPU reservation template. */
export const gpuReservationTermsJson = z.strictObject({
  ...termsHeaderShape,
  template: z.literal(GPU_RESERVATION),
  subject: gpuSubjectJson,
  consideration: considerationJson,
  remedies: remediesJson,
  resolution: resolutionJson,
  backing: backingJson,
})

/** Version 2 terms under any template this code knows. */
export const termsJson = z.discriminatedUnion('template', [gpuReservationTermsJson])

/** Each template's subject, for reading a section shown on its own. */
const SUBJECTS: Record<string, z.ZodType> = { [GPU_RESERVATION]: gpuSubjectJson }

function sectionSchema(section: TermsSection, template: string): z.ZodType | undefined {
  switch (section) {
    case 'subject':
      return SUBJECTS[template]
    case 'consideration':
      return considerationJson
    case 'remedies':
      return remediesJson
    case 'resolution':
      return resolutionJson
    case 'backing':
      return backingJson
  }
}

const approvalRuleJson = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('never') }),
  z.strictObject({ kind: z.literal('always') }),
  z.strictObject({ kind: z.literal('above'), amount: u256 }),
])

export const mandateJson = z.strictObject({
  mandateId: bytes32,
  businessId: z.string().min(1),
  agentId: z.string().min(1),
  account: address,
  agentKey: address,
  actions: z.array(z.enum(MANDATE_ACTIONS)).min(1),
  currency: z.enum(CURRENCIES),
  capPerCommitment: u256,
  capOpenReserves: u256,
  suppliers: z.array(z.string().min(1)),
  categories: z.array(z.string().min(1)),
  paymentLimits: z.array(z.strictObject({ token: address, amount: u256, period: u64 })).min(1),
  approvalRule: approvalRuleJson,
  expiry: u64,
  nonce: u256,
})

export const reserveRequestJson = z.strictObject({
  commitmentId: bytes32,
  agentKey: address,
  supplier: z.string().min(1),
  payee: address,
  category: z.string().min(1),
  terms: termsJson,
})

export const termsAgreementJson = z.strictObject({
  commitmentId: bytes32,
  termsHash: bytes32,
  category: z.string().min(1),
  buyerBusinessId: z.string().min(1),
  supplierBusinessId: z.string().min(1),
  mandateHash: bytes32,
  nonce: u256,
  expiry: u64,
})

const chargeJson = z.strictObject({
  kind: z.enum(Object.keys(CHARGE_KINDS) as [ChargeKind, ...ChargeKind[]]),
  most: u256,
  earliest: u64,
})

/** Avow's approval, field for field as the lock checks it. */
export const approvalJson = z.strictObject({
  commitmentId: bytes32,
  side,
  token: address,
  amount: u256,
  supplier: address,
  supplierSigner: address,
  payee: address,
  freeCancelBy: u64,
  acceptBy: u64,
  chargeDeadline: u64,
  releaseDate: u64,
  contestWindow: u64,
  // The lock holds up to four kinds of charge, and this schema names two.
  charges: z.array(chargeJson).min(1).max(4),
  day90SupplierShareBps: z.number().int().min(0).max(10_000),
  arbiter: address,
  termsHash: bytes32,
  mandateHash: bytes32,
  capPerCommitment: u256,
  capOpenReserves: u256,
  fundingKey: address,
  nonce: u256,
  expiry: u64,
})

export const supplierAuthorizationJson = z.strictObject({
  commitmentId: bytes32,
  termsHash: bytes32,
  salt: bytes32,
  amount: u256,
  token: address,
  buyerBusinessId: z.string().min(1),
  kybReference: z.string().min(1),
  kybTestData: z.boolean(),
  agentKey: address,
  agentKeyAuthorizedIn: bytes32,
  mandateHash: bytes32,
  payee: address,
  acceptBy: u64,
  chargeDeadline: u64,
  releaseDate: u64,
  nonce: u256,
  expiry: u64,
})

export const humanApprovalJson = z.strictObject({
  mandateHash: bytes32,
  commitmentId: bytes32,
  termsHash: bytes32,
  supplier: z.string().min(1),
  payee: address,
  amount: u256,
  nonce: u256,
  expiry: u64,
})

export const startReceiptJson = z.strictObject({
  commitmentId: bytes32,
  side,
  startRequestHash: bytes32,
  startedAt: u64,
  nonce: u256,
  expiry: u64,
})

const backingRefJson = z.strictObject({
  rail: z.literal('tempo'),
  chainId: z.number().int().positive(),
  lock: address,
  commitmentId: bytes32,
  side,
  token: address,
  amount: u256,
  payee: address,
  acceptBy: u64,
  chargeDeadline: u64,
  contestWindow: u64,
  releaseDate: u64,
  termsHash: bytes32,
})

const outcomeKinds = Object.keys(OUTCOME_ENDINGS) as [
  keyof typeof OUTCOME_ENDINGS,
  ...(keyof typeof OUTCOME_ENDINGS)[],
]

export const commitmentJson = z.strictObject({
  schemaVersion: z.string().min(1),
  commitmentId: bytes32,
  category: z.string().min(1),
  buyer: z.strictObject({
    businessId: z.string().min(1),
    agentId: z.string().min(1),
    mandateId: bytes32,
  }),
  supplier: z.strictObject({
    businessId: z.string().min(1),
    agentId: z.string().min(1).nullable(),
  }),
  // Version 1 terms carry no version field and version 2 terms do, so the two never overlap.
  terms: z.union([computeTermsV1Json, termsJson]),
  termsHash: bytes32,
  state: z.enum(COMMITMENT_STATES),
  backing: z.array(
    z.strictObject({
      side,
      type: z.literal('cash'),
      provider: z.string().min(1),
      enforcement: z.enum(['reserve', 'agreement', 'partner']),
      ref: backingRefJson,
      status: z.enum(RAIL_STATES),
    }),
  ),
  start: z
    .strictObject({ requestHash: bytes32, requestedAt: u64, receipt: hexBytes.nullable() })
    .nullable(),
  contest: z
    .strictObject({
      reasonCode: z.string().min(1),
      statementHash: bytes32,
      evidenceHashes: z.array(bytes32),
      contestedAt: u64,
    })
    .nullable(),
  outcome: z.strictObject({ kind: z.enum(outcomeKinds), charged: u256, released: u256 }).nullable(),
  references: z.array(z.lazy(() => referenceJson)).default([]),
})

export const commitmentReferenceJson = z.strictObject({
  kind: z.literal('commitment'),
  chainId: z.number().int().positive(),
  lock: address,
  commitmentId: bytes32,
  side,
  termsHash: bytes32,
})

export const paymentReferenceJson = z.strictObject({
  kind: z.literal('payment'),
  chainId: z.number().int().positive(),
  transactionHash: bytes32,
  logIndex: z.number().int().nonnegative(),
  token: address,
  from: address,
  to: address,
  amount: u256,
  memo: bytes32,
})

export const referenceJson = z.discriminatedUnion('kind', [
  commitmentReferenceJson,
  paymentReferenceJson,
])

export const attributionJson = z.strictObject({
  payment: paymentReferenceJson,
  obligation: commitmentReferenceJson,
  use: z.enum(['evidence', 'value']),
})

type Parsed<T> = { ok: true; value: T } | { ok: false; reason: ReasonCode }

const objectJson = z.record(z.string(), z.unknown())

/**
 * Parses version 2 terms, the only version a new commitment takes. It reads the version, the
 * template and the backing before the rest, so terms of another version, an unknown template or a
 * backing a lock can't enforce are refused as such rather than as malformed.
 */
export function parseTerms(json: unknown): Parsed<Terms> {
  const raw = objectJson.safeParse(json)
  if (!raw.success) return { ok: false, reason: 'terms.invalid' }
  if (raw.data.version !== TERMS_VERSION) return { ok: false, reason: 'terms.version_unknown' }
  if (!(TEMPLATE_IDS as readonly unknown[]).includes(raw.data.template)) {
    return { ok: false, reason: 'terms.template_unknown' }
  }
  const backing = objectJson.safeParse(raw.data.backing)
  if (backing.success && (backing.data.kind !== 'reserve' || backing.data.side !== 'buyer')) {
    return { ok: false, reason: 'terms.backing_unsupported' }
  }
  const parsed = termsJson.safeParse(json)
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, reason: 'terms.invalid' }
}

/**
 * Parses terms of any version this code reads, for checking a commitment already made. Terms with
 * no version field are version 1 and parse under its frozen schema.
 */
export function parseAnyTerms(json: unknown): Parsed<AnyTerms> {
  const raw = objectJson.safeParse(json)
  if (!raw.success) return { ok: false, reason: 'terms.invalid' }
  if (!('version' in raw.data)) {
    const v1 = computeTermsV1Json.safeParse(json)
    return v1.success
      ? { ok: true, value: v1.data as ComputeTermsV1 }
      : { ok: false, reason: 'terms.invalid' }
  }
  return parseTerms(json)
}

/** Parses one section shown on its own, checking the section's shape for its template. */
export function parseSectionDisclosure(json: unknown): Parsed<SectionDisclosure> {
  const outer = z
    .strictObject({
      header: z.strictObject({ ...termsHeaderShape, template: z.string() }),
      section: z.enum(TERMS_SECTIONS),
      content: z.unknown(),
      salt: bytes32,
      others: z.partialRecord(z.enum(TERMS_SECTIONS), bytes32),
    })
    .safeParse(json)
  if (!outer.success) {
    const version = objectJson.safeParse(objectJson.safeParse(json).data?.header)
    if (version.success && version.data.version !== TERMS_VERSION) {
      return { ok: false, reason: 'terms.version_unknown' }
    }
    return { ok: false, reason: 'terms.invalid' }
  }
  const d = outer.data
  if (!(TEMPLATE_IDS as readonly string[]).includes(d.header.template)) {
    return { ok: false, reason: 'terms.template_unknown' }
  }
  const schema = sectionSchema(d.section, d.header.template)
  const content = schema?.safeParse(d.content)
  if (!content?.success) return { ok: false, reason: 'terms.invalid' }
  return {
    ok: true,
    value: {
      header: d.header as SectionDisclosure['header'],
      section: d.section,
      content: content.data,
      salt: d.salt,
      others: d.others,
    },
  }
}

export function parseReference(json: unknown): Parsed<Reference> {
  const parsed = referenceJson.safeParse(json)
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, reason: 'message.invalid' }
}

export function parseAttributions(json: unknown): Parsed<Attribution[]> {
  const parsed = z.array(attributionJson).safeParse(json)
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, reason: 'message.invalid' }
}

export function parseMandate(json: unknown): Mandate {
  return mandateJson.parse(json)
}

/** Parses a reserve request, whose terms have to be version 2. Throws on anything else. */
export function parseReserveRequest(json: unknown): ReserveRequest {
  return reserveRequestJson.parse(json)
}

/** Parses a stored or sent commitment, refusing a record version this code can't read. */
export function parseCommitment(json: unknown): Parsed<Commitment> {
  const header = versionHeader.safeParse(json)
  if (!header.success) return { ok: false, reason: 'message.invalid' }
  if (header.data.schemaVersion !== COMMITMENT_RECORD_VERSION) {
    return { ok: false, reason: 'message.schema_unknown' }
  }
  const parsed = commitmentJson.safeParse(json)
  return parsed.success
    ? { ok: true, value: parsed.data as Commitment }
    : { ok: false, reason: 'message.invalid' }
}

const versionHeader = z.object({ schemaVersion: z.string() })
const envelopeHeader = z.object({
  type: z.string(),
  schemaVersion: z.string(),
  chainId: z.number().int().positive(),
  lock: address,
})

/**
 * Parses a signed message and checks its envelope. The version is read before the message
 * itself, so a message of a version this code doesn't read for its type is refused as unknown
 * (acceptance test 5) rather than as malformed.
 */
export function parseSigned<S extends z.ZodType>(
  json: unknown,
  type: MessageType,
  message: S,
  expected: { chainId: number; lock?: Address },
): Parsed<Signed<z.output<S>>> {
  const version = versionHeader.safeParse(json)
  if (!version.success) return { ok: false, reason: 'message.invalid' }
  if (!isSupportedMessageVersion(type, version.data.schemaVersion)) {
    return { ok: false, reason: 'message.schema_unknown' }
  }
  const header = envelopeHeader.safeParse(json)
  if (!header.success) return { ok: false, reason: 'message.invalid' }
  const problem = checkEnvelope(
    { ...header.data, type: header.data.type as MessageType },
    { type, ...expected },
  )
  if (problem) return { ok: false, reason: problem }
  const full = z
    .strictObject({
      type: z.literal(type),
      schemaVersion: z.string(),
      chainId: z.number().int().positive(),
      lock: address,
      message,
      signature: hexBytes,
    })
    .safeParse(json)
  if (!full.success) return { ok: false, reason: 'message.invalid' }
  return { ok: true, value: full.data as Signed<z.output<S>> }
}

/** Turns bigints into decimal strings, so a record or message can go through JSON.stringify. */
export function toWire(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return value.map(toWire)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toWire(v)]))
  }
  return value
}
