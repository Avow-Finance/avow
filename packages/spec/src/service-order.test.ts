import { getAddress } from 'viem'
import { describe, expect, it } from 'vitest'
import { dollars } from './demo.js'
import type { TermsAgreement } from './eip712.js'
import { SANDBOX_PATHS } from './sandbox.js'
import {
  SERVICE_ACCEPT_WITHIN,
  SERVICE_CATEGORY,
  SERVICE_QUANTITY_MAX,
  type ServiceOfferVersion,
  serviceOfferTerms,
} from './service.js'
import {
  parseServiceInbox,
  parseServiceOrder,
  parseServiceOrderRequest,
  parseServiceQuote,
  publishedOffer,
  SERVICE_ORDER_ACCEPT_MARGIN,
  SERVICE_ORDER_CLOCK_SKEW,
  type ServiceOrder,
  type ServiceOrderRequest,
  type ServiceQuote,
  serviceOrderProblem,
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
  offer,
  quantity: 2,
  builtAt: NOW,
  expiry: NOW + 600n,
  ...change,
})

const buyer = {
  businessId: 'northwind-labs',
  account: '0x00000000000000000000000000000000000000a1',
  lock: '0x00000000000000000000000000000000000000b2',
  chainId: 42431,
  mandateHash: `0x${'cd'.repeat(32)}`,
} as const

/** The quote an honest supplier sends for an order. */
const quoteFor = (o: ServiceOrderRequest, change: Partial<TermsAgreement> = {}): ServiceQuote => {
  const terms = serviceOfferTerms(o.offer, o.quantity, o.builtAt, settlement)
  return {
    terms,
    salt: SALT,
    agreement: {
      commitmentId: o.commitmentId,
      termsHash: termsHash(terms, SALT),
      category: SERVICE_CATEGORY,
      buyerBusinessId: buyer.businessId,
      supplierBusinessId: o.offer.supplier,
      mandateHash: buyer.mandateHash,
      nonce: 1n,
      expiry: o.expiry,
      ...change,
    },
    supplierSignature: `0x${'11'.repeat(65)}`,
  }
}

const roundTrip = (value: unknown) => JSON.parse(JSON.stringify(toWire(value)))
/** Text JSON can carry and the terms' canonical form can't, a lone half of a surrogate pair. */
const UNWRITABLE = 'Transcript \ud800'

describe('a service order', () => {
  it('is taken when its offer is one the template takes and its times leave room to accept', () => {
    expect(serviceOrderProblem(order(), NOW)).toBeNull()
    expect(serviceOrderProblem(order(), NOW + 599n)).toBeNull()
    // An order read a while after it was built is still good until it lapses.
    expect(serviceOrderProblem(order({ builtAt: NOW - 300n, expiry: NOW + 300n }), NOW)).toBeNull()
  })

  it("is refused for a quantity the offer doesn't take, rules the template refuses, or text that can't be hashed", () => {
    expect(serviceOrderProblem(order({ quantity: 11 }), NOW)).toBe('terms.template_invalid')
    expect(serviceOrderProblem(order({ quantity: 0 }), NOW)).toBe('terms.template_invalid')
    const broken = { ...offer, rules: { ...offer.rules, lateCancellationBps: 0, noShowBps: 0 } }
    expect(serviceOrderProblem(order({ offer: broken }), NOW)).toBe('terms.template_invalid')
    const unwritable = { ...offer, item: { ...offer.item, name: UNWRITABLE } }
    expect(serviceOrderProblem(order({ offer: unwritable }), NOW)).toBe('terms.template_invalid')
  })

  it('is refused once it has lapsed, and when it was built in the future', () => {
    expect(serviceOrderProblem(order(), NOW + 600n)).toBe('message.expired')
    const ahead = NOW + SERVICE_ORDER_CLOCK_SKEW + 1n
    expect(serviceOrderProblem(order({ builtAt: ahead, expiry: ahead + 600n }), NOW)).toBe(
      'message.invalid',
    )
    expect(serviceOrderProblem(order({ expiry: NOW }), NOW - 10n)).toBe('message.invalid')
  })

  it('lapses a margin before the supplier can no longer accept', () => {
    const last = NOW + SERVICE_ACCEPT_WITHIN - SERVICE_ORDER_ACCEPT_MARGIN
    expect(serviceOrderProblem(order({ expiry: last }), NOW)).toBeNull()
    expect(serviceOrderProblem(order({ expiry: last + 1n }), NOW)).toBe('message.validity_too_long')
  })

  it("can't tell an offer the buyer wrote from one the supplier published, which the supplier checks", () => {
    const forged = { ...offer, unitPrice: 1n }
    expect(serviceOrderProblem(order({ offer: forged }), NOW)).toBeNull()
    expect(publishedOffer(order({ offer: forged }), [offer])).toBeNull()
    expect(publishedOffer(order(), [offer])).toBe(offer)
    expect(publishedOffer(order(), [])).toBeNull()
    const unwritable = { ...offer, item: { ...offer.item, name: UNWRITABLE } }
    expect(publishedOffer(order({ offer: unwritable }), [offer])).toBeNull()
  })
})

describe('a quote for a service order', () => {
  it("answers its order when its terms and its agreement are the order's own", () => {
    expect(serviceQuoteProblem(order(), quoteFor(order()), settlement)).toBeNull()
    expect(serviceQuoteProblem({ ...order(), buyer }, quoteFor(order()), settlement)).toBeNull()
  })

  it('still answers once it has been to the wire and back, whatever case the arbiter is given in', () => {
    const read = parseServiceQuote(roundTrip(quoteFor(order())))
    if (!read) throw new Error("the quote didn't read back")
    const checksummed = { ...settlement, arbiter: getAddress(ARBITER) }
    expect(serviceQuoteProblem(order(), read, checksummed)).toBeNull()
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
    const other = quoteFor(o, { commitmentId: `0x${'ef'.repeat(32)}` })
    expect(serviceQuoteProblem(o, other, settlement)).toBe('order.commitment_mismatch')
    const resalted = { ...quoteFor(o), salt: `0x${'22'.repeat(32)}` } as ServiceQuote
    expect(serviceQuoteProblem(o, resalted, settlement)).toBe('terms.hash_mismatch')
  })

  it("is refused when its agreement isn't for a service, the offer's supplier, or the buyer and its mandate", () => {
    const o = { ...order(), buyer }
    expect(serviceQuoteProblem(o, quoteFor(o, { category: 'compute' }), settlement)).toBe(
      'terms.category_mismatch',
    )
    for (const change of [
      { supplierBusinessId: 'someone-else' },
      { buyerBusinessId: 'someone-else' },
      { mandateHash: `0x${'00'.repeat(32)}` as const },
    ]) {
      expect(serviceQuoteProblem(o, quoteFor(o, change), settlement)).toBe(
        'agreement.parties_mismatch',
      )
    }
  })

  it('refuses, and never throws, on a quote that parsed and still holds something no hash takes', () => {
    const o = order()
    const zeroSalt = { ...quoteFor(o), salt: `0x${'00'.repeat(32)}` } as ServiceQuote
    expect(serviceQuoteProblem(o, zeroSalt, settlement)).not.toBeNull()
    const good = quoteFor(o)
    const unwritable = {
      ...good,
      terms: {
        ...good.terms,
        subject: {
          ...good.terms.subject,
          delivery: { ...good.terms.subject.delivery, evidence: UNWRITABLE },
        },
      },
    } as ServiceQuote
    expect(serviceQuoteProblem(o, unwritable, settlement)).toBe('order.terms_changed')
  })
})

describe('a service order on the wire', () => {
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

  it("refuses a field it doesn't know, a step without what the step needs, and an offer the template refuses", () => {
    expect(parseServiceOrderRequest({ ...roundTrip(order()), note: 'hello' })).toBeNull()
    expect(parseServiceOrder({ ...roundTrip(held), status: 'quoted' })).toBeNull()
    expect(parseServiceOrderRequest({ ...roundTrip(order()), quantity: 1.5 })).toBeNull()
    expect(
      parseServiceOrderRequest({ ...roundTrip(order()), quantity: SERVICE_QUANTITY_MAX + 1 }),
    ).toBeNull()
    const refused = { ...offer, rules: { ...offer.rules, maxPerBooking: -5 } }
    expect(parseServiceOrderRequest(roundTrip(order({ offer: refused })))).toBeNull()
    expect(
      parseServiceOrder(roundTrip({ ...held, offer: refused, status: 'requested' })),
    ).toBeNull()
  })

  it("has paths of its own, apart from a job order's", () => {
    const id = 'ab'.repeat(16)
    expect(SANDBOX_PATHS.serviceOrders).toBe('/v1/sandbox/mailbox/service-orders')
    expect(SANDBOX_PATHS.serviceQuote(id)).toBe(`/v1/sandbox/mailbox/service-orders/${id}/quote`)
    expect(SANDBOX_PATHS.serviceOrder(id)).not.toBe(SANDBOX_PATHS.mailboxOrder(id))
    expect(() => SANDBOX_PATHS.serviceOrder('../inbox')).toThrow(RangeError)
  })
})
