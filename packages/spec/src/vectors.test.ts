import { readFileSync } from 'node:fs'
import { type Hex, keccak256, toHex } from 'viem'
import { describe, expect, it } from 'vitest'
import { canonicalJson } from './canonical.js'
import { elideDependencies, elidedTermsHash } from './elided-terms.js'
import {
  CHAINED_TERMS_SECTIONS,
  checkSectionDisclosure,
  lockTerms,
  plainTermsOf,
  sectionHash,
  sectionHashes,
  sectionSalt,
  TERMS_SECTIONS,
  termsHash,
  termsHeader,
  termsSections,
} from './terms.js'
import {
  parseChainedTerms,
  parseElidedTerms,
  parseSectionDisclosure,
  parseTerms,
  toWire,
} from './wire.js'

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

const bytesOf = (name: string) => readFileSync(new URL(`../vectors/${name}`, import.meta.url))

/**
 * Each published vectors file, pinned by the keccak256 of its bytes. Code and vectors that changed
 * together would pass the checks below, so the pin is what keeps a published version's hashes
 * from moving.
 */
describe('the published vectors', () => {
  it('stay byte for byte as each version published them', () => {
    expect(keccak256(toHex(bytesOf('terms-v2.json')))).toBe(
      '0xb500daa657b84a18fe0f1a0c6b75ad8343b17aa18be6a2e1b9646bc2367e85a5',
    )
    expect(keccak256(toHex(bytesOf('terms-v3.json')))).toBe(
      '0x104c6b4522587964338a98dc9a3505e2b557649b0896c8326b89f39cd4bd3713',
    )
  })
})

const file = JSON.parse(bytesOf('terms-v2.json').toString('utf8')) as { vectors: Vector[] }

describe('version 2 terms vectors', () => {
  it('has vectors to check, including a checksummed arbiter and non-ASCII text', () => {
    expect(file.vectors.length).toBeGreaterThan(2)
    const checksummed = file.vectors.find(
      (v) => v.name === 'checksummed arbiter and a non-ASCII region',
    )
    expect(JSON.stringify(checksummed?.terms)).toContain(
      '0x7B7b7e93b9De1B9Cba5123f0570B56EB66C53173',
    )
    expect(checksummed?.sections.subject.canonicalJson).toContain('"region":"Zürich \\"east\\""')
    expect(checksummed?.sections.resolution.canonicalJson).toContain(
      '"arbiter":"0x7b7b7e93b9de1b9cba5123f0570b56eb66c53173"',
    )
  })

  for (const v of file.vectors) {
    it(`${v.name}: reproduces every canonical form, salt, hash and lock field`, () => {
      const parsed = parseTerms(v.terms)
      if (!parsed.ok) throw new Error(`the vector's terms don't parse: ${parsed.reason}`)
      const terms = parsed.value
      // The parser reads addresses in lower case, the case the hash uses.
      const written = v.terms as { resolution: { arbiter: string } }
      const arbiter = written.resolution.arbiter.toLowerCase()
      expect(toWire(terms)).toEqual({ ...written, resolution: { ...written.resolution, arbiter } })
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
      const lock = v.lockTerms as { arbiter: string }
      expect(toWire(lockTerms(terms, 6))).toEqual({ ...lock, arbiter: lock.arbiter.toLowerCase() })
      const shown = parseSectionDisclosure(v.subjectShownAlone)
      if (!shown.ok) throw new Error(`the shown subject doesn't parse: ${shown.reason}`)
      expect(checkSectionDisclosure(shown.value, v.termsHash)).toBeNull()
    })
  }
})

/**
 * The version 3 vectors in `vectors/terms-v3.json`, which the same script wrote. Version 3 adds the
 * dependencies section, so these check its canonical form, salt and hash, and that the five version
 * 2 sections hash as version 2 hashes them.
 */
interface ChainedVector extends Omit<Vector, 'sections'> {
  sections: Record<(typeof CHAINED_TERMS_SECTIONS)[number], SectionVector>
  /** The buyer's view, for terms Avow checks. */
  elided?: unknown
}

interface WrittenReference {
  lock: string
  commitmentId: string
  termsHash: string
}
type WrittenDependencies = { on: WrittenReference }[]

/** The dependencies as the parser reads them and the hash takes them, with hex in lower case. */
const lowerDependencies = (deps: WrittenDependencies) =>
  deps.map((d) => ({
    ...d,
    on: {
      ...d.on,
      lock: d.on.lock.toLowerCase(),
      commitmentId: d.on.commitmentId.toLowerCase(),
      termsHash: d.on.termsHash.toLowerCase(),
    },
  }))

/** Version 3 terms a reader refuses, with the reason it gives. */
interface InvalidVector {
  name: string
  terms: unknown
  reason: string
}

/** A buyer's view a buyer refuses, with the reason it gives. */
interface InvalidElidedVector {
  name: string
  elided: unknown
  reason: string
}

const chainedFile = JSON.parse(bytesOf('terms-v3.json').toString('utf8')) as {
  vectors: ChainedVector[]
  invalid: InvalidVector[]
  invalidElided: InvalidElidedVector[]
}

describe('version 3 terms vectors', () => {
  it('has vectors to check, including four dependencies named in mixed case', () => {
    expect(chainedFile.vectors.length).toBeGreaterThan(2)
    const mixed = chainedFile.vectors.find(
      (v) => v.name === 'demo terms relying on four bookings named in mixed case',
    )
    const written = mixed?.terms as { dependencies: WrittenDependencies }
    expect(written.dependencies).toHaveLength(4)
    expect(JSON.stringify(written)).toContain('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed')
    expect(mixed?.sections.dependencies.canonicalJson).toContain(
      '"lock":"0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed"',
    )
    expect(mixed?.sections.dependencies.canonicalJson).not.toMatch(/0x[0-9a-f]*[A-F]/)
  })

  it('relies on a booking the version 2 vectors describe, by its terms hash', () => {
    const [first] = chainedFile.vectors
    if (!first) throw new Error('the file has vectors')
    const reliedOn = (first.terms as { dependencies: WrittenDependencies }).dependencies[0]
    expect(reliedOn?.on.termsHash).toBe(file.vectors[0]?.termsHash)
  })

  for (const v of chainedFile.vectors) {
    it(`${v.name}: reproduces every canonical form, salt, hash and lock field`, () => {
      const parsed = parseChainedTerms(v.terms)
      if (!parsed.ok) throw new Error(`the vector's terms don't parse: ${parsed.reason}`)
      const terms = parsed.value
      // A version 2 reader refuses them.
      expect(parseTerms(v.terms)).toEqual({ ok: false, reason: 'terms.version_unknown' })
      const written = v.terms as {
        resolution: { arbiter: string }
        dependencies: WrittenDependencies
      }
      expect(toWire(terms)).toEqual({
        ...written,
        resolution: { ...written.resolution, arbiter: written.resolution.arbiter.toLowerCase() },
        dependencies: lowerDependencies(written.dependencies),
      })
      expect(canonicalJson(termsHeader(terms))).toBe(v.header)
      const sections = termsSections(terms)
      const hashes = sectionHashes(terms, v.salt)
      for (const s of CHAINED_TERMS_SECTIONS) {
        const expected = v.sections[s]
        expect(sectionSalt(v.salt, s), s).toBe(expected.salt)
        expect(sectionHash(s, sections[s], expected.salt), s).toBe(expected.hash)
        expect(hashes[s], s).toBe(expected.hash)
        const hashed =
          s === 'dependencies'
            ? lowerDependencies(sections[s] as unknown as WrittenDependencies)
            : hashedForm(s, sections[s])
        expect(canonicalJson(hashed), s).toBe(expected.canonicalJson)
      }
      expect(termsHash(terms, v.salt)).toBe(v.termsHash)
      const lock = v.lockTerms as { arbiter: string }
      // The lock enforces what the plain booking they describe makes it enforce.
      expect(toWire(lockTerms(plainTermsOf(terms), 6))).toEqual({
        ...lock,
        arbiter: lock.arbiter.toLowerCase(),
      })
      const shown = parseSectionDisclosure(v.subjectShownAlone)
      if (!shown.ok) throw new Error(`the shown subject doesn't parse: ${shown.reason}`)
      expect(Object.keys(shown.value.others).sort()).toEqual(
        CHAINED_TERMS_SECTIONS.filter((s) => s !== 'subject').sort(),
      )
      expect(checkSectionDisclosure(shown.value, v.termsHash)).toBeNull()
    })
  }
})

describe('the buyer’s view in the version 3 vectors', () => {
  const avowChecked = chainedFile.vectors.filter((v) => v.elided !== undefined)

  it('has terms Avow checks, with the buyer’s view of them', () => {
    expect(
      avowChecked.map((v) => (v.terms as { dependencyCheck: string }).dependencyCheck),
    ).toEqual(['avow'])
  })

  for (const v of avowChecked) {
    it(`${v.name}: reproduces the view, and the view gives the terms hash`, () => {
      const parsed = parseChainedTerms(v.terms)
      if (!parsed.ok) throw new Error(`the vector's terms don't parse: ${parsed.reason}`)
      expect(toWire(elideDependencies(parsed.value, v.salt))).toEqual(v.elided)
      const view = parseElidedTerms(v.elided)
      if (!view.ok) throw new Error(`the view doesn't parse: ${view.reason}`)
      expect(view.value.dependencies.digest).toBe(v.sections.dependencies.hash)
      for (const s of TERMS_SECTIONS) expect(view.value.salts[s], s).toBe(v.sections[s].salt)
      expect(elidedTermsHash(view.value)).toBe(v.termsHash)
      // A reader of the terms in full refuses the view, and never reads it as relying on nothing.
      expect(parseChainedTerms(v.elided)).toEqual({ ok: false, reason: 'dependency.elided' })
    })
  }
})

describe('version 3 terms vectors a reader refuses', () => {
  it('cover each way a dependencies section or its setting breaks the rules', () => {
    expect(chainedFile.invalid.map((v) => v.name)).toEqual([
      'no entries',
      'five entries',
      'two entries naming one booking, differing only in letter case',
      'a condition version 3 does not know',
      'a disclosed section version 3 does not allow',
      'a booking on the supplier side',
      'an entry with a key beside its three',
      'a reference with a key beside its six',
      'a setting version 3 does not know',
      'no setting',
      'the dependencies section only as its digest',
    ])
  })

  for (const v of chainedFile.invalid) {
    it(`${v.name}: ${v.reason}`, () => {
      expect(parseChainedTerms(v.terms)).toEqual({ ok: false, reason: v.reason })
      // Nothing else is wrong with them, so the first vector's section and setting make them parse.
      const first = chainedFile.vectors[0]?.terms as {
        dependencies: unknown
        dependencyCheck: unknown
      }
      const repaired = {
        ...(v.terms as object),
        dependencyCheck: first.dependencyCheck,
        dependencies: first.dependencies,
      }
      expect(parseChainedTerms(repaired).ok).toBe(true)
    })
  }
})

describe('views of version 3 terms a buyer refuses', () => {
  it('cover malformed elision and a view that hides any other section', () => {
    expect(chainedFile.invalidElided.map((v) => v.name)).toEqual([
      'a view of terms the buyer checks',
      'a view that hides the consideration too',
      'a view that hides the subject and shows the dependencies',
      'the dependencies in clear',
      'a digest under another label',
      'a digest that is not 32 bytes',
      'an elided section with a key beside its label and digest',
      'the dependencies section salt beside the digest',
      'a section shown without its salt',
    ])
  })

  for (const v of chainedFile.invalidElided) {
    it(`${v.name}: ${v.reason}`, () => {
      expect(parseElidedTerms(v.elided)).toEqual({ ok: false, reason: v.reason })
    })
  }
})
