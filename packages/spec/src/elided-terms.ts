import type { Hex } from 'viem'
import {
  chainedTermsHashFromSections,
  chainedTermsShapeProblem,
  DEPENDENCIES_LABEL,
  type ElidedSection,
  sectionHash,
  sectionSalt,
  TERMS_SECTIONS,
  type TermsSection,
  termsHeader,
} from './terms.js'
import type { ChainedTerms } from './types.js'
import { parseElidedTerms, toWire } from './wire.js'

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
  /** The dependencies section's hash under `DEPENDENCIES_LABEL`. Its salt never reaches the buyer. */
  dependencies: ElidedSection
  /**
   * The own salt of each section shown in clear. The terms' salt, which every section salt comes
   * from, never reaches the buyer.
   */
  salts: Readonly<Record<TermsSection, Hex>>
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
 * The terms hash a buyer's view gives, the one the terms in full give. The view is read exactly as
 * `parseElidedTerms` reads it, so this throws on any view that refuses, such as one whose header
 * says the buyer checks, one hiding another section, or one holding a field the hash would leave
 * out. Each section in clear is hashed with its own salt and the digest stands in for the
 * dependencies section, so the hash binds the hidden entries too, and an approval naming it binds
 * them.
 */
export function elidedTermsHash(view: ElidedTerms): Hex {
  const read = parseElidedTerms(toWire(view))
  if (!read.ok) throw new TypeError(`This view of the terms can't be hashed (${read.reason})`)
  const v = read.value
  const hashes = { dependencies: v.dependencies.digest } as Record<
    TermsSection | 'dependencies',
    Hex
  >
  for (const s of TERMS_SECTIONS) hashes[s] = sectionHash(s, v[s], v.salts[s])
  return chainedTermsHashFromSections(termsHeader(v), hashes)
}
