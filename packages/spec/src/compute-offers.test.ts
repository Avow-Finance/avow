import { describe, expect, it } from 'vitest'
import {
  computeOfferCost,
  computeOffersPath,
  computeOfferTerms,
  isFirmOffer,
  offerTakes,
  parseComputeOffers,
} from './compute-offers.js'
import { DEMO_GPU_SUPPLIER, demoComputeOffers, dollars, testnetDemoJobTerms } from './demo.js'
import { jobFitsReservation } from './job.js'
import { TESTNET_DEMO_PROFILE } from './profiles.js'
import { validateTerms } from './terms.js'
import { ARBITER, NOW, START } from './test-helpers.js'
import { toWire } from './wire.js'

const overJson = (value: unknown): unknown => JSON.parse(JSON.stringify(toWire(value)))
const job = testnetDemoJobTerms(START, ARBITER)
const listing = demoComputeOffers({
  startsAt: job.subject.startsAt,
  deliverBy: job.subject.deliverBy,
  listedAt: NOW,
})
const settlement = { arbiter: ARBITER, day90SupplierShareBps: 5000 }
const offer = (id: string) => {
  const found = listing.offers.find((o) => o.id === id)
  if (!found) throw new Error(`no offer ${id}`)
  return found
}

describe('compute offers', () => {
  it('list under the adapter with the job’s window in the query', () => {
    expect(computeOffersPath({ startsAt: 100n, deliverBy: 700n })).toBe(
      '/offers?startsAt=100&deliverBy=700',
    )
  })

  it('read back a listing exactly as it went out, and refuse one that repeats an id or mixes suppliers', () => {
    expect(parseComputeOffers(overJson(listing))).toEqual({ ok: true, value: listing })
    const twice = { ...listing, offers: [listing.offers[0], listing.offers[0]] }
    expect(parseComputeOffers(overJson(twice)).ok).toBe(false)
    const mixed = { ...listing, offers: [{ ...offer('h100-firm'), supplier: 'someone-else' }] }
    expect(parseComputeOffers(overJson(mixed)).ok).toBe(false)
    const backwards = { ...listing, offers: [{ ...offer('h100-firm'), gpus: { min: 4, max: 2 } }] }
    expect(parseComputeOffers(overJson(backwards)).ok).toBe(false)
    const oddMinutes = { ...listing, offers: [{ ...offer('h100-firm'), hours: 0.0101 }] }
    expect(parseComputeOffers(overJson(oddMinutes)).ok).toBe(false)
  })

  it('cost the usage for the whole window apart from the reserve, per GPU', () => {
    const firm = offer('h100-firm')
    const minutes = BigInt(Math.round(firm.hours * 60))
    expect(computeOfferCost(firm, 1)).toEqual({
      price: (2_400_000n * minutes) / 60n,
      reserve: dollars(40),
    })
    expect(computeOfferCost(firm, 16).reserve).toBe(dollars(640))
    expect(() => computeOfferCost(firm, 17)).toThrow(RangeError)
    expect(() => computeOfferCost(offer('h100-x16'), 1)).toThrow(RangeError)
    expect(offerTakes(offer('h100-x16'), 16)).toBe(true)
  })

  it('build terms the testnet profile takes, with the offer’s window, rate and deadlines', () => {
    for (const o of listing.offers) {
      const terms = computeOfferTerms(o, o.gpus.min, settlement)
      expect(validateTerms(terms, TESTNET_DEMO_PROFILE), o.id).toBeNull()
      expect(terms.subject.windowStart).toBe(o.startsAt)
      expect(terms.remedies.freeCancelBy).toBe(o.freeCancelBy)
      expect(terms.consideration).toEqual({
        kind: 'rate',
        amount: o.pricePerGpuHour,
        unit: 'gpu-hour',
      })
      expect(terms.backing.amount).toBe(computeOfferCost(o, o.gpus.min).reserve)
    }
  })
})

describe('the demo supplier’s four offers for a job', () => {
  const fits = (id: string) =>
    jobFitsReservation(job.subject, computeOfferTerms(offer(id), 1, settlement).subject)

  it('make one clearly best, firm, over the whole run and within the budget', () => {
    const firm = offer('h100-firm')
    expect(firm.supplier).toBe(DEMO_GPU_SUPPLIER)
    expect(isFirmOffer(firm, listing.listedAt)).toBe(true)
    expect(fits('h100-firm')).toBe(true)
    expect(firm.pricePerGpuHour <= dollars(3)).toBe(true)
  })

  it('end the flexible offer’s free cancellation at the job’s start, so it can never pass before the job starts', () => {
    const flex = offer('h100-flex')
    expect(flex.freeCancelBy).toBe(job.subject.startsAt)
    expect(flex.startsAt).toBe(job.subject.startsAt)
  })

  it('lapse before any window starts, ten minutes after listing at most', () => {
    for (const o of listing.offers) {
      expect(o.expiry <= o.startsAt - 60n, o.id).toBe(true)
      expect(o.expiry <= listing.listedAt + 600n, o.id).toBe(true)
    }
    // A listing made close to the job's start lapses a minute before the window.
    const late = demoComputeOffers({
      startsAt: job.subject.startsAt,
      deliverBy: job.subject.deliverBy,
      listedAt: job.subject.startsAt - 150n,
    })
    const firm = late.offers.find((o) => o.id === 'h100-firm')
    expect(firm?.expiry).toBe((firm?.startsAt ?? 0n) - 60n)
  })

  it('fail each of the others for a reason a check names', () => {
    // Flexible, so still cancellable when the customer checks it.
    expect(isFirmOffer(offer('h100-flex'), listing.listedAt)).toBe(false)
    expect(fits('h100-flex')).toBe(true)
    // Starts after the deadline, so it doesn't hold the job's run.
    expect(fits('h100-later')).toBe(false)
    // Only sixteen GPUs, which reserve more than $500.
    expect(computeOfferCost(offer('h100-x16'), 16).reserve).toBe(dollars(640))
    // The cheapest is the flexible one, so a lowered budget of $1.80 leaves only it.
    const underLowered = listing.offers.filter((o) => o.pricePerGpuHour <= 1_800_000n)
    expect(underLowered.map((o) => o.id)).toEqual(['h100-flex'])
  })
})
