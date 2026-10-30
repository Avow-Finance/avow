import {
  checkMandate,
  gpuReservationTerms,
  type RailToken,
  TESTNET_DEMO_PROFILE,
  validateTerms,
} from '@avow-finance/spec'
import { describe, expect, it } from 'vitest'
import { quickstartBooking, quickstartMandate } from './plan.js'

const NOW = 1_800_000_000n
const ARBITER = '0x000000000000000000000000000000000000a4b1'
const TOKEN: RailToken = {
  rail: 'tempo',
  chainId: 42431,
  token: '0x20c00000000000000000000058fbf8a39a171185',
  currency: 'USD',
  decimals: 6,
}
const supplier = {
  businessId: 'biz_supplier',
  account: '0x00000000000000000000000000000000000000c1',
  payee: '0x00000000000000000000000000000000000000c1',
  signingKey: '0x00000000000000000000000000000000000000c3',
} as const
const reserve = 500_000_000n

const mandate = quickstartMandate({
  businessId: 'biz_buyer',
  agentId: 'agt_quickstart',
  account: '0x00000000000000000000000000000000000000b1',
  agentKey: '0x00000000000000000000000000000000000000a1',
  supplier,
  token: TOKEN.token,
  reserve,
  open: 3n,
  now: NOW,
})

describe("the quickstart's booking and mandate", () => {
  for (const [what, startsIn, minutes] of [
    ['the default window', 720n, 30n],
    ['a rehearsal window that ends in four minutes', 180n, 1n],
  ] as const) {
    it(`books ${what} on terms the testnet profile takes and the mandate allows`, () => {
      const booking = quickstartBooking({
        now: NOW,
        startsIn,
        minutes,
        reserve,
        arbiter: ARBITER,
        day90SupplierShareBps: 5000,
      })
      const terms = gpuReservationTerms(booking)
      expect(validateTerms(terms, TESTNET_DEMO_PROFILE)).toBeNull()
      expect(terms.backing.amount).toBe(reserve)
      expect(terms.backing.releaseDate).toBe(NOW + startsIn + minutes * 60n)
      const allowed = checkMandate({
        mandate,
        request: {
          commitmentId: `0x${'11'.repeat(32)}`,
          agentKey: mandate.agentKey,
          supplier: supplier.businessId,
          payee: supplier.payee,
          category: 'compute',
          terms,
        },
        token: TOKEN,
        openReserves: 0n,
        revoked: false,
        now: NOW,
        profile: TESTNET_DEMO_PROFILE,
      })
      expect(allowed).toMatchObject({ result: 'approved' })
    })
  }

  it('refuses a window too soon or too short to book', () => {
    const base = { now: NOW, reserve, arbiter: ARBITER, day90SupplierShareBps: 5000 } as const
    expect(() => quickstartBooking({ ...base, startsIn: 60n, minutes: 30n })).toThrow('two minutes')
    expect(() => quickstartBooking({ ...base, startsIn: 720n, minutes: 0n })).toThrow('a minute')
  })

  it('lets the agent reserve only with the one supplier, for a week, and cancel or start', () => {
    expect(mandate).toMatchObject({
      actions: ['reserve', 'cancel', 'start'],
      suppliers: ['biz_supplier'],
      capPerCommitment: reserve,
      capOpenReserves: 3n * reserve,
      expiry: NOW + 7n * 86_400n,
    })
  })
})
