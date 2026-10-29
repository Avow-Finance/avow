import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import {
  type Address,
  bytesToHex,
  encodeAbiParameters,
  type Hex,
  hexToBytes,
  isAddress,
  isHex,
  keccak256,
  size,
  stringToBytes,
  zeroAddress,
} from 'viem'
import { canonicalJson } from './canonical.js'
import {
  APPROVAL_TYPES,
  type Approval,
  CHARGE_KINDS,
  type Charge,
  type SupplierAuthorization,
} from './eip712.js'
import { type GpuReservationTerms, validateGpuReservation } from './gpu-reservation.js'
import type { TermsProfile } from './profiles.js'
import { toTokenUnits } from './rail.js'
import type { ReasonCode } from './reasons.js'
import {
  type ComputeTermsV1,
  isTermsV1,
  termsChargesV1,
  termsHashV1,
  validateTermsV1,
} from './terms-v1.js'
import {
  AMOUNT_DECIMALS,
  type Currency,
  type Mandate,
  type RemedyCharge,
  type Side,
  type SupplierProfile,
  TEMPLATE_IDS,
  TERMS_VERSION,
  type TemplateId,
  type Terms,
} from './types.js'

/** Terms of any version this code reads: version 2, and version 1 for commitments made under it. */
export type AnyTerms = Terms | ComputeTermsV1

/** The five sections of version 2 terms, in the order the terms hash takes their hashes. */
export const TERMS_SECTIONS = [
  'subject',
  'consideration',
  'remedies',
  'resolution',
  'backing',
] as const
export type TermsSection = (typeof TERMS_SECTIONS)[number]

/** The label a version 2 terms hash starts from. No other Avow hash uses it. */
export const TERMS_LABEL = 'avow:terms:v2'

/** The label a section's hash starts from, such as `avow:terms:v2:remedies`. */
export function sectionLabel(section: TermsSection): string {
  return `${TERMS_LABEL}:${section}`
}

/** The HKDF info that derives a section's salt, such as `avow:terms:v2:salt:remedies`. */
export function sectionSaltLabel(section: TermsSection): string {
  return `${TERMS_LABEL}:salt:${section}`
}

/** The part of version 2 terms hashed in the clear. It says how to read the five sections. */
export interface TermsHeader {
  version: typeof TERMS_VERSION
  template: TemplateId
  currency: Currency
  amountDecimals: typeof AMOUNT_DECIMALS
}

export function termsHeader(t: Terms): TermsHeader {
  return {
    version: t.version,
    template: t.template,
    currency: t.currency,
    amountDecimals: t.amountDecimals,
  }
}

/** The five sections of version 2 terms by name. */
export function termsSections(t: Terms): Record<TermsSection, unknown> {
  return {
    subject: t.subject,
    consideration: t.consideration,
    remedies: t.remedies,
    resolution: t.resolution,
    backing: t.backing,
  }
}

/** The fields version 2 terms hold at the top level, the header's four and the five sections. */
const TERMS_FIELDS: readonly string[] = [
  'version',
  'template',
  'currency',
  'amountDecimals',
  ...TERMS_SECTIONS,
]

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * What keeps terms from being hashed, or null when nothing does. Version 2 terms hold exactly
 * their version, the header's other three fields and the five sections, each section an object,
 * and every value has to be one canonical JSON can write. The terms hash covers only the header
 * and the sections, so a field beside them is refused rather than left out of the hash. A field
 * or section left out is `terms.incomplete`, another version is `terms.version_unknown` and
 * anything else is `terms.invalid`. Terms with no `version` key are version 1, and any other field
 * set to undefined counts as left out, as JSON leaves it out. Version 1 terms hash every field they
 * hold, so `validateTerms` checks them on its own.
 */
export function termsShapeProblem(terms: unknown): ReasonCode | null {
  if (!isPlainObject(terms)) return 'terms.invalid'
  if (isTermsV1(terms)) return null
  if (terms.version !== TERMS_VERSION) return 'terms.version_unknown'
  const fields = Object.keys(terms).filter((k) => terms[k] !== undefined)
  if (TERMS_FIELDS.some((f) => !fields.includes(f))) return 'terms.incomplete'
  if (fields.length !== TERMS_FIELDS.length) return 'terms.invalid'
  if (!TERMS_SECTIONS.every((section) => isPlainObject(terms[section]))) return 'terms.invalid'
  try {
    canonicalJson(terms)
  } catch {
    return 'terms.invalid'
  }
  return null
}

function assertShape(terms: unknown): void {
  const problem = termsShapeProblem(terms)
  if (problem) throw new TypeError(`These terms can't be hashed (${problem})`)
}

function checkSalt(salt: Hex): void {
  if (!isHex(salt) || size(salt) !== 32) throw new TypeError('The salt must be 32 bytes')
  if (/^0x0{64}$/.test(salt)) throw new TypeError('The salt must be random, and all zeros is not')
}

/**
 * A section's salt. It's HKDF-SHA256 (RFC 5869) with the commitment's 32-byte salt as the input
 * keying material, no HKDF salt, the UTF-8 bytes of `avow:terms:v2:salt:<section>` as the info,
 * and 32 bytes of output. Showing one section's salt reveals no other section's salt and not the
 * commitment's.
 */
export function sectionSalt(salt: Hex, section: TermsSection): Hex {
  checkSalt(salt)
  const info = stringToBytes(sectionSaltLabel(section))
  return bytesToHex(hkdf(sha256, hexToBytes(salt), undefined, info, 32))
}

/** A section as it's hashed. The arbiter's address is lower case, so letter case can't change it. */
function hashedForm(section: TermsSection, content: unknown): unknown {
  if (section !== 'resolution' || content === null || typeof content !== 'object') return content
  const arbiter = (content as { arbiter?: unknown }).arbiter
  return typeof arbiter === 'string' ? { ...content, arbiter: arbiter.toLowerCase() } : content
}

/**
 * A section's hash: keccak256 of the ABI encoding of the string `avow:terms:v2:<section>`, the
 * section's own salt as bytes32, and the section's canonical JSON as a string.
 */
export function sectionHash(section: TermsSection, content: unknown, ownSalt: Hex): Hex {
  if (!isHex(ownSalt) || size(ownSalt) !== 32)
    throw new TypeError('A section salt must be 32 bytes')
  return keccak256(
    encodeAbiParameters(
      [{ type: 'string' }, { type: 'bytes32' }, { type: 'string' }],
      [sectionLabel(section), ownSalt, canonicalJson(hashedForm(section, content))],
    ),
  )
}

/**
 * The terms hash from the header and the section hashes: keccak256 of the ABI encoding of the
 * string `avow:terms:v2`, the header's canonical JSON as a string, and the hashes of subject,
 * consideration, remedies, resolution and backing as five bytes32, in that order.
 */
export function termsHashFromSections(header: TermsHeader, hashes: Record<TermsSection, Hex>): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'string' },
        { type: 'string' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
      ],
      [
        TERMS_LABEL,
        canonicalJson(header),
        hashes.subject,
        hashes.consideration,
        hashes.remedies,
        hashes.resolution,
        hashes.backing,
      ],
    ),
  )
}

/** Each section's hash under the commitment's salt. */
export function sectionHashes(t: Terms, salt: Hex): Record<TermsSection, Hex> {
  const sections = termsSections(t)
  const hash = (s: TermsSection) => sectionHash(s, sections[s], sectionSalt(salt, s))
  return {
    subject: hash('subject'),
    consideration: hash('consideration'),
    remedies: hash('remedies'),
    resolution: hash('resolution'),
    backing: hash('backing'),
  }
}

/**
 * The salted terms hash the lock stores and every signed message names. Version 2 terms hash
 * their header and sections as above. Version 1 terms keep the hash they were signed under.
 * Throws on terms `termsShapeProblem` refuses, so no field ever sits outside the hash.
 */
export function termsHash(terms: AnyTerms, salt: Hex): Hex {
  assertShape(terms)
  if (isTermsV1(terms)) return termsHashV1(terms, salt)
  return termsHashFromSections(termsHeader(terms), sectionHashes(terms, salt))
}

/** One section shown on its own, with what proves it belongs to a terms hash. */
export interface SectionDisclosure {
  header: TermsHeader
  section: TermsSection
  /** The section as the terms hold it. */
  content: unknown
  /** This section's own salt. The commitment's salt never leaves the parties. */
  salt: Hex
  /** The hashes of the four sections not shown. */
  others: Partial<Record<TermsSection, Hex>>
}

/** Shows one section of the terms, with its own salt and the other four sections' hashes. */
export function discloseSection(terms: Terms, salt: Hex, section: TermsSection): SectionDisclosure {
  assertShape(terms)
  if (isTermsV1(terms)) throw new TypeError('Version 1 terms have no sections to show')
  const hashes = sectionHashes(terms, salt)
  const others: Partial<Record<TermsSection, Hex>> = {}
  for (const s of TERMS_SECTIONS) if (s !== section) others[s] = hashes[s]
  return {
    header: termsHeader(terms),
    section,
    content: termsSections(terms)[section],
    salt: sectionSalt(salt, section),
    others,
  }
}

/**
 * Checks a shown section against the terms hash a lock or a signed message holds. It needs only
 * the section, its own salt and the other four hashes. `parseSectionDisclosure` checks the
 * section's shape before a reader relies on what it says.
 */
export function checkSectionDisclosure(d: SectionDisclosure, expected: Hex): ReasonCode | null {
  if (d.header.version !== TERMS_VERSION) return 'terms.version_unknown'
  if (!(TEMPLATE_IDS as readonly string[]).includes(d.header.template)) {
    return 'terms.template_unknown'
  }
  if (!(TERMS_SECTIONS as readonly string[]).includes(d.section)) return 'terms.invalid'
  for (const s of TERMS_SECTIONS) {
    const present = d.others[s] !== undefined
    if (present === (s === d.section)) return 'terms.invalid'
  }
  const hashes = {
    ...d.others,
    [d.section]: sectionHash(d.section, d.content, d.salt),
  } as Record<TermsSection, Hex>
  const actual = termsHashFromSections(d.header, hashes)
  return actual.toLowerCase() === expected.toLowerCase() ? null : 'terms.hash_mismatch'
}

/** Each template's own rules, which run after the core's. */
const TEMPLATE_RULES: { readonly [T in TemplateId]: (t: Terms) => ReasonCode | null } = {
  'gpu-reservation/1': (t) => validateGpuReservation(t as GpuReservationTerms),
}

/** Charges come in the order of the lock's codes, at most one of each kind, each with an amount. */
function checkCharges(charges: readonly RemedyCharge[]): ReasonCode | null {
  if (charges.length === 0 || charges.length > 4) return 'terms.charges_invalid'
  let last = -1
  for (const c of charges) {
    // Only the table's own kinds count, never a name every object inherits such as `constructor`.
    if (!Object.hasOwn(CHARGE_KINDS, c.kind)) return 'terms.charges_invalid'
    const code = CHARGE_KINDS[c.kind]
    if (code <= last || c.amount <= 0n) return 'terms.charges_invalid'
    last = code
  }
  return null
}

/**
 * Checks terms on their own, before any mandate, and returns null when they're sound. Version 1
 * terms keep the checks they were made under. Version 2 terms pass the core's checks of what a
 * lock enforces, then their template's rules. The core refuses a backing, side or charge a lock
 * can't enforce, and a template it doesn't know.
 */
export function validateTerms(terms: AnyTerms, profile: TermsProfile): ReasonCode | null {
  const shape = termsShapeProblem(terms)
  if (shape) return shape
  if (isTermsV1(terms)) return validateTermsV1(terms, profile)
  if (!Object.hasOwn(TEMPLATE_RULES, terms.template)) return 'terms.template_unknown'
  const rules = TEMPLATE_RULES[terms.template]
  if (terms.amountDecimals !== AMOUNT_DECIMALS) return 'terms.invalid'
  const { remedies: r, resolution: res, backing: b } = terms
  if ((b.kind as string) !== 'reserve' || (b.side as string) !== 'buyer') {
    return 'terms.backing_unsupported'
  }
  const chargesProblem = checkCharges(r.charges)
  if (chargesProblem) return chargesProblem
  const largest = r.charges.reduce((most, c) => (c.amount > most ? c.amount : most), 0n)
  if (b.amount !== largest) return 'terms.reserve_mismatch'
  // Every charge needs a moment it can be reported in, before the deadline and the reserve's
  // release.
  const inOrder =
    r.acceptBy < r.chargeDeadline &&
    r.freeCancelBy < r.chargeDeadline &&
    r.charges.every((c) => c.earliest < r.chargeDeadline) &&
    r.chargeDeadline <= b.releaseDate
  if (!inOrder) return 'terms.deadlines_out_of_order'
  if (res.contestWindow < profile.minContestWindow) return 'terms.contest_window_short'
  const share = res.day90SupplierShareBps
  if (
    typeof res.arbiter !== 'string' ||
    !isAddress(res.arbiter, { strict: false }) ||
    res.arbiter.toLowerCase() === zeroAddress ||
    !Number.isInteger(share) ||
    share < 0 ||
    share > 10_000
  ) {
    return 'terms.dispute_invalid'
  }
  return rules(terms)
}

/**
 * What a lock enforces for a commitment under these terms, in micros of the terms' currency and
 * unix seconds. Avow's approval carries exactly these values, so the API builds it from this and
 * a verifier checks it against this. Each version's mapping is fixed. Version 2 takes the reserve
 * and release date from the backing, the deadlines and charges from the remedies, and the contest
 * window, arbiter and day-90 share from the resolution. Version 1 maps its flat fields as it always
 * has, with a no-show chargeable from the window's start plus the grace period.
 */
export interface EnforceableTerms {
  currency: Currency
  /** The side the reserve backs. Version 1 terms back the buyer. */
  side: Side
  reserve: bigint
  acceptBy: bigint
  freeCancelBy: bigint
  chargeDeadline: bigint
  releaseDate: bigint
  contestWindow: bigint
  charges: readonly RemedyCharge[]
  arbiter: Address
  day90SupplierShareBps: number
}

export function enforceableTerms(terms: AnyTerms): EnforceableTerms {
  if (isTermsV1(terms)) {
    const charges: RemedyCharge[] = []
    if (terms.lateCancellation > 0n) {
      charges.push({
        kind: 'lateCancellation',
        amount: terms.lateCancellation,
        earliest: terms.freeCancelBy,
      })
    }
    if (terms.noShow > 0n) {
      charges.push({
        kind: 'noShow',
        amount: terms.noShow,
        earliest: terms.windowStart + terms.gracePeriod,
      })
    }
    return {
      currency: terms.currency,
      side: 'buyer',
      reserve: terms.reserve,
      acceptBy: terms.acceptBy,
      freeCancelBy: terms.freeCancelBy,
      chargeDeadline: terms.chargeDeadline,
      releaseDate: terms.releaseDate,
      contestWindow: terms.contestWindow,
      charges,
      arbiter: terms.dispute.arbiter,
      day90SupplierShareBps: terms.dispute.day90SupplierShareBps,
    }
  }
  return {
    currency: terms.currency,
    side: terms.backing.side,
    reserve: terms.backing.amount,
    acceptBy: terms.remedies.acceptBy,
    freeCancelBy: terms.remedies.freeCancelBy,
    chargeDeadline: terms.remedies.chargeDeadline,
    releaseDate: terms.backing.releaseDate,
    contestWindow: terms.resolution.contestWindow,
    charges: terms.remedies.charges.map((c) => ({ ...c })),
    arbiter: terms.resolution.arbiter,
    day90SupplierShareBps: terms.resolution.day90SupplierShareBps,
  }
}

/** The fields of Avow's approval that come from the terms, with amounts in the token's base units. */
export interface LockTerms {
  side: Side
  amount: bigint
  freeCancelBy: bigint
  acceptBy: bigint
  chargeDeadline: bigint
  releaseDate: bigint
  contestWindow: bigint
  charges: Charge[]
  day90SupplierShareBps: number
  arbiter: Address
}

/**
 * The enforceable fields in a token's base units, as Avow's approval carries them and the lock
 * stores them. Throws when an amount can't be paid exactly in a token with these decimals.
 */
export function lockTerms(terms: AnyTerms, decimals: number): LockTerms {
  const e = enforceableTerms(terms)
  const units = (micros: bigint) => toTokenUnits(micros, decimals)
  return {
    side: e.side,
    amount: units(e.reserve),
    freeCancelBy: e.freeCancelBy,
    acceptBy: e.acceptBy,
    chargeDeadline: e.chargeDeadline,
    releaseDate: e.releaseDate,
    contestWindow: e.contestWindow,
    charges: isTermsV1(terms)
      ? termsChargesV1(terms, decimals)
      : e.charges.map((c) => ({ kind: c.kind, most: units(c.amount), earliest: c.earliest })),
    day90SupplierShareBps: e.day90SupplierShareBps,
    arbiter: e.arbiter,
  }
}

/**
 * The charges a commitment under these terms carries, as Avow's approval names them. Version 1
 * terms keep the function they were read with, which needs neither the dispute block nor a reserve
 * the token can hold.
 */
export function termsCharges(terms: AnyTerms, decimals: number): Charge[] {
  if (isTermsV1(terms)) return termsChargesV1(terms, decimals)
  return lockTerms(terms, decimals).charges
}

/**
 * Every field of `LockTerms`, the values a lock enforces for a commitment, in the order Avow's
 * approval carries them. The build fails when `LockTerms` gains a field this list leaves out, and
 * every comparison of lock-enforced values runs through `lockTermsDifferences`, so a new field is
 * compared everywhere at once.
 */
export const LOCK_TERMS_FIELDS = [
  'side',
  'amount',
  'freeCancelBy',
  'acceptBy',
  'chargeDeadline',
  'releaseDate',
  'contestWindow',
  'charges',
  'day90SupplierShareBps',
  'arbiter',
] as const
export type LockTermsField = (typeof LOCK_TERMS_FIELDS)[number]

// The list names every field of `LockTerms` and nothing else.
const _everyLockTermsField: [
  Exclude<keyof LockTerms, LockTermsField>,
  Exclude<LockTermsField, keyof LockTerms>,
] extends [never, never]
  ? true
  : { notListed: Exclude<keyof LockTerms, LockTermsField> } = true
void _everyLockTermsField

/**
 * The lock-enforced fields a lock's record of one side of a commitment holds: every field but
 * `side`. The lock files each record under its side, so a record names its side by where it's
 * read from rather than in a field.
 */
export const LOCK_RECORD_FIELDS = LOCK_TERMS_FIELDS.filter(
  (f): f is Exclude<LockTermsField, 'side'> => f !== 'side',
)
export type LockRecordField = (typeof LOCK_RECORD_FIELDS)[number]

/**
 * The lock-enforced fields Avow's supplier authorization carries: the reserve and three deadlines.
 * Its EIP-712 type fixes them, and the build fails when that type and this list disagree about
 * which lock-enforced fields it holds.
 */
export const AUTHORIZATION_TERMS_FIELDS = [
  'amount',
  'acceptBy',
  'chargeDeadline',
  'releaseDate',
] as const
export type AuthorizationTermsField = (typeof AUTHORIZATION_TERMS_FIELDS)[number]

const _authorizationTermsFields: [
  Exclude<Extract<keyof SupplierAuthorization, LockTermsField>, AuthorizationTermsField>,
  Exclude<AuthorizationTermsField, keyof SupplierAuthorization>,
] extends [never, never]
  ? true
  : { notListed: Extract<keyof SupplierAuthorization, LockTermsField> } = true
void _authorizationTermsFields

/** Lock-enforced values as a record, an approval or the terms hold them. */
export type LockTermsValues<F extends LockTermsField = LockTermsField> = {
  readonly [K in F]: K extends 'charges' ? readonly Charge[] : LockTerms[K]
}

/** Two addresses in any letter case. Anything that isn't an address is never equal. */
function sameAddress(a: string, b: string): boolean {
  return (
    isAddress(a, { strict: false }) &&
    isAddress(b, { strict: false }) &&
    a.toLowerCase() === b.toLowerCase()
  )
}

const CHARGE_FIELD_NAMES = APPROVAL_TYPES.Charge.map((f) => f.name)

/**
 * Whether two lists of charges are the same: the same kinds in the same order, each equal in
 * every field the signed `Charge` type holds.
 */
export function sameCharges(a: readonly Charge[], b: readonly Charge[]): boolean {
  return (
    a.length === b.length &&
    a.every((c, i) => {
      const d = b[i]
      return d !== undefined && CHARGE_FIELD_NAMES.every((name) => c[name] === d[name])
    })
  )
}

/** How each lock-enforced field compares. The build fails when a field has no entry. */
const FIELD_EQUALS: {
  readonly [K in LockTermsField]: (a: LockTermsValues[K], b: LockTermsValues[K]) => boolean
} = {
  side: (a, b) => a === b,
  amount: (a, b) => a === b,
  freeCancelBy: (a, b) => a === b,
  acceptBy: (a, b) => a === b,
  chargeDeadline: (a, b) => a === b,
  releaseDate: (a, b) => a === b,
  contestWindow: (a, b) => a === b,
  charges: sameCharges,
  day90SupplierShareBps: (a, b) => a === b,
  arbiter: sameAddress,
}

/**
 * The fields where `actual` differs from `expected`, among `fields` and in their order, or an empty
 * list when they agree. Amounts, times and the day-90 share compare exactly, the arbiter in any
 * letter case, and charges kind by kind in order. Every check of lock-enforced values uses this,
 * with `LOCK_TERMS_FIELDS`, `LOCK_RECORD_FIELDS` or `AUTHORIZATION_TERMS_FIELDS` as the fields.
 */
export function lockTermsDifferences<F extends LockTermsField>(
  actual: LockTermsValues<F>,
  expected: LockTermsValues<F>,
  fields: readonly F[],
): F[] {
  return fields.filter((f) => {
    const equals = FIELD_EQUALS[f] as (a: unknown, b: unknown) => boolean
    return !equals(actual[f], expected[f])
  })
}

/** Charges in the order of the lock's codes for their kinds. */
const inChargeCodeOrder = (charges: readonly Charge[]): Charge[] =>
  [...charges].sort((x, y) => CHARGE_KINDS[x.kind] - CHARGE_KINDS[y.kind])

/**
 * The fields where a lock's record of one side of a commitment differs from the values expected of
 * it, among `LOCK_RECORD_FIELDS`. The lock stores charges by kind, so their order means nothing to
 * it, and both sides' charges are put in the order of the lock's codes before they're compared.
 */
export function lockRecordDifferences(
  record: LockTermsValues<LockRecordField>,
  expected: LockTermsValues<LockRecordField>,
): LockRecordField[] {
  return lockTermsDifferences(
    { ...record, charges: inChargeCodeOrder(record.charges) },
    { ...expected, charges: inChargeCodeOrder(expected.charges) },
    LOCK_RECORD_FIELDS,
  )
}

/** The fields of Avow's approval that have to match the terms. */
export type ApprovalTermsFields = Pick<
  Approval,
  | 'side'
  | 'amount'
  | 'freeCancelBy'
  | 'acceptBy'
  | 'chargeDeadline'
  | 'releaseDate'
  | 'contestWindow'
  | 'charges'
  | 'day90SupplierShareBps'
  | 'arbiter'
  | 'termsHash'
>

/**
 * The reason `approvalTermsProblem` gives for each field. The fields come in the order of
 * `LOCK_TERMS_FIELDS`, so a difference in the side, the amount, a deadline or the contest window
 * outranks one in the charges, which outranks one in the dispute terms.
 */
const APPROVAL_FIELD_REASONS: { readonly [K in LockTermsField]: ReasonCode } = {
  side: 'approval.terms_mismatch',
  amount: 'approval.terms_mismatch',
  freeCancelBy: 'approval.terms_mismatch',
  acceptBy: 'approval.terms_mismatch',
  chargeDeadline: 'approval.terms_mismatch',
  releaseDate: 'approval.terms_mismatch',
  contestWindow: 'approval.terms_mismatch',
  charges: 'approval.charges_mismatch',
  day90SupplierShareBps: 'approval.dispute_mismatch',
  arbiter: 'approval.dispute_mismatch',
}

/**
 * Checks that an approval carries exactly what the signed terms map to, and the terms hash both
 * businesses signed. The API runs it before it signs an approval, and a supplier's verifier runs
 * it before it accepts one, so an approval can't make a lock enforce anything the terms don't say.
 * Returns the first difference, or null.
 */
export function approvalTermsProblem(
  approval: ApprovalTermsFields,
  expected: { lock: LockTerms; termsHash: Hex },
): ReasonCode | null {
  if (approval.termsHash.toLowerCase() !== expected.termsHash.toLowerCase()) {
    return 'approval.terms_mismatch'
  }
  const [first] = lockTermsDifferences(approval, expected.lock, LOCK_TERMS_FIELDS)
  return first ? APPROVAL_FIELD_REASONS[first] : null
}

/** The supplier's own account, signing key and payout address, which its approvals have to name. */
export type ApprovalParties = Pick<SupplierProfile, 'account' | 'signingKey' | 'payee'>

/**
 * Checks that an approval names the supplier's own account, which consents to releases, its
 * signing key, which accepts the reserve and reports charges, and its payout address. Returns
 * `approval.parties_mismatch` when any of them differs, or null.
 */
export function approvalPartiesProblem(
  approval: Pick<Approval, 'supplier' | 'supplierSigner' | 'payee'>,
  parties: ApprovalParties,
): ReasonCode | null {
  const named =
    sameAddress(approval.supplier, parties.account) &&
    sameAddress(approval.supplierSigner, parties.signingKey) &&
    sameAddress(approval.payee, parties.payee)
  return named ? null : 'approval.parties_mismatch'
}

/**
 * Checks that an approval names the token the buyer's lock holds reserves in. Returns
 * `approval.terms_mismatch` when it names another, or null.
 */
export function approvalTokenProblem(
  approval: Pick<Approval, 'token'>,
  token: Address,
): ReasonCode | null {
  return sameAddress(approval.token, token) ? null : 'approval.terms_mismatch'
}

/** A mandate's two caps as Avow's approval carries them. */
export type ApprovalCaps = Pick<Approval, 'capPerCommitment' | 'capOpenReserves'>

/**
 * A mandate's two caps in a token's base units, as Avow's approval carries them and the lock
 * enforces them. Throws when a cap can't be paid exactly in a token with these decimals.
 */
export function approvalCaps(
  mandate: Pick<Mandate, 'capPerCommitment' | 'capOpenReserves'>,
  decimals: number,
): ApprovalCaps {
  return {
    capPerCommitment: toTokenUnits(mandate.capPerCommitment, decimals),
    capOpenReserves: toTokenUnits(mandate.capOpenReserves, decimals),
  }
}

/** What an approval has to say about the buyer's mandate. */
export interface ApprovalMandate {
  /** The mandate's hash under the buyer's lock. */
  mandateHash: Hex
  /** The mandate's caps in the token's base units, from `approvalCaps`. */
  caps: ApprovalCaps
  /** The keys the caller lets the reserve come from. The zero address is the account's root key. */
  fundingKeys: readonly Address[]
}

/**
 * Checks that an approval names the buyer's mandate, that mandate's two caps and a funding key the
 * caller allows. The lock enforces the caps and checks the key that funds the reserve against the
 * one the approval names, so other values would let through a reserve the mandate doesn't allow.
 * Returns `approval.mandate_mismatch` when any of them differs, or null.
 */
export function approvalMandateProblem(
  approval: Pick<Approval, 'mandateHash' | 'capPerCommitment' | 'capOpenReserves' | 'fundingKey'>,
  expected: ApprovalMandate,
): ReasonCode | null {
  const named =
    approval.mandateHash.toLowerCase() === expected.mandateHash.toLowerCase() &&
    approval.capPerCommitment === expected.caps.capPerCommitment &&
    approval.capOpenReserves === expected.caps.capOpenReserves &&
    expected.fundingKeys.some((k) => sameAddress(approval.fundingKey, k))
  return named ? null : 'approval.mandate_mismatch'
}
