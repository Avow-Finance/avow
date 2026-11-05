import type { Hex } from 'viem'
import { z } from 'zod'
import { type Dependencies, dependenciesJson } from './dependencies.js'
import { type ChainedJobTerms, JOB } from './job.js'
import { bytes32 } from './json-fields.js'
import type { ReasonCode } from './reasons.js'
import { decodeLinkToken, encodeLinkToken } from './reference-link.js'
import { type CommitmentReference, commitmentReferenceJson } from './references.js'
import {
  type ChainedTermsHeader,
  chainedTermsHashFromSections,
  sectionHash,
  sectionHashes,
  sectionSalt,
  TERMS_SECTIONS,
  type TermsSection,
  termsHash,
  termsHeader,
} from './terms.js'
import { AMOUNT_DECIMALS, CHAINED_TERMS_VERSION, CURRENCIES } from './types.js'
import { type Parsed, toWire } from './wire.js'

/**
 * What a link to verify a job carries, so a browser can see which booking the job relies on. A
 * commitment reference alone names only the job's terms hash. This adds the terms' header, the
 * dependencies section in clear with that section's own salt, and every other section's hash. The
 * browser recomputes the terms hash from these, matches it against the reference and the lock's,
 * and reads the booking the dependencies section names at a block it pins.
 *
 * Only the dependencies section is shown. Each section's salt comes from the terms' salt, and one
 * section's salt reveals neither the terms' salt nor any other section. So the job's subject, with
 * its work, compute and deadline, and its price stay behind their hashes. The lock already shows
 * anyone what it enforces for the job: the reserve, each charge's cap and the moment it becomes
 * chargeable, the deadlines, the contest window and the release date. Free cancellation ends when
 * work starts, so the lock shows the start too.
 */
export interface JobVerification {
  kind: 'job'
  /** The job commitment, on the buyer side of the customer's lock. */
  commitment: CommitmentReference
  header: ChainedTermsHeader & { template: typeof JOB; dependencyCheck: 'buyer' }
  dependencies: Dependencies
  /** The dependencies section's own salt. */
  dependenciesSalt: Hex
  /** The hash of each of the other five sections, under its own salt. */
  sectionHashes: Record<TermsSection, Hex>
}

/** The longest token `decodeJobVerification` reads, room for four bookings relied on. */
const MAX_TOKEN = 6144

export const jobVerificationJson = z.strictObject({
  kind: z.literal('job'),
  commitment: commitmentReferenceJson,
  header: z.strictObject({
    version: z.literal(CHAINED_TERMS_VERSION),
    template: z.literal(JOB),
    currency: z.enum(CURRENCIES),
    amountDecimals: z.literal(AMOUNT_DECIMALS),
    dependencyCheck: z.literal('buyer'),
  }),
  dependencies: dependenciesJson,
  dependenciesSalt: bytes32,
  sectionHashes: z.strictObject({
    subject: bytes32,
    consideration: bytes32,
    remedies: bytes32,
    resolution: bytes32,
    backing: bytes32,
  }),
})

/**
 * What a link to verify a job carries, from the job's terms in full and their salt. Throws when the
 * reference doesn't name these terms' hash, so a link never names one job's commitment with
 * another's terms.
 */
export function jobVerificationOf(
  terms: ChainedJobTerms,
  salt: Hex,
  commitment: CommitmentReference,
): JobVerification {
  if (termsHash(terms, salt).toLowerCase() !== commitment.termsHash.toLowerCase()) {
    throw new RangeError("The reference doesn't name these terms' hash")
  }
  const hashes = sectionHashes(terms, salt)
  return {
    kind: 'job',
    commitment: { ...commitment },
    header: termsHeader(terms) as JobVerification['header'],
    dependencies: terms.dependencies,
    dependenciesSalt: sectionSalt(salt, 'dependencies'),
    sectionHashes: Object.fromEntries(TERMS_SECTIONS.map((s) => [s, hashes[s]])) as Record<
      TermsSection,
      Hex
    >,
  }
}

/** The terms hash a job's link works out from what it carries. */
export function jobVerificationTermsHash(v: JobVerification): Hex {
  return chainedTermsHashFromSections(v.header, {
    ...v.sectionHashes,
    dependencies: sectionHash('dependencies', v.dependencies, v.dependenciesSalt),
  })
}

/**
 * Checks that what a job's link carries works out to the terms hash its reference names, and
 * returns `terms.hash_mismatch` when it doesn't, or null. The reference's terms hash still has to
 * match the one the lock holds for that commitment, which only a read of the lock shows.
 */
export function jobVerificationProblem(v: JobVerification): ReasonCode | null {
  return jobVerificationTermsHash(v).toLowerCase() === v.commitment.termsHash.toLowerCase()
    ? null
    : 'terms.hash_mismatch'
}

/** What a job's link carries as one URL-safe token, for a link such as `#verify=<token>`. */
export function encodeJobVerification(v: JobVerification): string {
  const parsed = jobVerificationJson.safeParse(toWire(v))
  if (!parsed.success) throw new RangeError("That isn't a job's verification")
  return encodeLinkToken(parsed.data)
}

/**
 * Reads what a job's link carries. A token from `encodeCommitmentReference` reads as invalid here,
 * and the `kind` of the JSON tells the two apart. It reads only the form, and
 * `jobVerificationProblem` checks the hashes.
 */
export function decodeJobVerification(token: string): Parsed<JobVerification> {
  const decoded = decodeLinkToken(token, MAX_TOKEN)
  if (!decoded) return { ok: false, reason: 'message.invalid' }
  const parsed = jobVerificationJson.safeParse(decoded.json)
  return parsed.success
    ? { ok: true, value: parsed.data as JobVerification }
    : { ok: false, reason: 'message.invalid' }
}
