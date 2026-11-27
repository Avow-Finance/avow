import { describe, expect, it } from 'vitest'
import { coversSale, type SaleContent, saleContentProblem } from './sale-approval.js'

const OFFER = `0x${'0f'.repeat(32)}` as const
const service: SaleContent = {
  buyer: 'biz_buyer',
  category: 'service',
  item: 'Fine-tuning run',
  offer: OFFER,
  units: 4,
  price: 400_000_000n,
  currency: 'USD',
}
const job: SaleContent = {
  ...service,
  category: 'compute-job',
  item: 'fine-tuning',
  offer: null,
  units: 1,
}
const invalid = 'message.invalid'

describe("a sale's content", () => {
  it('is a service from an offer version, or one job from none', () => {
    expect(saleContentProblem(service)).toBeNull()
    expect(saleContentProblem(job)).toBeNull()
    expect(saleContentProblem({ ...service, offer: null })).toBe(invalid)
    expect(saleContentProblem({ ...service, offer: `0x${'00'.repeat(32)}` })).toBe(invalid)
    expect(saleContentProblem({ ...service, offer: `0x${'0F'.repeat(32)}` })).toBe(invalid)
    expect(saleContentProblem({ ...job, offer: OFFER })).toBe(invalid)
    expect(saleContentProblem({ ...job, units: 2 })).toBe(invalid)
  })

  it('names the buyer by its id and the item in plain text, since a person signs on them', () => {
    for (const buyer of ['', 'biz buyer', "acme, that passed Avow's simulated business check"]) {
      expect(saleContentProblem({ ...service, buyer })).toBe(invalid)
    }
    for (const item of ['', 'Run\nTotal: $1', 'Run\u202e', ' Run']) {
      expect(saleContentProblem({ ...service, item })).toBe(invalid)
    }
  })

  it('holds a whole number of units, a price above zero and nothing else', () => {
    for (const change of [
      { units: 0 },
      { units: 1.5 },
      { units: 4n },
      { price: 0n },
      { price: 400_000_000 },
      { price: 2n ** 256n },
      { currency: 'EUR' },
      { category: 'goods' },
      { note: 'and a second sale' },
    ]) {
      expect(saleContentProblem({ ...service, ...change } as never)).toBe(invalid)
    }
    const { currency: _, ...missing } = service
    expect(saleContentProblem(missing as never)).toBe(invalid)
  })

  it('never throws, whatever it is given', () => {
    const trap = new Proxy(
      { ...service },
      {
        get: () => {
          throw new Error('read')
        },
      },
    )
    for (const value of [null, undefined, 'sale', 7, [], trap]) {
      expect(saleContentProblem(value as never)).toBe(invalid)
      expect(coversSale(value as never, service)).toBe(false)
      expect(coversSale(service, value as never)).toBe(false)
    }
  })
})

describe('an approved sale', () => {
  it('covers exactly the sale approved, whatever order its parts are written in', () => {
    expect(coversSale(service, { ...service })).toBe(true)
    const { buyer, ...rest } = service
    expect(coversSale(service, { ...rest, buyer })).toBe(true)
    expect(coversSale(job, { ...job })).toBe(true)
  })

  it('covers no other sale, and nothing without an approval', () => {
    for (const change of [
      { buyer: 'biz_other' },
      { item: 'Bulk eval' },
      { offer: `0x${'1f'.repeat(32)}` as const },
      { units: 3 },
      { price: service.price + 1n },
    ]) {
      expect(coversSale(service, { ...service, ...change })).toBe(false)
    }
    expect(coversSale(service, job)).toBe(false)
    expect(coversSale(null, service)).toBe(false)
  })
})
