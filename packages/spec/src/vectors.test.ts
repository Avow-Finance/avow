import { readFileSync } from 'node:fs'
import type { Hex } from 'viem'
import { describe, expect, it } from 'vitest'
import { canonicalJson } from './canonical.js'
import {
  checkSectionDisclosure,
  lockTerms,
  sectionHash,
  sectionHashes,
  sectionSalt,
  TERMS_SECTIONS,
  termsHash,
  termsHeader,
  termsSections,
} from './terms.js'
import { parseSectionDisclosure, parseTerms, toWire } from './wire.js'

/**
 * The version 2 vectors another implementation checks itself against, in `vectors/terms-v2.json`.
 * `scripts/write-terms-vectors.mjs` wrote them. This fails when the code and the file disagree, so a
 * change to how terms hash can't pass without new vectors and a new terms version.
 */
interface SectionVector {
  canonicalJson: string
  salt: Hex
  hash: Hex
}
interface Vector {
  name: string
  salt: Hex
  terms: unknown
  header: string
  sections: Record<(typeof TERMS_SECTIONS)[number], SectionVector>
  termsHash: Hex
  lockTerms: unknown
  subjectShownAlone: unknown
}

/** A section as it's hashed, with the arbiter in lower case. */
const hashedForm = (s: string, content: unknown) =>
  s === 'resolution'
    ? { ...(content as object), arbiter: (content as { arbiter: string }).arbiter.toLowerCase() }
    : content

const file = JSON.parse(
  readFileSync(new URL('../vectors/terms-v2.json', import.meta.url), 'utf8'),
) as { vectors: Vector[] }

describe('version 2 terms vectors', () => {
  it('has vectors to check', () => {
    expect(file.vectors.length).toBeGreaterThan(0)
  })

  for (const v of file.vectors) {
    it(`${v.name}: reproduces every canonical form, salt, hash and lock field`, () => {
      const parsed = parseTerms(v.terms)
      if (!parsed.ok) throw new Error(`the vector's terms don't parse: ${parsed.reason}`)
      const terms = parsed.value
      expect(toWire(terms)).toEqual(v.terms)
      expect(canonicalJson(termsHeader(terms))).toBe(v.header)
      const sections = termsSections(terms)
      const hashes = sectionHashes(terms, v.salt)
      for (const s of TERMS_SECTIONS) {
        const expected = v.sections[s]
        expect(sectionSalt(v.salt, s), s).toBe(expected.salt)
        expect(sectionHash(s, sections[s], expected.salt), s).toBe(expected.hash)
        expect(hashes[s], s).toBe(expected.hash)
        expect(canonicalJson(hashedForm(s, sections[s])), s).toBe(expected.canonicalJson)
      }
      expect(termsHash(terms, v.salt)).toBe(v.termsHash)
      expect(toWire(lockTerms(terms, 6))).toEqual(v.lockTerms)
      const shown = parseSectionDisclosure(v.subjectShownAlone)
      if (!shown.ok) throw new Error(`the shown subject doesn't parse: ${shown.reason}`)
      expect(checkSectionDisclosure(shown.value, v.termsHash)).toBeNull()
    })
  }
})
