import { type Hex, isHex, size } from 'viem'
import type { ReasonCode } from './reasons.js'
import {
  chainedTermsHashFromSections,
  chainedTermsShapeProblem,
  type ElidedSection,
  isElidedSection,
  sectionHash,
  sectionLabel,
  sectionSalt,
  TERMS_SECTIONS,
  type TermsSection,
  termsHeader,
} from './terms.js'
import type { ChainedTerms } from './types.js'

/**
 * Version 3 terms as the buyer is shown them when Avow checks the bookings they rely on. Every
 * section is in clear with its own salt, except dependencies, which travels as its digest under
 * its label. The buyer still works out the whole terms hash from this, so it can check that the
 * approval Avow signs names these exact terms, hidden section included. Only terms whose header
 * says Avow checks can be shown this way, since a buyer that checks the bookings itself needs every
 * entry, and a reader that needs the entries refuses this view with `dependency.elided`.
 */
export type ElidedTerms = Omit<ChainedTerms, 'dependencyCheck' | 'dependencies'> & {
  dependencyCheck: 'avow'
  /** The dependencies section's hash under `DEPENDENCIES_LABEL`. Its salt stays with the parties. */
  dependencies: ElidedSection
  /** The own salt of each section shown in clear. The commitment's salt never leaves the parties. */
  salts: Readonly<Record<TermsSection, Hex>>
}

/** The label an elided dependencies section carries, the one its hash starts from. */
export const DEPENDENCIES_LABEL = sectionLabel('dependencies')

const isBytes32 = (v: unknown): v is Hex => typeof v === 'string' && isHex(v) && size(v) === 32

const hasExactly = (v: object, keys: readonly string[]) =>
  Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k))

/**
 * What keeps a buyer's view from being hashed, or null when nothing does. The header says Avow
 * checks, the dependencies section is exactly its label and a 32-byte digest, no other section is
 * hidden, there's a 32-byte salt for each of the five other sections and nothing else, and the rest
 * has the shape of the terms in full, so no field sits outside the hash.
 */
function viewProblem(view: ElidedTerms): ReasonCode | null {
  const { dependencies, salts, ...rest } = view
  if (rest.dependencyCheck !== 'avow') return 'terms.invalid'
  if (TERMS_SECTIONS.some((s) => isElidedSection(rest[s]))) return 'terms.invalid'
  if (!isElidedSection(dependencies) || !hasExactly(dependencies, ['label', 'digest'])) {
    return 'terms.invalid'
  }
  if (dependencies.label !== DEPENDENCIES_LABEL || !isBytes32(dependencies.digest)) {
    return 'terms.invalid'
  }
  if (typeof salts !== 'object' || salts === null || !hasExactly(salts, TERMS_SECTIONS)) {
    return 'terms.invalid'
  }
  if (!TERMS_SECTIONS.every((s) => isBytes32(salts[s]))) return 'terms.invalid'
  // An empty list stands in for the entries, which the shape check never reads.
  return chainedTermsShapeProblem({ ...rest, dependencies: [] })
}

/**
 * The buyer's view of version 3 terms Avow checks: the terms with their dependencies section
 * replaced by its digest under its label, and each other section's own salt. Throws on terms the
 * buyer checks, since it needs those in full, and on terms that can't be hashed.
 */
export function elideDependencies(terms: ChainedTerms, salt: Hex): ElidedTerms {
  const problem = chainedTermsShapeProblem(terms)
  if (problem) throw new TypeError(`These terms can't be hashed (${problem})`)
  const { dependencies, dependencyCheck, ...shown } = terms
  if (dependencyCheck !== 'avow') {
    throw new TypeError(
      'The buyer checks the bookings these terms rely on, so it sees them in full',
    )
  }
  const digest = sectionHash('dependencies', dependencies, sectionSalt(salt, 'dependencies'))
  const salts = {} as Record<TermsSection, Hex>
  for (const s of TERMS_SECTIONS) salts[s] = sectionSalt(salt, s)
  return {
    ...shown,
    dependencyCheck,
    dependencies: { label: DEPENDENCIES_LABEL, digest },
    salts,
  }
}

/**
 * The terms hash a buyer's view gives, the one the terms in full give. Each section in clear is
 * hashed with its own salt and the digest stands in for the dependencies section, so the hash
 * binds the hidden entries too, and an approval naming it binds them. Throws on a view
 * `parseElidedTerms` would refuse, such as one whose header says the buyer checks.
 */
export function elidedTermsHash(view: ElidedTerms): Hex {
  const problem = viewProblem(view)
  if (problem) throw new TypeError(`This view of the terms can't be hashed (${problem})`)
  const hashes = { dependencies: view.dependencies.digest } as Record<
    TermsSection | 'dependencies',
    Hex
  >
  for (const s of TERMS_SECTIONS) hashes[s] = sectionHash(s, view[s], view.salts[s])
  return chainedTermsHashFromSections(termsHeader(view), hashes)
}
