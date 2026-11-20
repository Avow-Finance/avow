import { describe, expect, it } from 'vitest'
import { dollars } from './demo.js'
import { MAILBOX_ORDER_LIFETIME_MAX } from './mailbox.js'
import { SANDBOX_PATHS } from './sandbox.js'
import { SERVICE_ACCEPT_WITHIN, type ServiceOfferVersion, serviceOfferTerms } from './service.js'
import {
  parseServiceInbox,
  parseServiceOrder,
  parseServiceOrderRequest,
  parseServiceQuote,
  SERVICE_ORDER_CLOCK_SKEW,
  type ServiceOrder,
  type ServiceOrderRequest,
  type ServiceQuote,
  serviceOrderProblem,
  serviceOrderTerms,
  serviceQuoteProblem,
} from './service-order.js'
import { termsHash } from './terms.js'
import { ARBITER, NOW, SALT } from './test-helpers.js'
import { toWire } from './wire.js'

const HOUR = 3600n
const settlement = { arbiter: ARBITER, day90SupplierShareBps: 5_000 }
const COMMITMENT = `0x${'ab'.repeat(32)}` as const

/** A supplier's offer of transcription by the hour of audio, at $50 a unit. */
const offer: ServiceOfferVersion = {
  supplier: 'acme-transcripts',
  item: { name: 'Transcript', summary: 'One hour of audio transcribed into English text' },
  currency: 'USD',
  unitPrice: dollars(50),
  rules: {
    evidence: 'The transcript is delivered to the buyer as a text file',
    leadTime: 24n * HOUR,
    maxPerBooking: 10,
    dailyCapacity: 20,
    freeCancelWindow: 2n * HOUR,
    lateCancellationBps: 2_000,
    noShowBps: 5_000,
    payment: { route: 'transfer', dueAfterDelivery: 7n * 24n * HOUR },
  },
}

const order = (change: Partial<ServiceOrderRequest> = {}): ServiceOrderRequest => ({
  orderId: 'ab'.repeat(16),
  commitmentId: COMMITMENT,
  supplierBusinessId: 'acme-transcripts',
  offer,
  quantity: 2,
  builtAt: NOW,
  expiry: NOW + 600n,
  ...change,
})

/** The quote an honest supplier sends for an order. */
const quoteFor = (o: ServiceOrderRequest): ServiceQuote => {
  const terms = serviceOrderTerms(o, settlement)
  return {
    terms,
    salt: SALT,
    agreement: {
      commitmentId: o.commitmentId,
      termsHash: termsHash(terms, SALT),
      category: 'service',
      buyerBusinessId: 'northwind-labs',
      supplierBusinessId: o.supplierBusinessId,
      mandateHash: `0x${'cd'.repeat(32)}`,
      nonce: 1n,
      expiry: o.expiry,
    },
    supplierSignature: `0x${'11'.repeat(65)}`,
  }
}

const roundTrip = (value: unknown) => JSON.parse(JSON.stringify(toWire(value)))

describe('a service order', () => {
  it("is taken when its offer is the supplier's own and its times leave room to accept", () => {
    expect(serviceOrderProblem(order(), NOW)).toBeNull()
    expect(serviceOrderProblem(order(), NOW + 599n)).toBeNull()
  })

  it("is refused for another business's offer, a quantity the offer doesn't take, or broken rules", () => {
    expect(serviceOrderProblem(order({ supplierBusinessId: 'someone-else' }), NOW)).toBe(
      'order.supplier_mismatch',
    )
    expect(serviceOrderProblem(order({ quantity: 11 }), NOW)).toBe('terms.template_invalid')
    expect(serviceOrderProblem(order({ quantity: 0 }), NOW)).toBe('terms.template_invalid')
    const broken = { ...offer, rules: { ...offer.rules, lateCancellationBps: 0, noShowBps: 0 } }
    expect(serviceOrderProblem(order({ offer: broken }), NOW)).toBe('terms.template_invalid')
  })

  it('is refused once it has lapsed, and when it was built in the future', () => {
    expect(serviceOrderProblem(order(), NOW + 600n)).toBe('message.expired')
    const ahead = NOW + SERVICE_ORDER_CLOCK_SKEW + 1n
    expect(serviceOrderProblem(order({ builtAt: ahead, expiry: ahead + 600n }), NOW)).toBe(
      'message.invalid',
    )
    expect(serviceOrderProblem(order({ expiry: NOW }), NOW - 10n)).toBe('message.invalid')
  })

  it('is refused when it could still be funded after the supplier can no longer accept', () => {
    expect(serviceOrderProblem(order({ expiry: NOW + SERVICE_ACCEPT_WITHIN }), NOW)).toBe(
      'message.validity_too_long',
    )
    expect(serviceOrderProblem(order({ expiry: NOW + SERVICE_ACCEPT_WITHIN - 1n }), NOW)).toBeNull()
    expect(SERVICE_ACCEPT_WITHIN).toBeLessThan(MAILBOX_ORDER_LIFETIME_MAX)
  })

  it('builds the terms the offer builds, from the moment the order names', () => {
    expect(serviceOrderTerms(order(), settlement)).toEqual(
      serviceOfferTerms(offer, 2, NOW, settlement),
    )
  })
})

describe('a quote for a service order', () => {
  it("answers its order when its terms, its commitment and its hash are the order's own", () => {
    expect(serviceQuoteProblem(order(), quoteFor(order()), settlement)).toBeNull()
  })

  it('is refused when any term moved, whether the price, the quantity or the moment', () => {
    const o = order()
    const dearer = quoteFor(order({ offer: { ...offer, unitPrice: dollars(60) } }))
    expect(serviceQuoteProblem(o, dearer, settlement)).toBe('order.terms_changed')
    expect(serviceQuoteProblem(o, quoteFor(order({ quantity: 3 })), settlement)).toBe(
      'order.terms_changed',
    )
    expect(serviceQuoteProblem(o, quoteFor(order({ builtAt: NOW + 1n })), settlement)).toBe(
      'order.terms_changed',
    )
    const elsewhere = { arbiter: ARBITER, day90SupplierShareBps: 4_000 }
    expect(serviceQuoteProblem(o, quoteFor(o), elsewhere)).toBe('order.terms_changed')
  })

  it("is refused when its agreement names another commitment, or a hash that isn't the terms'", () => {
    const o = order()
    const good = quoteFor(o)
    const other = {
      ...good,
      agreement: { ...good.agreement, commitmentId: `0x${'ef'.repeat(32)}` },
    }
    expect(serviceQuoteProblem(o, other as ServiceQuote, settlement)).toBe(
      'order.commitment_mismatch',
    )
    const resalted = { ...good, salt: `0x${'22'.repeat(32)}` } as ServiceQuote
    expect(serviceQuoteProblem(o, resalted, settlement)).toBe('terms.hash_mismatch')
  })
})

describe('a service order on the wire', () => {
  const buyer = {
    businessId: 'northwind-labs',
    account: '0x00000000000000000000000000000000000000a1',
    lock: '0x00000000000000000000000000000000000000b2',
    chainId: 42431,
    mandateHash: `0x${'cd'.repeat(32)}`,
  } as const
  const held = { ...order(), buyer, requestedAt: NOW }
  const reserve = { fundedIn: null, amount: dollars(50), acceptBy: NOW + SERVICE_ACCEPT_WITHIN }

  it('reads back as it was written, at every step', () => {
    expect(parseServiceOrderRequest(roundTrip(order()))).toEqual(order())
    const quote = quoteFor(order())
    expect(parseServiceQuote(roundTrip(quote))).toEqual(quote)
    const steps: ServiceOrder[] = [
      { ...held, status: 'requested' },
      { ...held, status: 'expired', quote: null },
      { ...held, status: 'quoted', quote },
      { ...held, status: 'reserved', quote, reserve },
      { ...held, status: 'accepted', quote, reserve, acceptedIn: `0x${'ef'.repeat(32)}` },
    ]
    for (const step of steps) expect(parseServiceOrder(roundTrip(step))).toEqual(step)
    expect(parseServiceInbox(roundTrip({ orders: steps }))).toEqual({ orders: steps })
  })

  it("refuses a field it doesn't know, and a step without what the step needs", () => {
    expect(parseServiceOrderRequest({ ...roundTrip(order()), note: 'hello' })).toBeNull()
    expect(parseServiceOrder({ ...roundTrip(held), status: 'quoted' })).toBeNull()
    expect(parseServiceOrderRequest({ ...roundTrip(order()), quantity: 1.5 })).toBeNull()
  })

  it("has paths of its own, apart from a job order's", () => {
    const id = 'ab'.repeat(16)
    expect(SANDBOX_PATHS.serviceOrders).toBe('/v1/sandbox/mailbox/service-orders')
    expect(SANDBOX_PATHS.serviceQuote(id)).toBe(`/v1/sandbox/mailbox/service-orders/${id}/quote`)
    expect(SANDBOX_PATHS.serviceOrder(id)).not.toBe(SANDBOX_PATHS.mailboxOrder(id))
    expect(() => SANDBOX_PATHS.serviceOrder('../inbox')).toThrow(RangeError)
  })
})
