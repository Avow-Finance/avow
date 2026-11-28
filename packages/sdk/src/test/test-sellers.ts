import { dollars, type ServiceOfferVersion, toWire } from '@avow-finance/spec'

/** A test seller as the sandbox lists one, for the tests that read the list. */

export const SELLER = `sandbox-${'a1'.repeat(20)}`

/** The test seller's ping, as the hosted test sellers publish it. */
export const testPing: ServiceOfferVersion = {
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

export const testSellersList = [
  { businessId: SELLER, name: 'Test Seller One (test business)', offers: [toWire(testPing)] },
]
