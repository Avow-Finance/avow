import {
  dollars,
  enforceableTerms,
  TESTNET_DEMO_PROFILE,
  termsShapeProblem,
  validateTerms,
} from '@avow-finance/spec'
import { describe, expect, it } from 'vitest'
import { micros, SANDBOX_STARTS_IN, sandboxTerms, toDollars } from './terms.js'

const NOW = 1_800_000_000n
const deployment = {
  arbiter: '0x7b7b7e93b9de1b9cba5123f0570b56eb66c53173',
  day90SupplierShareBps: 5000,
} as const
const booking = (resource = { gpu: 'H100', count: 8, hours: 1 }, reserve = dollars(200)) =>
  sandboxTerms({ deployment, resource, reserve, now: NOW })

describe('sandboxTerms', () => {
  it('books the GPUs for the window with the reserve as the largest charge', () => {
    const terms = booking()
    expect(termsShapeProblem(terms)).toBeNull()
    expect(validateTerms(terms, TESTNET_DEMO_PROFILE)).toBeNull()
    expect(terms.subject).toMatchObject({
      resource: { gpu: 'H100', count: 8, sku: 'demo-h100x8' },
      windowStart: NOW + SANDBOX_STARTS_IN,
      windowDuration: 3600n,
    })
    expect(terms.backing.amount).toBe(dollars(200))
    const enforced = enforceableTerms(terms)
    expect(enforced.freeCancelBy).toBe(NOW + SANDBOX_STARTS_IN / 2n)
    expect(enforced.acceptBy).toBe(NOW + SANDBOX_STARTS_IN)
    expect(enforced.releaseDate).toBe(NOW + SANDBOX_STARTS_IN + 3600n)
  })

  it('refuses a resource no supplier could hold', () => {
    expect(() => booking({ gpu: 'H 100', count: 8, hours: 1 })).toThrow(RangeError)
    expect(() => booking({ gpu: 'H100', count: 0, hours: 1 })).toThrow(RangeError)
    expect(() => booking({ gpu: 'H100', count: 1.5, hours: 1 })).toThrow(RangeError)
    expect(() => booking({ gpu: 'H100', count: 8, hours: 0 })).toThrow(RangeError)
    expect(() => booking({ gpu: 'H100', count: 8, hours: 24 * 8 })).toThrow(RangeError)
  })
})

describe('dollars and micros', () => {
  it('takes whole dollars and cents, and nothing finer', () => {
    expect(micros(200, 'reserve')).toBe(dollars(200))
    expect(micros(12.5, 'reserve')).toBe(12_500_000n)
    expect(toDollars(12_500_000n)).toBe(12.5)
    for (const bad of [0, -1, 0.001, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => micros(bad, 'reserve')).toThrow(RangeError)
    }
  })
})
