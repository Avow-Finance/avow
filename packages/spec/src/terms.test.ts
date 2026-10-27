import { describe, expect, it } from 'vitest'
import { demoTerms, dollars, testnetDemoTerms } from './demo.js'
import {
  canonicalJson,
  newSalt,
  PRODUCTION_PROFILE,
  TESTNET_DEMO_PROFILE,
  termsHash,
  validateTerms,
} from './terms.js'
import type { ComputeTerms } from './types.js'

const START = 1_800_000_000n
const SALT = `0x${'11'.repeat(32)}` as const

describe('canonicalJson', () => {
  it('sorts keys at every depth and writes bigints as strings', () => {
    expect(canonicalJson({ b: 1n, a: { d: [2n, 'x'], c: true } })).toBe(
      '{"a":{"c":true,"d":["2","x"]},"b":"1"}',
    )
  })

  it('gives the same bytes whatever order the keys were written in', () => {
    const terms = testnetDemoTerms(START)
    const reversed = Object.fromEntries(Object.entries(terms).reverse())
    expect(canonicalJson(reversed)).toBe(canonicalJson(terms))
  })

  it('leaves out undefined fields', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}')
  })

  it('refuses values JSON would change or drop', () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow()
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow()
    expect(() => canonicalJson({ a: () => 1 })).toThrow()
    expect(() => canonicalJson({ a: Symbol('s') })).toThrow()
  })
})

describe('termsHash', () => {
  it('is the same for the same terms and salt', () => {
    expect(termsHash(testnetDemoTerms(START), SALT)).toBe(termsHash(testnetDemoTerms(START), SALT))
  })

  it('changes with the salt', () => {
    expect(termsHash(testnetDemoTerms(START), SALT)).not.toBe(
      termsHash(testnetDemoTerms(START), newSalt()),
    )
  })

  it('changes when any field changes', () => {
    const base = testnetDemoTerms(START)
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
    ]
    for (const change of changes) {
      expect(termsHash({ ...base, ...change }, SALT)).not.toBe(hash)
    }
  })

  it('needs a 32-byte salt', () => {
    expect(() => termsHash(testnetDemoTerms(START), '0x1234')).toThrow()
  })

  it('makes a fresh 32-byte salt each time', () => {
    const a = newSalt()
    expect(a).toMatch(/^0x[0-9a-f]{64}$/)
    expect(newSalt()).not.toBe(a)
  })
})

describe('validateTerms', () => {
  it('accepts the demo terms under production and the testnet terms under the demo profile', () => {
    expect(validateTerms(demoTerms(START), PRODUCTION_PROFILE)).toBeNull()
    expect(validateTerms(testnetDemoTerms(START), TESTNET_DEMO_PROFILE)).toBeNull()
  })

  it("refuses the testnet's 10-minute contest window under production (decision 3)", () => {
    expect(validateTerms(testnetDemoTerms(START), PRODUCTION_PROFILE)).toBe(
      'terms.contest_window_short',
    )
  })

  it('needs the reserve to equal the largest charge', () => {
    const t = testnetDemoTerms(START)
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
    const t = testnetDemoTerms(START)
    const terms = { ...t, lateCancellation: dollars(700), reserve: dollars(700) }
    expect(validateTerms(terms, TESTNET_DEMO_PROFILE)).toBeNull()
  })

  it('needs the deadlines in order', () => {
    const t = testnetDemoTerms(START)
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
