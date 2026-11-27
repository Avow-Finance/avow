import { describe, expect, it } from 'vitest'
import { dollars } from './demo.js'
import type { ServiceOfferVersion } from './service.js'
import { parseTestSellers, TEST_BUSINESS_SUFFIX } from './test-sellers.js'
import { toWire } from './wire.js'

const SELLER = `sandbox-${'a1'.repeat(20)}`

const ping: ServiceOfferVersion = {
  supplier: SELLER,
  item: {
    name: 'Test ping',
    summary:
      'A one-dollar test order from a test business. Nothing is delivered and nothing is billed.',
  },
  currency: 'USD',
  unitPrice: dollars(1),
  rules: {
    evidence: 'None. This is a test item and nothing is delivered.',
    leadTime: 900n,
    maxPerBooking: 1,
    dailyCapacity: 100,
    freeCancelWindow: 900n,
    lateCancellationBps: 0,
    noShowBps: 10_000,
    payment: { route: 'invoice', dueAfterDelivery: 604_800n },
  },
}
const seller = {
  businessId: SELLER,
  name: 'Test Seller One (test business)',
  offers: [toWire(ping)],
}

describe("the deployment's list of test sellers", () => {
  it('reads each seller, labelled as a test business, with its offers whole', () => {
    expect(TEST_BUSINESS_SUFFIX).toBe(' (test business)')
    expect(parseTestSellers([seller])).toEqual({
      ok: true,
      value: [{ businessId: SELLER, name: 'Test Seller One (test business)', offers: [ping] }],
    })
    expect(parseTestSellers([])).toEqual({ ok: true, value: [] })
  })

  const withOffer = (change: Partial<ServiceOfferVersion>) => ({
    ...seller,
    offers: [toWire({ ...ping, ...change })],
  })
  it.each([
    ['a name without the label', { ...seller, name: 'Test Seller One' }],
    ['the label alone', { ...seller, name: '(test business)' }],
    ['a name that calls the business verified', { ...seller, name: 'Verified (test business)' }],
    ['a name on two lines', { ...seller, name: 'Test\nSeller (test business)' }],
    ['an offer of another business', withOffer({ supplier: `sandbox-${'b2'.repeat(20)}` })],
    ['an item that does not start Test', withOffer({ item: { ...ping.item, name: 'Ping' } })],
    [
      'a summary that says verified',
      withOffer({ item: { ...ping.item, summary: 'A verified ping' } }),
    ],
    ['an offer the template refuses', withOffer({ unitPrice: 0n })],
    ['no offers', { ...seller, offers: [] }],
    ['a field the list does not take', { ...seller, sells: ['Test ping'] }],
  ])('refuses the whole list for %s', (_why, entry) => {
    expect(parseTestSellers([entry])).toEqual({ ok: false, reason: 'message.invalid' })
  })

  it('refuses a list that names one business twice', () => {
    expect(parseTestSellers([seller, seller]).ok).toBe(false)
  })
})
