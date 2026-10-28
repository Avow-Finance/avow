import { describe, expect, it } from 'vitest'
import { newSalt } from './canonical.js'
import { dollars } from './demo.js'
import { PRODUCTION_PROFILE, TESTNET_DEMO_PROFILE } from './profiles.js'
import { enforceableTerms, lockTerms, termsCharges, termsHash, validateTerms } from './terms.js'
import {
  type ComputeTermsV1,
  demoTermsV1 as demoTerms,
  termsChargesV1,
  termsHashV1,
  testnetDemoTermsV1 as testnetDemoTerms,
  validateTermsV1,
} from './terms-v1.js'
import { ARBITER } from './test-helpers.js'

type ComputeTerms = ComputeTermsV1

/**
 * Version 1 terms, as published before the terms had a version. These tests are the ones version 1
 * shipped with, run against the frozen code and through the functions that read any version, so a
 * commitment made under version 1 stays verifiable.
 */

const START = 1_800_000_000n
const SALT = `0x${'11'.repeat(32)}` as const

describe('version 1 vectors, pinned from the published build', () => {
  // Computed by the spec package at commit eb24e3d, before version 2 existed.
  const VECTORS = [
    {
      terms: testnetDemoTerms(START, ARBITER),
      salt: SALT,
      hash: '0xd648088b701ad774206f2f185ed87447e0a5901b3cb33a3139de98c9c55d0db7',
    },
    {
      terms: demoTerms(START, ARBITER),
      salt: SALT,
      hash: '0xc7384c84d078536a729fc45d1a2617d9bca89189fdc1cf146cfa5714445d6992',
    },
    {
      terms: demoTerms(START, ARBITER),
      salt: `0x${'5a'.repeat(32)}` as const,
      hash: '0x692897bff22ac143b1b3229b3a6eb33a26ea3db2218bf5db88fcbeff75835395',
    },
  ]

  it('hashes exactly as it did, through the frozen code and through termsHash', () => {
    for (const v of VECTORS) {
      expect(termsHashV1(v.terms, v.salt)).toBe(v.hash)
      expect(termsHash(v.terms, v.salt)).toBe(v.hash)
    }
  })

  it('validates and maps to the lock as it did', () => {
    const t = testnetDemoTerms(START, ARBITER)
    expect(validateTerms(t, TESTNET_DEMO_PROFILE)).toBe(validateTermsV1(t, TESTNET_DEMO_PROFILE))
    expect(termsCharges(t, 6)).toEqual(termsChargesV1(t, 6))
    expect(lockTerms(t, 6)).toEqual({
      amount: t.reserve,
      freeCancelBy: t.freeCancelBy,
      acceptBy: t.acceptBy,
      chargeDeadline: t.chargeDeadline,
      releaseDate: t.releaseDate,
      contestWindow: t.contestWindow,
      charges: termsChargesV1(t, 6),
      day90SupplierShareBps: t.dispute.day90SupplierShareBps,
      arbiter: t.dispute.arbiter,
    })
    expect(enforceableTerms(t).reserve).toBe(t.reserve)
  })
})

describe('termsHash for version 1', () => {
  it('is the same for the same terms and salt', () => {
    expect(termsHash(testnetDemoTerms(START, ARBITER), SALT)).toBe(
      termsHash(testnetDemoTerms(START, ARBITER), SALT),
    )
  })

  it('changes with the salt', () => {
    expect(termsHash(testnetDemoTerms(START, ARBITER), SALT)).not.toBe(
      termsHash(testnetDemoTerms(START, ARBITER), newSalt()),
    )
  })

  it('changes when any field changes', () => {
    const base = testnetDemoTerms(START, ARBITER)
    const hash = termsHash(base, SALT)
    const changes: Partial<ComputeTerms>[] = [
      { resource: { ...base.resource, count: 7 } },
      { resource: { ...base.resource, region: 'elsewhere' } },
      { windowStart: base.windowStart + 1n },
      { windowDuration: base.windowDuration + 1n },
      { acceptBy: base.acceptBy - 1n },
      { price: { perGpuHour: base.price.perGpuHour + 1n } },
      { reserve: base.reserve - 1n },
      { freeCancelBy: base.freeCancelBy - 1n },
      { lateCancellation: base.lateCancellation + 1n },
      { noShow: base.noShow - 1n },
      { gracePeriod: base.gracePeriod + 1n },
      { chargeDeadline: base.chargeDeadline + 1n },
      { contestWindow: base.contestWindow + 1n },
      { releaseDate: base.releaseDate + 1n },
      { dispute: { ...base.dispute, arbiter: '0x000000000000000000000000000000000000a4b2' } },
      { dispute: { ...base.dispute, day90SupplierShareBps: 4999 } },
    ]
    for (const change of changes) {
      expect(termsHash({ ...base, ...change }, SALT)).not.toBe(hash)
    }
  })

  it("reads the arbiter's address in any letter case as the same terms", () => {
    const base = testnetDemoTerms(START, '0x00000000000000000000000000000000000ABCDE')
    const lower = {
      ...base,
      dispute: { ...base.dispute, arbiter: base.dispute.arbiter.toLowerCase() as typeof ARBITER },
    }
    expect(termsHash(base, SALT)).toBe(termsHash(lower, SALT))
  })

  it('needs a 32-byte salt', () => {
    expect(() => termsHash(testnetDemoTerms(START, ARBITER), '0x1234')).toThrow()
  })
})

describe('validateTerms for version 1', () => {
  it('accepts the demo terms under production and the testnet terms under the demo profile', () => {
    expect(validateTerms(demoTerms(START, ARBITER), PRODUCTION_PROFILE)).toBeNull()
    expect(validateTerms(testnetDemoTerms(START, ARBITER), TESTNET_DEMO_PROFILE)).toBeNull()
  })

  it("refuses the testnet's 10-minute contest window under production", () => {
    expect(validateTerms(testnetDemoTerms(START, ARBITER), PRODUCTION_PROFILE)).toBe(
      'terms.contest_window_short',
    )
  })

  it('needs the reserve to equal the largest charge', () => {
    const t = testnetDemoTerms(START, ARBITER)
    expect(validateTerms({ ...t, reserve: dollars(499) }, TESTNET_DEMO_PROFILE)).toBe(
      'terms.reserve_mismatch',
    )
    expect(validateTerms({ ...t, reserve: dollars(600) }, TESTNET_DEMO_PROFILE)).toBe(
      'terms.reserve_mismatch',
    )
    expect(
      validateTerms({ ...t, lateCancellation: 0n, noShow: 0n, reserve: 0n }, TESTNET_DEMO_PROFILE),
    ).toBe('terms.reserve_mismatch')
  })

  it('takes the late-cancellation charge when it is the larger one', () => {
    const t = testnetDemoTerms(START, ARBITER)
    const terms = { ...t, lateCancellation: dollars(700), reserve: dollars(700) }
    expect(validateTerms(terms, TESTNET_DEMO_PROFILE)).toBeNull()
  })

  it('needs the dispute terms, with a real arbiter and a share from 0 to 10,000', () => {
    const t = testnetDemoTerms(START, ARBITER)
    const { dispute: _, ...withoutDispute } = t
    expect(validateTerms(withoutDispute as ComputeTerms, TESTNET_DEMO_PROFILE)).toBe(
      'terms.incomplete',
    )
    const bad = [
      { arbiter: '0x0000000000000000000000000000000000000000', day90SupplierShareBps: 5000 },
      { arbiter: '0x1234', day90SupplierShareBps: 5000 },
      { arbiter: ARBITER, day90SupplierShareBps: -1 },
      { arbiter: ARBITER, day90SupplierShareBps: 10_001 },
      { arbiter: ARBITER, day90SupplierShareBps: 50.5 },
    ]
    for (const dispute of bad) {
      const terms = { ...t, dispute } as ComputeTerms
      expect(validateTerms(terms, TESTNET_DEMO_PROFILE), JSON.stringify(dispute)).toBe(
        'terms.dispute_invalid',
      )
    }
    for (const share of [0, 10_000]) {
      const terms = { ...t, dispute: { arbiter: ARBITER, day90SupplierShareBps: share } }
      expect(validateTerms(terms, TESTNET_DEMO_PROFILE)).toBeNull()
    }
  })

  it('needs the deadlines in order', () => {
    const t = testnetDemoTerms(START, ARBITER)
    const end = t.windowStart + t.windowDuration
    const bad: Partial<ComputeTerms>[] = [
      { windowDuration: 0n },
      { freeCancelBy: t.windowStart + 1n },
      { acceptBy: t.windowStart + 1n },
      { chargeDeadline: end - 1n },
      { releaseDate: t.chargeDeadline - 1n },
      { gracePeriod: t.chargeDeadline - t.windowStart },
      { gracePeriod: -1n },
    ]
    for (const change of bad) {
      expect(validateTerms({ ...t, ...change }, TESTNET_DEMO_PROFILE)).toBe(
        'terms.deadlines_out_of_order',
      )
    }
  })
})

describe('termsCharges for version 1', () => {
  it("gives the lock's charges for the terms, in the token's base units", () => {
    const t = testnetDemoTerms(START, ARBITER)
    expect(termsCharges(t, 6)).toEqual([
      { kind: 'lateCancellation', most: 250_000_000n, earliest: t.freeCancelBy },
      { kind: 'noShow', most: 500_000_000n, earliest: t.windowStart + t.gracePeriod },
    ])
    expect(termsCharges(t, 18)[1]?.most).toBe(500n * 10n ** 18n)
  })

  it('leaves out a kind the terms set to zero', () => {
    const t = { ...testnetDemoTerms(START, ARBITER), lateCancellation: 0n }
    expect(termsCharges(t, 6).map((c) => c.kind)).toEqual(['noShow'])
  })
})
