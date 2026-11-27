import { describe, expect, it } from 'vitest'
import {
  coversSale,
  type SaleContent,
  saleContentJson,
  saleContentProblem,
  salePrice,
} from './sale-approval.js'
import type { ServiceOfferVersion } from './service.js'
import { toWire } from './wire.js'

const offer: ServiceOfferVersion = {
  supplier: 'biz_supplier',
  item: { name: 'Fine-tuning run', summary: 'One fine-tuning run on the dataset the buyer sends' },
  currency: 'USD',
  unitPrice: 100_000_000n,
  rules: {
    evidence: 'The tuned weights are delivered to the buyer',
    leadTime: 172_800n,
    maxPerBooking: 4,
    dailyCapacity: 5,
    freeCancelWindow: 7_200n,
    lateCancellationBps: 2_000,
    noShowBps: 5_000,
    payment: { route: 'transfer', dueAfterDelivery: 604_800n },
  },
}
const sale: SaleContent = {
  signingKey: `0x${'5e'.repeat(20)}`,
  buyer: 'biz_buyer',
  offer,
  units: 4,
}
const withOffer = (
  change: Partial<Omit<ServiceOfferVersion, 'rules'>>,
  rules: Partial<ServiceOfferVersion['rules']> = {},
): SaleContent => ({ ...sale, offer: { ...offer, ...change, rules: { ...offer.rules, ...rules } } })
const invalid = 'message.invalid'

describe("a sale's content", () => {
  it("is units of one offer version, sold by one key to one buyer, at the offer's price", () => {
    expect(saleContentProblem(sale)).toBeNull()
    expect(salePrice(sale)).toBe(400_000_000n)
    expect(saleContentProblem({ ...sale, units: 5 })).toBe(invalid)
    expect(saleContentProblem({ ...sale, units: 0 })).toBe(invalid)
    expect(saleContentProblem({ ...sale, units: 1.5 })).toBe(invalid)
    expect(saleContentProblem(withOffer({ unitPrice: 0n }))).toBe(invalid)
    // A price so small its charges round to nothing builds no terms.
    expect(saleContentProblem({ ...withOffer({ unitPrice: 1n }), units: 1 })).toBe(invalid)
  })

  it('names both businesses by their ids, and sells to another business', () => {
    for (const buyer of ['', 'biz buyer', 'acme.co', "acme, that passed Avow's simulated check"]) {
      expect(saleContentProblem({ ...sale, buyer })).toBe(invalid)
    }
    expect(saleContentProblem({ ...sale, buyer: 'biz_supplier' })).toBe(invalid)
    expect(saleContentProblem(withOffer({ supplier: 'biz supplier' }))).toBe(invalid)
    expect(saleContentProblem({ ...sale, signingKey: '0xnope' as never })).toBe(invalid)
    expect(saleContentProblem({ ...sale, signingKey: `0x${'5E'.repeat(20)}` })).toBe(invalid)
  })

  it("takes only words that read as written, since a person signs on the seller's agent's own", () => {
    // A line break, a mark that turns text around, a space at an end, and a quote that would end
    // the card's own quoting early.
    for (const text of ['Run\nTotal: $1', 'Run\u202e', ' Run', 'Run" at no charge, and "more']) {
      expect(saleContentProblem(withOffer({ item: { ...offer.item, name: text } }))).toBe(invalid)
      expect(saleContentProblem(withOffer({ item: { ...offer.item, summary: text } }))).toBe(
        invalid,
      )
      expect(saleContentProblem(withOffer({}, { evidence: text }))).toBe(invalid)
    }
  })

  it('holds exactly its four parts, and never throws', () => {
    expect(saleContentProblem({ ...sale, price: 1n } as never)).toBe(invalid)
    const { units: _, ...missing } = sale
    expect(saleContentProblem(missing as never)).toBe(invalid)
    const trap = new Proxy(
      { ...sale },
      {
        get: () => {
          throw new Error('read')
        },
      },
    )
    for (const value of [null, undefined, 'sale', 7, [], trap, { ...sale, offer: null }]) {
      expect(saleContentProblem(value as never)).toBe(invalid)
      expect(coversSale(value as never, sale)).toBe(false)
      expect(coversSale(sale, value as never)).toBe(false)
    }
  })

  it('reads back from JSON as it was written, and takes nothing beside it', () => {
    const wire = JSON.parse(JSON.stringify(toWire(sale)))
    expect(saleContentJson.parse(wire)).toEqual(sale)
    expect(saleContentJson.safeParse({ ...wire, acceptBy: '1' }).success).toBe(false)
    expect(saleContentJson.safeParse({ ...wire, units: 9 }).success).toBe(false)
  })
})

describe('an approved sale', () => {
  it('covers exactly the sale approved, however its parts are written', () => {
    expect(coversSale(sale, structuredClone(sale))).toBe(true)
    const { buyer, ...rest } = sale
    expect(coversSale(sale, { ...rest, buyer })).toBe(true)
  })

  it('covers no other sale, and nothing without an approval', () => {
    const others: SaleContent[] = [
      { ...sale, buyer: 'biz_other' },
      { ...sale, units: 3 },
      { ...sale, signingKey: `0x${'5f'.repeat(20)}` },
      withOffer({ unitPrice: 100_000_001n }),
      withOffer({ item: { ...offer.item, summary: 'Two fine-tuning runs' } }),
      withOffer({}, { noShowBps: 4_000 }),
      withOffer({}, { leadTime: 172_801n }),
      withOffer({}, { evidence: 'An email saying it is done' }),
    ]
    for (const other of others) {
      expect(saleContentProblem(other)).toBeNull()
      expect(coversSale(sale, other)).toBe(false)
    }
    expect(coversSale(null, sale)).toBe(false)
  })

  it('compares what it checked, whatever a value answers when read again', () => {
    let reads = 0
    const shifting = {
      ...sale,
      get units() {
        reads += 1
        return reads === 1 ? 4 : 3
      },
    }
    // Its first read says four units and every later read three. One read is all it gets.
    expect(coversSale(sale, shifting)).toBe(true)
    reads = 0
    expect(coversSale({ ...sale, units: 3 }, shifting)).toBe(false)
  })
})
