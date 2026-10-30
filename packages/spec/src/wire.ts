import type { Address, Hex } from 'viem'
import { z } from 'zod'
import {
  COMMITMENT_STATES,
  type Commitment,
  commitmentFitsState,
  OUTCOME_ENDINGS,
  type Outcome,
  type OutcomeKind,
  type UncheckedCommitment,
} from './commitment.js'
import { DEPENDENCY_CHECKS, dependenciesJson } from './dependencies.js'
import {
  CHARGE_KINDS,
  type ChargeKind,
  checkEnvelope,
  type MessageType,
  type Signed,
  type SignedAgreement,
} from './eip712.js'
import { DEPENDENCIES_LABEL, type ElidedTerms } from './elided-terms.js'
import { GPU_RESERVATION } from './gpu-reservation.js'
import { address, bytes32, hexBytes, side, u64, u256 } from './json-fields.js'
import { RAIL_STATES } from './rail.js'
import type { ReasonCode } from './reasons.js'
import { type Attribution, commitmentReferenceJson, type Reference } from './references.js'
import {
  type AnyTerms,
  CHAINED_TERMS_SECTIONS,
  type ChainedTermsSection,
  isElidedSection,
  SECTIONED_TERMS_VERSIONS,
  type SectionDisclosure,
} from './terms.js'
import type { ComputeTermsV1 } from './terms-v1.js'
import type { ChainedTerms, Mandate, ReserveRequest, Terms } from './types.js'
import {
  AMOUNT_DECIMALS,
  CHAINED_TERMS_VERSION,
  CURRENCIES,
  MANDATE_ACTIONS,
  TEMPLATE_IDS,
  TERMS_VERSION,
} from './types.js'
import { COMMITMENT_RECORD_VERSION, isSupportedMessageVersion } from './version.js'

/** JSON forms of the records and signed messages, for the API, the SDK and the verifier. */

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

/**
 * Version 3 terms under the GPU reservation template, version 2's with the setting for who checks
 * the bookings relied on and the dependencies section.
 */
export const chainedGpuReservationTermsJson = z.strictObject({
  ...gpuReservationTermsJson.shape,
  version: z.literal(CHAINED_TERMS_VERSION),
  dependencyCheck: z.enum(DEPENDENCY_CHECKS),
  dependencies: dependenciesJson,
})

/** Version 3 terms under any template this code knows. */
export const chainedTermsJson = z.discriminatedUnion('template', [chainedGpuReservationTermsJson])

/**
 * The buyer's view of version 3 GPU reservation terms Avow checks. The header says Avow checks,
 * every section but dependencies is in clear with its own salt, and dependencies is exactly its
 * label and digest.
 */
export const elidedGpuReservationTermsJson = z.strictObject({
  ...gpuReservationTermsJson.shape,
  version: z.literal(CHAINED_TERMS_VERSION),
  dependencyCheck: z.literal('avow'),
  dependencies: z.strictObject({ label: z.literal(DEPENDENCIES_LABEL), digest: bytes32 }),
  salts: z.strictObject({
    subject: bytes32,
    consideration: bytes32,
    remedies: bytes32,
    resolution: bytes32,
    backing: bytes32,
  }),
})

/** The buyer's view of version 3 terms under any template this code knows. */
export const elidedTermsJson = z.discriminatedUnion('template', [elidedGpuReservationTermsJson])

/** Each template's subject, for reading a section shown on its own. */
const SUBJECTS: Record<string, z.ZodType> = { [GPU_RESERVATION]: gpuSubjectJson }

function sectionSchema(section: ChainedTermsSection, template: string): z.ZodType | undefined {
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
    case 'dependencies':
      return dependenciesJson
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

export const timestampJson = z.strictObject({
  requestHash: bytes32,
  receivedAt: u64,
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

type OutcomeKinds = [OutcomeKind, ...OutcomeKind[]]
const outcomeKinds = Object.keys(OUTCOME_ENDINGS) as OutcomeKinds
/** The kinds a version 1 or 2 record holds, which recorded a return at the release date as kept. */
const outcomeKindsBeforeV3 = outcomeKinds.filter(
  (k) => k !== 'reached_release_date',
) as OutcomeKinds

const outcomeJson = (kinds: OutcomeKinds) =>
  z.strictObject({ kind: z.enum(kinds), charged: u256, released: u256 }).nullable()

/**
 * The fields every version of a commitment record holds but its outcome. Their schemas read each
 * field on its own, and `parseCommitment` then checks that the contest and outcome fit the state.
 */
const recordFields = {
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
}

/** A version 1 record, written before records cited references and while all terms were version 1. */
export const commitmentJsonV1 = z.strictObject({
  ...recordFields,
  outcome: outcomeJson(outcomeKindsBeforeV3),
  terms: computeTermsV1Json,
})

const referencedRecordFields = {
  ...recordFields,
  // Version 1 terms carry no version field and version 2 terms do, so the two never overlap.
  terms: z.union([computeTermsV1Json, termsJson]),
  references: z.array(z.lazy(() => referenceJson)),
}

/** A version 2 record, written before a return at the release date had its own kind of outcome. */
export const commitmentJsonV2 = z.strictObject({
  ...referencedRecordFields,
  outcome: outcomeJson(outcomeKindsBeforeV3),
})

/** A version 3 record, the version this code writes. */
export const commitmentJson = z.strictObject({
  ...referencedRecordFields,
  outcome: outcomeJson(outcomeKinds),
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

/** A parse result: the value, or the reason code a reader refuses it with. */
export type Parsed<T> = { ok: true; value: T } | { ok: false; reason: ReasonCode }

const objectJson = z.record(z.string(), z.unknown())

/**
 * Parses terms of one version with that version's schema. It reads the version, the template and
 * the backing before the rest, so terms of another version, an unknown template or a backing a
 * lock can't enforce are refused as such rather than as malformed.
 */
function parseVersion<S extends z.ZodType>(
  json: unknown,
  version: number,
  schema: S,
): Parsed<z.output<S>> {
  const raw = objectJson.safeParse(json)
  if (!raw.success) return { ok: false, reason: 'terms.invalid' }
  if (raw.data.version !== version) return { ok: false, reason: 'terms.version_unknown' }
  if (!(TEMPLATE_IDS as readonly unknown[]).includes(raw.data.template)) {
    return { ok: false, reason: 'terms.template_unknown' }
  }
  const backing = objectJson.safeParse(raw.data.backing)
  if (backing.success && (backing.data.kind !== 'reserve' || backing.data.side !== 'buyer')) {
    return { ok: false, reason: 'terms.backing_unsupported' }
  }
  const parsed = schema.safeParse(json)
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, reason: 'terms.invalid' }
}

/**
 * Parses version 2 terms, the version a plain booking takes. It refuses every other version,
 * version 3 included, so a reader that takes only plain bookings never reads one that relies on
 * another booking.
 */
export function parseTerms(json: unknown): Parsed<Terms> {
  return parseVersion(json, TERMS_VERSION, termsJson)
}

/**
 * Parses version 3 terms, the version a booking takes when it relies on other bookings. It refuses
 * every other version, and terms carrying the dependencies section only as its digest are
 * `dependency.elided`, since these are the terms in full and `parseElidedTerms` reads the buyer's
 * view.
 */
export function parseChainedTerms(json: unknown): Parsed<ChainedTerms> {
  const raw = objectJson.safeParse(json)
  if (raw.data?.version === CHAINED_TERMS_VERSION && isElidedSection(raw.data.dependencies)) {
    return { ok: false, reason: 'dependency.elided' }
  }
  return parseVersion(json, CHAINED_TERMS_VERSION, chainedTermsJson)
}

/**
 * Parses the buyer's view of version 3 terms Avow checks, which `elideDependencies` makes. It
 * refuses a view whose header says the buyer checks, which would hide entries the buyer has to
 * read, a view that hides any other section, and a dependencies section that isn't exactly its
 * label and digest. `elidedTermsHash` gives the terms hash the view stands for.
 */
export function parseElidedTerms(json: unknown): Parsed<ElidedTerms> {
  return parseVersion(json, CHAINED_TERMS_VERSION, elidedTermsJson)
}

/**
 * Parses terms of any version a plain booking takes, for checking a commitment already made. Terms
 * with no version field are version 1 and parse under its frozen schema. Version 3 terms are
 * refused as a version this reads, and `parseChainedTerms` reads them.
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

/**
 * Parses one section shown on its own, checking the section's shape for its template. A section
 * of version 2 terms is one of its five, and of version 3 terms one of its six.
 */
export function parseSectionDisclosure(json: unknown): Parsed<SectionDisclosure> {
  const outer = z
    .strictObject({
      header: z.union([
        z.strictObject({ ...termsHeaderShape, template: z.string() }),
        z.strictObject({
          ...termsHeaderShape,
          version: z.literal(CHAINED_TERMS_VERSION),
          template: z.string(),
          dependencyCheck: z.enum(DEPENDENCY_CHECKS),
        }),
      ]),
      section: z.enum(CHAINED_TERMS_SECTIONS),
      content: z.unknown(),
      salt: bytes32,
      others: z.partialRecord(z.enum(CHAINED_TERMS_SECTIONS), bytes32),
    })
    .safeParse(json)
  if (!outer.success) {
    const version = objectJson.safeParse(objectJson.safeParse(json).data?.header)
    if (version.success && !SECTIONED_TERMS_VERSIONS.includes(version.data.version)) {
      return { ok: false, reason: 'terms.version_unknown' }
    }
    return { ok: false, reason: 'terms.invalid' }
  }
  const d = outer.data
  // Version 2 terms have no dependencies section to show or to hash.
  if (
    d.header.version === TERMS_VERSION &&
    (d.section === 'dependencies' || d.others.dependencies !== undefined)
  ) {
    return { ok: false, reason: 'terms.invalid' }
  }
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

/**
 * Reads a commitment id from text, such as a command's argument, as 32 bytes of hex. It gives the
 * id in lower case, the form every message and record carries, or null for text that isn't one.
 */
export function readCommitmentId(text: string): Hex | null {
  const parsed = bytes32.safeParse(text)
  return parsed.success ? parsed.data : null
}

export function parseMandate(json: unknown): Mandate {
  return mandateJson.parse(json)
}

/** Parses a reserve request, whose terms have to be version 2. Throws on anything else. */
export function parseReserveRequest(json: unknown): ReserveRequest {
  return reserveRequestJson.parse(json)
}

/**
 * The version a record from before version 3 reads as. Both earlier versions recorded a return at
 * the release date as `kept`, as they did the supplier's consent, and an ended record doesn't say
 * which it was. So a record that ended as `kept` stays version 2, the last version whose `kept`
 * means either, and writing it back keeps that meaning. Any other record reads as version 3 with
 * its meaning unchanged, so a live one records its ending in version 3's kinds.
 */
const versionBeforeV3 = (outcome: Outcome | null) =>
  outcome?.kind === 'kept' ? '2' : COMMITMENT_RECORD_VERSION

/**
 * Parses a stored or sent commitment record. A version 1 or 2 record reads as version 3, citing
 * nothing when it's version 1, and one that ended as `kept` stays version 2. A record version this
 * code doesn't read is refused as unknown. A record whose contest or outcome
 * its state can't hold, such as a draft with an outcome or a release that charged something, is
 * refused as invalid.
 */
export function parseCommitment(json: unknown): Parsed<Commitment> {
  const header = versionHeader.safeParse(json)
  if (!header.success) return { ok: false, reason: 'message.invalid' }
  let record: UncheckedCommitment
  if (header.data.schemaVersion === '1') {
    const older = commitmentJsonV1.safeParse(json)
    if (!older.success) return { ok: false, reason: 'message.invalid' }
    const schemaVersion = versionBeforeV3(older.data.outcome)
    record = { ...older.data, schemaVersion, references: [] }
  } else if (header.data.schemaVersion === '2') {
    const older = commitmentJsonV2.safeParse(json)
    if (!older.success) return { ok: false, reason: 'message.invalid' }
    record = { ...older.data, schemaVersion: versionBeforeV3(older.data.outcome) }
  } else if (header.data.schemaVersion === COMMITMENT_RECORD_VERSION) {
    const parsed = commitmentJson.safeParse(json)
    if (!parsed.success) return { ok: false, reason: 'message.invalid' }
    record = parsed.data
  } else {
    return { ok: false, reason: 'message.schema_unknown' }
  }
  return commitmentFitsState(record)
    ? { ok: true, value: record }
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
 * rather than as malformed.
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

/**
 * Parses a terms agreement both sides signed, which carries two signatures in place of one, and
 * checks its envelope the way `parseSigned` does.
 */
export function parseSignedAgreement(
  json: unknown,
  expected: { chainId: number; lock?: Address },
): Parsed<SignedAgreement> {
  const version = versionHeader.safeParse(json)
  if (!version.success) return { ok: false, reason: 'message.invalid' }
  if (!isSupportedMessageVersion('TermsAgreement', version.data.schemaVersion)) {
    return { ok: false, reason: 'message.schema_unknown' }
  }
  const header = envelopeHeader.safeParse(json)
  if (!header.success) return { ok: false, reason: 'message.invalid' }
  const problem = checkEnvelope(
    { ...header.data, type: header.data.type as MessageType },
    { type: 'TermsAgreement', ...expected },
  )
  if (problem) return { ok: false, reason: problem }
  const full = z
    .strictObject({
      type: z.literal('TermsAgreement'),
      schemaVersion: z.string(),
      chainId: z.number().int().positive(),
      lock: address,
      message: termsAgreementJson,
      buyerSignature: hexBytes,
      supplierSignature: hexBytes,
    })
    .safeParse(json)
  if (!full.success) return { ok: false, reason: 'message.invalid' }
  return { ok: true, value: full.data }
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
