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
  DEPENDENCY_CHECKS,
  type DependencyCheck,
  dependenciesProblem,
  isChainedTerms,
} from './dependencies.js'
import {
  APPROVAL_TYPES,
  type Approval,
  CHARGE_KINDS,
  type Charge,
  type SupplierAuthorization,
} from './eip712.js'
import { validateGpuReservation } from './gpu-reservation.js'
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
  CHAINED_TERMS_VERSION,
  type ChainedTerms,
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

/**
 * Terms of any version a plain booking takes: version 2, and version 1 for commitments made under
 * it. Every check and mapping that takes these refuses version 3, which goes through its own.
 */
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

/** The six sections of version 3 terms, version 2's five and then `dependencies`, in hash order. */
export const CHAINED_TERMS_SECTIONS = [...TERMS_SECTIONS, 'dependencies'] as const
export type ChainedTermsSection = (typeof CHAINED_TERMS_SECTIONS)[number]

/** The label a version 2 terms hash starts from. No other Avow hash uses it. */
export const TERMS_LABEL = 'avow:terms:v2'

/** The label a version 3 terms hash starts from. No other Avow hash uses it. */
export const CHAINED_TERMS_LABEL = 'avow:terms:v3'

/**
 * The label of the version that brought in a section. Version 3 hashes version 2's five sections
 * exactly as version 2 does, and only `dependencies` starts from its own label.
 */
const introducedBy = (section: ChainedTermsSection) =>
  section === 'dependencies' ? CHAINED_TERMS_LABEL : TERMS_LABEL

/**
 * The label a section's hash starts from, such as `avow:terms:v2:remedies`, or
 * `avow:terms:v3:dependencies` for the section version 3 adds.
 */
export function sectionLabel(section: ChainedTermsSection): string {
  return `${introducedBy(section)}:${section}`
}

/**
 * The HKDF info that derives a section's salt, such as `avow:terms:v2:salt:remedies`, or
 * `avow:terms:v3:salt:dependencies` for the section version 3 adds.
 */
export function sectionSaltLabel(section: ChainedTermsSection): string {
  return `${introducedBy(section)}:salt:${section}`
}

/** The part of version 2 terms hashed in the clear. It says how to read the five sections. */
export interface TermsHeader {
  version: typeof TERMS_VERSION
  template: TemplateId
  currency: Currency
  amountDecimals: typeof AMOUNT_DECIMALS
}

/**
 * The part of version 3 terms hashed in the clear. It says how to read the six sections and who
 * checks the bookings the dependencies section names, so a buyer shown that section only as its
 * digest still reads the setting and checks it against the terms hash.
 */
export interface ChainedTermsHeader extends Omit<TermsHeader, 'version'> {
  version: typeof CHAINED_TERMS_VERSION
  dependencyCheck: DependencyCheck
}

/** Anything that carries a version 3 header's fields, such as the terms or the buyer's view. */
type ChainedHeaderFields = Pick<ChainedTerms, keyof ChainedTermsHeader>

export function termsHeader(t: Terms): TermsHeader
export function termsHeader(t: ChainedHeaderFields): ChainedTermsHeader
export function termsHeader(t: Terms | ChainedHeaderFields): TermsHeader | ChainedTermsHeader
export function termsHeader(t: Terms | ChainedHeaderFields): TermsHeader | ChainedTermsHeader {
  const header = { template: t.template, currency: t.currency, amountDecimals: t.amountDecimals }
  return t.version === CHAINED_TERMS_VERSION
    ? { version: t.version, ...header, dependencyCheck: t.dependencyCheck }
    : { version: t.version, ...header }
}

/** The names of the sections terms of this version hold, in hash order. */
function sectionNames(t: Terms | ChainedTerms): readonly ChainedTermsSection[] {
  return isChainedTerms(t) ? CHAINED_TERMS_SECTIONS : TERMS_SECTIONS
}

/** The five sections of version 2 terms by name, or version 3's six. */
export function termsSections(t: Terms): Record<TermsSection, unknown>
export function termsSections(t: ChainedTerms): Record<ChainedTermsSection, unknown>
export function termsSections(
  t: Terms | ChainedTerms,
): Partial<Record<ChainedTermsSection, unknown>>
export function termsSections(
  t: Terms | ChainedTerms,
): Partial<Record<ChainedTermsSection, unknown>> {
  const five = {
    subject: t.subject,
    consideration: t.consideration,
    remedies: t.remedies,
    resolution: t.resolution,
    backing: t.backing,
  }
  return isChainedTerms(t) ? { ...five, dependencies: t.dependencies } : five
}

/** The fields version 2 terms hold at the top level, the header's four and the five sections. */
const TERMS_FIELDS: readonly string[] = [
  'version',
  'template',
  'currency',
  'amountDecimals',
  ...TERMS_SECTIONS,
]

/**
 * The fields version 3 terms hold at the top level, version 2's, the header's setting for who
 * checks the bookings relied on, and the dependencies section.
 */
const CHAINED_TERMS_FIELDS: readonly string[] = [...TERMS_FIELDS, 'dependencyCheck', 'dependencies']

/** The top-level fields of each version this code hashes in sections. */
const FIELDS_BY_VERSION = new Map<unknown, readonly string[]>([
  [TERMS_VERSION, TERMS_FIELDS],
  [CHAINED_TERMS_VERSION, CHAINED_TERMS_FIELDS],
])

/** The versions that hash their terms in sections, so a section of them can be shown on its own. */
export const SECTIONED_TERMS_VERSIONS: readonly unknown[] = [...FIELDS_BY_VERSION.keys()]

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * A section given only as its hash, under its label, in place of its content. Version 3 terms the
 * buyer is shown when Avow checks the bookings relied on carry their dependencies section this way.
 */
export interface ElidedSection {
  /** The section's label, such as `avow:terms:v3:dependencies`. */
  label: string
  /** The section's hash, as `sectionHash` gives it. */
  digest: Hex
}

/**
 * Whether a value stands in for a section by its digest. A reader that needs the section in clear
 * refuses one with `dependency.elided`, and never reads it as a section with nothing in it.
 */
export function isElidedSection(value: unknown): value is ElidedSection {
  return isPlainObject(value) && 'digest' in value
}

/**
 * What keeps sectioned terms of one of these versions from being hashed, or null when nothing
 * does. Version 1 terms, which have no `version` key, pass when `withV1` says they may.
 */
function shapeProblem(
  terms: unknown,
  versions: readonly unknown[],
  withV1: boolean,
): ReasonCode | null {
  if (!isPlainObject(terms)) return 'terms.invalid'
  if (isTermsV1(terms)) return withV1 ? null : 'terms.version_unknown'
  const expected = versions.includes(terms.version) ? FIELDS_BY_VERSION.get(terms.version) : null
  if (!expected) return 'terms.version_unknown'
  const chained = terms.version === CHAINED_TERMS_VERSION
  // Before the fields are counted, so the buyer's whole view gets this reason too.
  if (chained && isElidedSection(terms.dependencies)) return 'dependency.elided'
  const fields = Object.keys(terms).filter((k) => terms[k] !== undefined)
  if (expected.some((f) => !fields.includes(f))) return 'terms.incomplete'
  if (fields.length !== expected.length) return 'terms.invalid'
  if (!TERMS_SECTIONS.every((section) => isPlainObject(terms[section]))) return 'terms.invalid'
  if (chained && !Array.isArray(terms.dependencies)) return 'terms.invalid'
  if (chained && !(DEPENDENCY_CHECKS as readonly unknown[]).includes(terms.dependencyCheck)) {
    return 'terms.invalid'
  }
  try {
    canonicalJson(terms)
  } catch {
    return 'terms.invalid'
  }
  return null
}

/**
 * What keeps terms from being hashed, or null when nothing does. Version 2 terms hold exactly
 * their version, the header's other three fields and the five sections, each section an object,
 * and every value has to be one canonical JSON can write. The terms hash covers only the header
 * and the sections, so a field beside them is refused rather than left out of the hash. A field
 * or section left out is `terms.incomplete`, another version is `terms.version_unknown` and
 * anything else is `terms.invalid`. Terms with no `version` key are version 1, and any other field
 * set to undefined counts as left out, as JSON leaves it out. Version 1 terms hash every field they
 * hold, so `validateTerms` checks them on its own.
 *
 * Version 3 terms are refused as a version this reads, as are their checks, since a booking that
 * relies on others is sound only once those bookings are read. `chainedTermsShapeProblem` reads
 * version 3 alone, for a path that also runs that check.
 */
export function termsShapeProblem(terms: unknown): ReasonCode | null {
  return shapeProblem(terms, [TERMS_VERSION], true)
}

/**
 * What keeps version 3 terms from being hashed, or null when nothing does. They hold version 2's
 * fields, a `dependencyCheck` of `buyer` or `avow`, and the dependencies section, which is a list.
 * Terms carrying that section only as its digest are `dependency.elided`, since these are the
 * terms in full, and every other version is `terms.version_unknown`.
 */
export function chainedTermsShapeProblem(terms: unknown): ReasonCode | null {
  return shapeProblem(terms, [CHAINED_TERMS_VERSION], false)
}

/** Throws on terms that can't be hashed, of version 1, 2 or 3. */
function assertShape(terms: unknown): void {
  const problem = shapeProblem(terms, SECTIONED_TERMS_VERSIONS, true)
  if (problem) throw new TypeError(`These terms can't be hashed (${problem})`)
}

function checkSalt(salt: Hex): void {
  if (!isHex(salt) || size(salt) !== 32) throw new TypeError('The salt must be 32 bytes')
  if (/^0x0{64}$/.test(salt)) throw new TypeError('The salt must be random, and all zeros is not')
}

/**
 * A section's salt. It's HKDF-SHA256 (RFC 5869) with the commitment's 32-byte salt as the input
 * keying material, no HKDF salt, the UTF-8 bytes of the section's salt label as the info, and 32
 * bytes of output. The label is `avow:terms:v2:salt:<section>`, or
 * `avow:terms:v3:salt:dependencies` for the section version 3 adds. Showing one section's salt
 * reveals no other section's salt and not the commitment's.
 */
export function sectionSalt(salt: Hex, section: ChainedTermsSection): Hex {
  checkSalt(salt)
  const info = stringToBytes(sectionSaltLabel(section))
  return bytesToHex(hkdf(sha256, hexToBytes(salt), undefined, info, 32))
}

/** An object with these string fields in lower case, and anything else as it is. */
function lowerFields(content: unknown, fields: readonly string[]): unknown {
  if (content === null || typeof content !== 'object' || Array.isArray(content)) return content
  const lowered: Record<string, unknown> = { ...content }
  for (const f of fields) {
    const value = lowered[f]
    if (typeof value === 'string') lowered[f] = value.toLowerCase()
  }
  return lowered
}

/**
 * A section as it's hashed. The arbiter's address is lower case, and so are each dependency's
 * lock, commitment id and terms hash, so letter case can't change the hash.
 */
function hashedForm(section: ChainedTermsSection, content: unknown): unknown {
  if (section === 'resolution') return lowerFields(content, ['arbiter'])
  if (section !== 'dependencies' || !Array.isArray(content)) return content
  return content.map((entry: unknown) => {
    if (entry === null || typeof entry !== 'object' || !('on' in entry)) return entry
    return { ...entry, on: lowerFields(entry.on, ['lock', 'commitmentId', 'termsHash']) }
  })
}

/**
 * A section's hash: keccak256 of the ABI encoding of the section's label, such as
 * `avow:terms:v2:<section>` or `avow:terms:v3:dependencies`, the section's own salt as bytes32,
 * and the section's canonical JSON as a string.
 */
export function sectionHash(section: ChainedTermsSection, content: unknown, ownSalt: Hex): Hex {
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

/**
 * The version 3 terms hash from the header and the section hashes: keccak256 of the ABI encoding
 * of the string `avow:terms:v3`, the header's canonical JSON as a string, and the hashes of
 * subject, consideration, remedies, resolution, backing and dependencies as six bytes32, in that
 * order.
 */
export function chainedTermsHashFromSections(
  header: ChainedTermsHeader,
  hashes: Record<ChainedTermsSection, Hex>,
): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'string' },
        { type: 'string' },
        ...CHAINED_TERMS_SECTIONS.map(() => ({ type: 'bytes32' }) as const),
      ],
      [CHAINED_TERMS_LABEL, canonicalJson(header), ...CHAINED_TERMS_SECTIONS.map((s) => hashes[s])],
    ),
  )
}

/** Each section's hash under the commitment's salt, five for version 2 terms and six for version 3. */
export function sectionHashes(t: Terms, salt: Hex): Record<TermsSection, Hex>
export function sectionHashes(t: ChainedTerms, salt: Hex): Record<ChainedTermsSection, Hex>
export function sectionHashes(
  t: Terms | ChainedTerms,
  salt: Hex,
): Partial<Record<ChainedTermsSection, Hex>>
export function sectionHashes(
  t: Terms | ChainedTerms,
  salt: Hex,
): Partial<Record<ChainedTermsSection, Hex>> {
  const sections = termsSections(t)
  const hashes: Partial<Record<ChainedTermsSection, Hex>> = {}
  for (const s of sectionNames(t)) hashes[s] = sectionHash(s, sections[s], sectionSalt(salt, s))
  return hashes
}

/**
 * The salted terms hash the lock stores and every signed message names. Version 2 and version 3
 * terms hash their header and sections as above. Version 1 terms keep the hash they were signed
 * under. Throws on version 1 or 2 terms `termsShapeProblem` refuses and on version 3 terms
 * `chainedTermsShapeProblem` refuses, so no field ever sits outside the hash.
 */
export function termsHash(terms: AnyTerms | ChainedTerms, salt: Hex): Hex {
  assertShape(terms)
  if (isTermsV1(terms)) return termsHashV1(terms, salt)
  if (isChainedTerms(terms)) {
    return chainedTermsHashFromSections(termsHeader(terms), sectionHashes(terms, salt))
  }
  return termsHashFromSections(termsHeader(terms), sectionHashes(terms, salt))
}

/** One section shown on its own, with what proves it belongs to a terms hash. */
export interface SectionDisclosure {
  header: TermsHeader | ChainedTermsHeader
  /** One of the five sections of version 2 terms, or one of the six of version 3. */
  section: ChainedTermsSection
  /** The section as the terms hold it. */
  content: unknown
  /** This section's own salt. The commitment's salt never leaves the parties. */
  salt: Hex
  /** The hashes of every other section the header's version holds. */
  others: Partial<Record<ChainedTermsSection, Hex>>
}

/**
 * Shows one section of the terms, with its own salt and the hashes of every other section, four
 * for version 2 terms and five for version 3.
 */
export function discloseSection(terms: Terms, salt: Hex, section: TermsSection): SectionDisclosure
export function discloseSection(
  terms: ChainedTerms,
  salt: Hex,
  section: ChainedTermsSection,
): SectionDisclosure
export function discloseSection(
  terms: Terms | ChainedTerms,
  salt: Hex,
  section: ChainedTermsSection,
): SectionDisclosure {
  assertShape(terms)
  if (isTermsV1(terms)) throw new TypeError('Version 1 terms have no sections to show')
  const names = sectionNames(terms)
  if (!names.includes(section)) throw new TypeError(`These terms have no ${section} section`)
  const hashes = sectionHashes(terms, salt)
  const others: Partial<Record<ChainedTermsSection, Hex>> = {}
  for (const s of names) {
    const hash = hashes[s]
    if (s !== section && hash !== undefined) others[s] = hash
  }
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
 * the section, its own salt and the hashes of the other sections its header's version holds.
 * `parseSectionDisclosure` checks the section's shape before a reader relies on what it says.
 */
export function checkSectionDisclosure(d: SectionDisclosure, expected: Hex): ReasonCode | null {
  const chained = d.header.version === CHAINED_TERMS_VERSION
  if (!chained && d.header.version !== TERMS_VERSION) return 'terms.version_unknown'
  if (!(TEMPLATE_IDS as readonly string[]).includes(d.header.template)) {
    return 'terms.template_unknown'
  }
  const names: readonly ChainedTermsSection[] = chained ? CHAINED_TERMS_SECTIONS : TERMS_SECTIONS
  if (!names.includes(d.section)) return 'terms.invalid'
  for (const s of names) {
    const present = d.others[s] !== undefined
    if (present === (s === d.section)) return 'terms.invalid'
  }
  const hashes = {
    ...d.others,
    [d.section]: sectionHash(d.section, d.content, d.salt),
  } as Record<ChainedTermsSection, Hex>
  const actual = chained
    ? chainedTermsHashFromSections(d.header as ChainedTermsHeader, hashes)
    : termsHashFromSections(d.header as TermsHeader, hashes)
  return actual.toLowerCase() === expected.toLowerCase() ? null : 'terms.hash_mismatch'
}

/** Each template's own rules, which run after the core's. */
const TEMPLATE_RULES: { readonly [T in TemplateId]: (t: Terms) => ReasonCode | null } = {
  'gpu-reservation/1': (t) => validateGpuReservation(t),
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
 * can't enforce, and a template it doesn't know. Version 3 terms are refused as a version this
 * reads, and `validateChainedTerms` checks them.
 */
export function validateTerms(terms: AnyTerms, profile: TermsProfile): ReasonCode | null {
  const shape = termsShapeProblem(terms)
  if (shape) return shape
  if (isTermsV1(terms)) return validateTermsV1(terms, profile)
  return sectionRulesProblem(terms, profile)
}

/**
 * Checks version 3 terms on their own and returns null when they're sound. They pass every check
 * the version 2 terms they make pass, and their dependencies section passes
 * `dependenciesProblem`. Whether each booking relied on stands is for a check that reads its lock,
 * so a caller that commits to these terms runs that check too.
 */
export function validateChainedTerms(
  terms: ChainedTerms,
  profile: TermsProfile,
): ReasonCode | null {
  const shape = chainedTermsShapeProblem(terms)
  if (shape) return shape
  return (
    sectionRulesProblem(plainTermsOf(terms), profile) ?? dependenciesProblem(terms.dependencies)
  )
}

/**
 * The version 2 terms that say what these version 3 terms say, without the bookings they rely on
 * or who checks them. They pass the same checks and make the lock enforce the same values, and
 * their terms hash differs, so they never stand for the version 3 terms in a signed message.
 */
export function plainTermsOf(terms: ChainedTerms): Terms {
  const { dependencies: _, dependencyCheck: __, ...plain } = terms
  return { ...plain, version: TERMS_VERSION }
}

/** The core's checks of version 2 terms, then their template's rules. */
function sectionRulesProblem(terms: Terms, profile: TermsProfile): ReasonCode | null {
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
 * has, with a no-show chargeable from the window's start plus the grace period. Version 3 terms map
 * as `plainTermsOf` gives them, since the lock enforces nothing in their dependencies section.
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
