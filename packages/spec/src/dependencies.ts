import type { Hex } from 'viem'
import { z } from 'zod'
import {
  GPU_RESERVATION,
  type GpuSubject,
  gpuSubjectFits,
  gpuSubjectProblem,
} from './gpu-reservation.js'
import { type JobSubject, jobFitsReservation, jobSubjectProblem } from './job.js'
import { bytes32, u64 } from './json-fields.js'
import type { ReasonCode } from './reasons.js'
import { type CommitmentReference, commitmentReferenceJson } from './references.js'
import {
  CHAINED_TERMS_VERSION,
  type ChainedTerms,
  type ChainedTermsOf,
  type TemplateId,
  type TermsOf,
} from './types.js'

/**
 * The `dependencies` section of version 3 terms. Each entry names one booking this one relies on,
 * the state that booking has to be in whenever it's checked, and the section of it the seller
 * shows whoever checks it. Nothing on the chain reads this section, and neither lock knows about
 * the other. The parties that rely on it check it at set moments by reading the lock that holds
 * the booking relied on.
 */

/**
 * Who checks the bookings a version 3 booking relies on for its buyer, one setting for the whole
 * dependencies section, held in the header. With `buyer`, the default, the buyer sees every entry
 * and the subject the seller shows, and reads each booking from the chain itself. With `avow`, the
 * buyer sees the dependencies section only as its label and digest and relies on Avow, whose API
 * is planned to check each booking before it approves and doesn't do so yet. The seller and Avow
 * see every entry in both.
 */
export const DEPENDENCY_CHECKS = ['buyer', 'avow'] as const
export type DependencyCheck = (typeof DEPENDENCY_CHECKS)[number]

/**
 * The states a booking relied on can be required to be in. `accepted` means its lock holds it as
 * accepted with no report filed.
 */
export const DEPENDENCY_CONDITIONS = ['accepted'] as const
export type DependencyCondition = (typeof DEPENDENCY_CONDITIONS)[number]

/**
 * The sections of a booking relied on that its seller can show whoever checks it. `subject` shows
 * the resource and the window, and no price.
 */
export const DEPENDENCY_DISCLOSURES = ['subject'] as const
export type DependencyDisclosure = (typeof DEPENDENCY_DISCLOSURES)[number]

/** The most bookings one booking can rely on, the longest list `Dependencies` allows. */
export const MAX_DEPENDENCIES: Dependencies['length'] = 4

/** A commitment reference to the buyer side of a lock, the only side a booking can rely on. */
export type BuyerSideReference = Omit<CommitmentReference, 'side'> & { side: 'buyer' }

/** One booking this one relies on. */
export interface Dependency {
  /**
   * The booking relied on, by chain, lock, commitment id, side and terms hash. It's on the buyer
   * side of the seller's own lock, and a check reads that lock to confirm it.
   */
  on: BuyerSideReference
  condition: DependencyCondition
  disclosed: DependencyDisclosure
}

/** One to four entries, each naming a different booking. */
export type Dependencies =
  | readonly [Dependency]
  | readonly [Dependency, Dependency]
  | readonly [Dependency, Dependency, Dependency]
  | readonly [Dependency, Dependency, Dependency, Dependency]

declare const dependenciesChecked: unique symbol

/**
 * Version 3 terms every booking of which passed a check that read its lock. Short of a deliberate
 * cast, only the verifier's `verifyDependencies` produces one, so code that takes these in place of
 * `ChainedTerms`, such as `checkMandate`, can't be handed unchecked terms by mistake. The brand
 * exists only in the types, and nothing checks it at run time.
 */
export type CheckedChainedTerms = ChainedTerms & { readonly [dependenciesChecked]: true }

/** Whether terms are version 3, the version that names the bookings it relies on. */
export function isChainedTerms(terms: unknown): terms is ChainedTerms {
  return (
    typeof terms === 'object' &&
    terms !== null &&
    'version' in terms &&
    terms.version === CHAINED_TERMS_VERSION
  )
}

/**
 * Version 3 terms that say what version 2 terms say and rely on the bookings given, which the
 * buyer checks unless the setting says Avow does.
 */
export function chainedTerms<Subject, Template extends TemplateId>(
  terms: TermsOf<Subject, Template>,
  dependencies: Dependencies,
  dependencyCheck: DependencyCheck = 'buyer',
): ChainedTermsOf<Subject, Template> {
  return { ...terms, version: CHAINED_TERMS_VERSION, dependencyCheck, dependencies }
}

/** One booking a version 3 booking relies on, as JSON. */
export const dependencyJson = z.strictObject({
  on: commitmentReferenceJson.extend({ side: z.literal('buyer') }),
  condition: z.enum(DEPENDENCY_CONDITIONS),
  disclosed: z.enum(DEPENDENCY_DISCLOSURES),
})

/** Where an entry's booking sits. The schema reads hex in lower case, so letter case can't change it. */
const placeOf = ({ on }: z.output<typeof dependencyJson>) =>
  `${on.chainId}:${on.lock}:${on.commitmentId}:${on.side}`

/**
 * The dependencies section as JSON, one to four entries, no two naming the same booking, whatever
 * terms hash each gives.
 */
export const dependenciesJson = z
  .union([
    z.tuple([dependencyJson]),
    z.tuple([dependencyJson, dependencyJson]),
    z.tuple([dependencyJson, dependencyJson, dependencyJson]),
    z.tuple([dependencyJson, dependencyJson, dependencyJson, dependencyJson]),
  ])
  .refine((entries) => new Set(entries.map(placeOf)).size === entries.length, {
    message: 'Two entries name the same booking',
  })

// The schema reads lists of exactly the lengths `Dependencies` allows, no more and no fewer.
type ParsedLength = z.output<typeof dependenciesJson>['length']
const _sameLengths: [ParsedLength, Dependencies['length']] extends [
  Dependencies['length'],
  ParsedLength,
]
  ? true
  : { lengths: ParsedLength } = true
void _sameLengths

/**
 * Checks the dependencies section on its own and returns null when it's sound, or `terms.invalid`.
 * It has the form `dependenciesJson` reads, one to four entries, each with exactly a buyer-side
 * commitment reference, a condition this version knows and a section it lets a seller show, and no
 * two entries name the same booking, whatever terms hash each gives.
 *
 * Two bookings can never rely on each other. An entry names a terms hash that already exists, and
 * this booking's terms hash covers the entry, so no booking it names can name it back.
 */
export function dependenciesProblem(dependencies: unknown): ReasonCode | null {
  return dependenciesJson.safeParse(dependencies).success ? null : 'terms.invalid'
}

/**
 * Each template's rules for a booking's subject, on its own and inside the subject of a booking it
 * relies on. A GPU reservation fits only inside a GPU reservation, and a job only inside the GPU
 * reservation of the compute it runs on. The build fails when a template has no rules here.
 */
const SUBJECT_RULES: {
  readonly [T in TemplateId]: {
    problem: (subject: unknown) => ReasonCode | null
    fits: (inner: unknown, outer: TemplatedSubject) => boolean
  }
} = {
  'gpu-reservation/1': {
    problem: (subject) => gpuSubjectProblem(subject as GpuSubject),
    fits: (inner, outer) =>
      outer.template === GPU_RESERVATION &&
      gpuSubjectFits(inner as GpuSubject, outer.subject as GpuSubject),
  },
  'job/1': {
    problem: (subject) => jobSubjectProblem(subject as JobSubject),
    fits: (inner, outer) =>
      outer.template === GPU_RESERVATION &&
      jobFitsReservation(inner as JobSubject, outer.subject as GpuSubject),
  },
}

/** A booking's subject with the template that reads it. */
export interface TemplatedSubject {
  template: string
  subject: unknown
}

const rulesOf = (template: string) =>
  Object.hasOwn(SUBJECT_RULES, template) ? SUBJECT_RULES[template as TemplateId] : null

/**
 * What's wrong with a booking's subject on its own, by its template's rules, or null when nothing
 * is. A template this code doesn't know is `terms.template_unknown`.
 */
export function subjectProblem(t: TemplatedSubject): ReasonCode | null {
  const rules = rulesOf(t.template)
  return rules ? rules.problem(t.subject) : 'terms.template_unknown'
}

/**
 * Whether a booking's subject fits inside the subject of a booking it relies on, by the rules of
 * the inner booking's template. A pair of templates those rules don't name never fits, a template
 * this code doesn't know never fits, and neither does a subject its template's rules refuse.
 */
export function subjectFits(inner: TemplatedSubject, outer: TemplatedSubject): boolean {
  return rulesOf(inner.template)?.fits(inner.subject, outer) ?? false
}

/** A block a check read at, by number, with the hash and timestamp it had then. */
export interface PinnedBlock {
  number: bigint
  hash: Hex
  /** The block's timestamp in seconds, which the lock's deadlines are held against. */
  timestamp: bigint
}

/** A pinned block's JSON form, with numbers as decimal strings and the hash in lower case. */
export const pinnedBlockJson = z.strictObject({ number: u64, hash: bytes32, timestamp: u64 })

/** A booking relied on that passed a check, with the block every read of it was pinned to. */
export interface CheckedDependency {
  on: CommitmentReference
  block: PinnedBlock
}

/** A booking relied on by its place in the terms, or null when no single one is meant. */
export const dependencyIndexJson = z
  .number()
  .int()
  .min(0)
  .max(MAX_DEPENDENCIES - 1)
  .nullable()

/** A checked booking's JSON form. */
export const checkedDependencyJson = z.strictObject({
  on: commitmentReferenceJson,
  block: pinnedBlockJson,
})
