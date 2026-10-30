import { type Hex, zeroAddress } from 'viem'
import { describe, expect, it } from 'vitest'
import { dollars, testnetDemoTerms } from './demo.js'
import { chainedTerms, type Dependency } from './dependencies.js'
import { type Approval, approvalDigest } from './eip712.js'
import {
  DEPENDENCIES_LABEL,
  type ElidedTerms,
  elideDependencies,
  elidedTermsHash,
} from './elided-terms.js'
import { TESTNET_DEMO_PROFILE } from './profiles.js'
import {
  chainedTermsHashFromSections,
  chainedTermsShapeProblem,
  discloseSection,
  lockTerms,
  plainTermsOf,
  sectionHashes,
  sectionLabel,
  sectionSalt,
  TERMS_SECTIONS,
  termsHash,
  termsHeader,
  termsShapeProblem,
  validateChainedTerms,
} from './terms.js'
import { ARBITER, CHAIN_ID, DOMAIN, id, LOCK, newKey, START, TOKEN } from './test-helpers.js'
import type { ChainedTerms } from './types.js'
import { parseChainedTerms, parseElidedTerms, toWire } from './wire.js'

const SALT = `0x${'44'.repeat(32)}` as const
const roundTrip = (value: unknown) => JSON.parse(JSON.stringify(toWire(value)))

/** A dependency on a booking in the seller's lock. */
const entry = (commitmentId = id('upstream')): Dependency => ({
  on: {
    kind: 'commitment',
    chainId: CHAIN_ID,
    lock: LOCK,
    commitmentId,
    side: 'buyer',
    termsHash: id('upstream terms'),
  },
  condition: 'accepted',
  disclosed: 'subject',
})

const plain = testnetDemoTerms(START, ARBITER)
const byAvow = chainedTerms(plain, [entry()], 'avow')
const view = elideDependencies(byAvow, SALT)

describe('the buyer’s view of terms Avow checks', () => {
  it('shows every section in clear but dependencies, which travels as its digest under its label', () => {
    const { dependencies: _, salts, ...shown } = view
    const { dependencies: __, ...rest } = byAvow
    expect(shown).toEqual(rest)
    expect(view.dependencies).toEqual({
      label: 'avow:terms:v3:dependencies',
      digest: sectionHashes(byAvow, SALT).dependencies,
    })
    expect(DEPENDENCIES_LABEL).toBe(sectionLabel('dependencies'))
    for (const s of TERMS_SECTIONS) expect(salts[s], s).toBe(sectionSalt(SALT, s))
  })

  it('holds no entry, no dependencies salt and not the commitment’s salt', () => {
    const text = JSON.stringify(toWire(view))
    for (const hidden of [
      SALT,
      sectionSalt(SALT, 'dependencies'),
      LOCK,
      id('upstream'),
      id('upstream terms'),
    ]) {
      expect(text).not.toContain(hidden.slice(2))
    }
  })

  it('gives the terms hash of the terms in full, so the buyer still checks the whole hash', () => {
    expect(elidedTermsHash(view)).toBe(termsHash(byAvow, SALT))
    const parsed = parseElidedTerms(roundTrip(view))
    if (!parsed.ok) throw new Error(parsed.reason)
    expect(parsed.value).toEqual(view)
    expect(elidedTermsHash(parsed.value)).toBe(termsHash(byAvow, SALT))
  })

  it('never hides the entries of terms the buyer checks itself', () => {
    const byBuyer = chainedTerms(plain, [entry()])
    expect(() => elideDependencies(byBuyer, SALT)).toThrow('in full')
    // The same view saying the buyer checks would give that booking's real terms hash, so a seller
    // could hide entries the buyer is meant to read. The setting rules it out.
    const relabelled = { ...view, dependencyCheck: 'buyer' } as unknown as ElidedTerms
    const hashes = {
      ...sectionHashes(byBuyer, SALT),
      dependencies: relabelled.dependencies.digest,
    }
    expect(chainedTermsHashFromSections(termsHeader(byBuyer), hashes)).toBe(
      termsHash(byBuyer, SALT),
    )
    expect(() => elidedTermsHash(relabelled)).toThrow('terms.invalid')
    expect(parseElidedTerms(roundTrip(relabelled))).toEqual({ ok: false, reason: 'terms.invalid' })
  })

  it('refuses a view that breaks its rules, so nothing in it sits outside the hash', () => {
    const digest = view.dependencies.digest
    const { backing: _, ...fourSalts } = view.salts
    const broken: unknown[] = [
      { ...view, dependencies: { label: sectionLabel('consideration'), digest } },
      { ...view, dependencies: { ...view.dependencies, digest: '0x1234' } },
      { ...view, dependencies: { ...view.dependencies, entries: 1 } },
      { ...view, salts: fourSalts },
      { ...view, salts: { ...view.salts, dependencies: sectionSalt(SALT, 'dependencies') } },
      { ...view, consideration: { label: sectionLabel('consideration'), digest } },
      { ...view, note: 'resold' },
    ]
    broken.forEach((b, i) => {
      expect(() => elidedTermsHash(b as ElidedTerms), `case ${i}`).toThrow()
      expect(parseElidedTerms(roundTrip(b)).ok, `case ${i}`).toBe(false)
    })
  })
})

describe('a reader that needs the entries', () => {
  it('refuses the digest with dependency.elided, and never reads it as relying on nothing', () => {
    const withDigest = { ...byAvow, dependencies: view.dependencies }
    for (const t of [view, withDigest]) {
      expect(chainedTermsShapeProblem(t)).toBe('dependency.elided')
      expect(validateChainedTerms(t as never, TESTNET_DEMO_PROFILE)).toBe('dependency.elided')
      expect(parseChainedTerms(roundTrip(t))).toEqual({ ok: false, reason: 'dependency.elided' })
      expect(() => termsHash(t as never, SALT)).toThrow('dependency.elided')
      expect(() => discloseSection(t as never, SALT, 'subject')).toThrow('dependency.elided')
      // A reader of plain bookings refuses version 3 whatever its dependencies hold.
      expect(termsShapeProblem(t)).toBe('terms.version_unknown')
    }
  })
})

describe('what an approval of terms Avow checks binds', () => {
  const supplier = newKey().address
  /** Avow's approval of these terms under this terms hash, with everything else fixed. */
  const approvalFor = (t: ChainedTerms, hash: Hex): Approval => ({
    ...lockTerms(plainTermsOf(t), TOKEN.decimals),
    commitmentId: id('downstream'),
    token: TOKEN.token,
    supplier,
    supplierSigner: supplier,
    payee: supplier,
    termsHash: hash,
    mandateHash: id('mandate'),
    capPerCommitment: dollars(1000),
    capOpenReserves: dollars(5000),
    fundingKey: zeroAddress,
    nonce: 1n,
    expiry: START,
  })

  it('binds the hidden section, so views that differ only there give other hashes and digests', () => {
    const other = chainedTerms(plain, [entry(id('another upstream'))], 'avow')
    const otherView = elideDependencies(other, SALT)
    // The two views differ in the digest alone.
    expect({ ...otherView, dependencies: view.dependencies }).toEqual(view)
    expect(otherView.dependencies.digest).not.toBe(view.dependencies.digest)
    const hash = elidedTermsHash(view)
    const otherHash = elidedTermsHash(otherView)
    expect(otherHash).not.toBe(hash)
    const digest = approvalDigest(approvalFor(byAvow, hash), DOMAIN)
    // The buyer works out from its view the digest Avow signs from the terms in full.
    expect(approvalDigest(approvalFor(byAvow, termsHash(byAvow, SALT)), DOMAIN)).toBe(digest)
    // An approval built for the other view's hash is another digest, though every field the lock
    // enforces is the same.
    expect(approvalFor(other, otherHash)).toEqual({
      ...approvalFor(byAvow, hash),
      termsHash: otherHash,
    })
    expect(approvalDigest(approvalFor(other, otherHash), DOMAIN)).not.toBe(digest)
  })
})
