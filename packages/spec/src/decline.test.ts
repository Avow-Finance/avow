import { describe, expect, it } from 'vitest'
import {
  BUYER_HEARS,
  buyerFacingReason,
  DECLINE_RETRY_MAX,
  DECLINE_RULES,
  type DeclinedOrder,
  ORDER_DECLINES,
  type OrderDeclineRequest,
  orderDeclineJson,
  orderDeclineProblem,
  parseOrderDeclineRequest,
  replacementProblem,
  supplierDeclineReason,
  supplierMayDecline,
} from './decline.js'
import { REASON_CODES, type ReasonCode } from './reasons.js'
import { offerVersionId, type ServiceOfferVersion } from './service.js'
import { toWire } from './wire.js'

const HOUR = 3600n
const NOW = 1_800_000_000n

/** Transcription at $50 a unit, delivered a day after it's ordered. */
const offer: ServiceOfferVersion = {
  supplier: 'sandbox-seller',
  item: { name: 'Transcript', summary: 'One hour of audio transcribed into English text' },
  currency: 'USD',
  unitPrice: 50_000_000n,
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
const current: ServiceOfferVersion = { ...offer, unitPrice: 60_000_000n }

const service: DeclinedOrder = { kind: 'service', offer, requestedAt: NOW }
const job: DeclinedOrder = { kind: 'job', offer: null, requestedAt: NOW }
const decline = (fields: Partial<OrderDeclineRequest>): OrderDeclineRequest => ({
  reason: 'capacity.exhausted',
  retryAt: null,
  available: null,
  current: null,
  ...fields,
})

describe("what a buyer hears of a seller's limits", () => {
  it('hears that the seller will not deal with it, and nothing else the check says', () => {
    const codes = Object.keys(REASON_CODES) as ReasonCode[]
    const aboutLimits = codes.filter((code) => code.startsWith('seller_mandate.'))
    expect(aboutLimits.length).toBeGreaterThan(10)
    for (const code of codes) {
      const heard = (BUYER_HEARS as readonly ReasonCode[]).includes(code)
      expect(buyerFacingReason(code)).toBe(heard ? code : 'supplier.not_authorized')
    }
    expect(BUYER_HEARS).toEqual(['approved', 'counterparty.not_eligible'])
    // Nothing yet lets a person approve one sale, so a buyer isn't told to wait for one.
    expect(buyerFacingReason('approval.human_required')).toBe('supplier.not_authorized')
  })
})

describe("a supplier's reason to decline", () => {
  it('turns every refusal of a seller’s limits into supplier.not_authorized', () => {
    const codes = Object.keys(REASON_CODES) as ReasonCode[]
    for (const code of codes.filter((c) => c.startsWith('seller_mandate.'))) {
      expect(supplierDeclineReason(code), code).toBe('supplier.not_authorized')
    }
    expect(supplierDeclineReason('approval.human_required')).toBe('supplier.not_authorized')
    expect(supplierDeclineReason('order.withdrawn')).toBe('supplier.not_authorized')
    expect(supplierDeclineReason('terms.hash_mismatch')).toBe('supplier.not_authorized')
  })

  it('keeps a reason about the offer, the order or the buyer as it is', () => {
    for (const reason of [
      'offer.superseded',
      'offer.withdrawn',
      'capacity.exhausted',
      'quantity.out_of_range',
      'counterparty.not_eligible',
      'proposal.unacceptable',
    ] as const) {
      expect(supplierDeclineReason(reason)).toBe(reason)
      expect(supplierMayDecline(reason)).toBe(true)
    }
  })

  it('tells the buyer to look elsewhere when the seller’s mandate refuses', () => {
    expect(DECLINE_RULES['supplier.not_authorized']).toEqual({
      next: 'choose_another',
      by: 'supplier',
      retryAt: false,
      available: false,
    })
    expect(DECLINE_RULES['order.withdrawn']).toMatchObject({ next: 'none', by: 'buyer' })
  })
})

describe("a supplier's decline of a mailbox order", () => {
  it('takes a reason its kind of order takes, from the supplier', () => {
    expect(orderDeclineProblem(decline({}), service)).toBeNull()
    expect(orderDeclineProblem(decline({}), job)).toBeNull()
    expect(orderDeclineProblem(decline({ reason: 'supplier.not_authorized' }), job)).toBeNull()
    // A job books no offer version, and neither kind of order is open to bargaining.
    expect(orderDeclineProblem(decline({ reason: 'offer.withdrawn' }), job)).toBe('message.invalid')
    expect(orderDeclineProblem(decline({ reason: 'terms.not_negotiable' }), service)).toBe(
      'message.invalid',
    )
    expect(orderDeclineProblem(decline({ reason: 'negotiation.rounds_exhausted' }), service)).toBe(
      'message.invalid',
    )
    // The buyer withdraws on a path of its own, and a supplier never speaks for it.
    expect(orderDeclineProblem(decline({ reason: 'order.withdrawn' }), service)).toBe(
      'message.invalid',
    )
    expect(orderDeclineProblem(decline({ reason: 'mandate.expired' as never }), service)).toBe(
      'message.invalid',
    )
  })

  it('holds back approval.human_required until a buyer may hear it', () => {
    expect(ORDER_DECLINES.service).toContain('approval.human_required')
    expect(orderDeclineProblem(decline({ reason: 'approval.human_required' }), service)).toBe(
      'message.invalid',
    )
  })

  it('carries a time to ask again and the units free only where the reason allows', () => {
    expect(orderDeclineProblem(decline({ retryAt: NOW + HOUR, available: 2 }), service)).toBeNull()
    expect(orderDeclineProblem(decline({ retryAt: NOW }), service)).toBe('message.invalid')
    expect(orderDeclineProblem(decline({ retryAt: NOW + DECLINE_RETRY_MAX }), service)).toBeNull()
    expect(orderDeclineProblem(decline({ retryAt: NOW + DECLINE_RETRY_MAX + 1n }), service)).toBe(
      'message.invalid',
    )
    expect(
      orderDeclineProblem(decline({ reason: 'offer.withdrawn', retryAt: NOW + HOUR }), service),
    ).toBe('message.invalid')
    expect(
      orderDeclineProblem(decline({ reason: 'proposal.unacceptable', available: 1 }), service),
    ).toBe('message.invalid')
    // A job has no units to count.
    expect(orderDeclineProblem(decline({ available: 1 }), job)).toBe('message.invalid')
  })

  it('names the version that replaced the offer, whole, and only for a replaced offer', () => {
    const superseded = decline({ reason: 'offer.superseded', current })
    expect(orderDeclineProblem(superseded, service)).toBeNull()
    expect(orderDeclineProblem({ ...superseded, current: null }, service)).toBe('message.invalid')
    expect(orderDeclineProblem({ ...superseded, current: offer }, service)).toBe('message.invalid')
    expect(
      orderDeclineProblem({ ...superseded, current: { ...current, supplier: 'other' } }, service),
    ).toBe('message.invalid')
    expect(
      orderDeclineProblem(
        { ...superseded, current: { ...current, item: { ...current.item, name: 'Translation' } } },
        service,
      ),
    ).toBe('message.invalid')
    expect(orderDeclineProblem(decline({ reason: 'offer.withdrawn', current }), service)).toBe(
      'message.invalid',
    )
  })

  it('reads from JSON and writes back the same', () => {
    const sent = decline({ reason: 'offer.superseded', current })
    const wire = JSON.parse(JSON.stringify(toWire(sent))) as Record<string, unknown>
    expect(parseOrderDeclineRequest(wire)).toEqual(sent)
    expect(parseOrderDeclineRequest({ ...wire, note: 'call me' })).toBeNull()
    expect(orderDeclineJson.safeParse({ ...wire, declinedAt: NOW.toString() }).success).toBe(true)
  })
})

describe('the version that replaced an offer', () => {
  it('is a newer version of the same item from the same supplier, under the named id', () => {
    expect(replacementProblem(offer, current, offerVersionId(current))).toBeNull()
    expect(replacementProblem(offer, current, offerVersionId(offer))).toBe('message.invalid')
    expect(replacementProblem(offer, offer, offerVersionId(offer))).toBe('message.invalid')
  })
})
