import type { Address } from 'viem'
import { describe, expect, it } from 'vitest'
import { dollars } from './demo.js'
import type { Signed } from './eip712.js'
import { chainedJobTerms, jobTerms } from './job.js'
import { REASON_CODES, type ReasonCode } from './reasons.js'
import {
  buyerFacingReason,
  checkSellerMandate,
  parseSellerMandate,
  type SaleCounterparty,
  type SellerMandate,
  type SellerMandateCheckInput,
  saleFacts,
  sellerMandateHash,
  sellerMandateProblem,
  sellerOfferProblem,
  sellingLimitFor,
} from './seller-mandate.js'
import { type ServiceOfferVersion, serviceOfferTerms } from './service.js'
import { SERVICE_ORDER_CLOCK_SKEW } from './service-order.js'
import {
  ARBITER,
  CHAIN_ID,
  COMPUTE_REFERENCE,
  DOMAIN,
  demoRequest,
  demoSellerMandate,
  id,
  LOCK,
  NOW,
  OTHER_LOCK,
} from './test-helpers.js'
import { toWire } from './wire.js'

const HOUR = 3600n
const DAY = 24n * HOUR
const ACCOUNT: Address = '0x00000000000000000000000000000000000a11ce'
const KEY: Address = '0x0000000000000000000000000000000000005e11'
const OTHER_KEY: Address = '0x0000000000000000000000000000000000005e12'
const settlement = { arbiter: ARBITER, day90SupplierShareBps: 5000 }

const mandate = demoSellerMandate(ACCOUNT, KEY)
const withMandate = (change: Partial<SellerMandate>): SellerMandate => ({ ...mandate, ...change })

/** An offer inside the demo mandate: fine-tuning runs at $50, eight to an order. */
const offer: ServiceOfferVersion = {
  supplier: 'biz_supplier',
  item: { name: 'Fine-tuning run', summary: "One fine-tuning run on the buyer's dataset" },
  currency: 'USD',
  unitPrice: dollars(50),
  rules: {
    evidence: 'The tuned weights are delivered to the buyer',
    leadTime: 2n * DAY,
    maxPerBooking: 8,
    dailyCapacity: 5,
    freeCancelWindow: 2n * HOUR,
    lateCancellationBps: 2_000,
    noShowBps: 5_000,
    payment: { route: 'transfer', dueAfterDelivery: 7n * DAY },
  },
}
const withOffer = (
  change: Partial<Omit<ServiceOfferVersion, 'rules'>>,
  rules: Partial<ServiceOfferVersion['rules']> = {},
): ServiceOfferVersion => ({ ...offer, ...change, rules: { ...offer.rules, ...rules } })

const sale = (version = offer, units = 2, builtAt = NOW) =>
  serviceOfferTerms(version, units, builtAt, settlement)

const buyer: SaleCounterparty = {
  businessId: 'biz_buyer',
  country: 'JP',
  passedBusinessCheck: true,
}

const check = (change: Partial<SellerMandateCheckInput> = {}) =>
  checkSellerMandate({
    mandate,
    signingKey: KEY,
    terms: sale(),
    buyer,
    ledger: { unitsToday: 0, outstanding: 0n },
    revoked: false,
    now: NOW,
    ...change,
  })
const denied = (reason: ReasonCode) => ({ result: 'denied', reason })

/** A fine-tuning job at a price, starting in an hour. */
const job = (price = dollars(120), kind = 'fine-tuning') =>
  jobTerms({
    work: { kind, summary: "Fine-tune a small model on the buyer's dataset" },
    compute: { gpu: 'H100', count: 1, region: 'demo' },
    currency: 'USD',
    startsAt: NOW + HOUR,
    deliverBy: NOW + 3n * HOUR,
    price,
    lateCancellation: (price * 2n) / 10n,
    noShow: price / 2n,
    gracePeriod: 600n,
    chargeDeadline: NOW + 4n * HOUR,
    contestWindow: 600n,
    releaseDate: NOW + 4n * HOUR,
    ...settlement,
  })

describe("the seller's mandate check", () => {
  it('approves a sale inside every limit', () => {
    expect(check()).toEqual({ result: 'approved', reason: 'approved' })
  })

  it('hands a sale above the approval amount to a person, and every sale when the rule says always', () => {
    const human = { result: 'needs_human', reason: 'approval.human_required' }
    // Six runs come to exactly $300, the amount itself, which the agent may still agree.
    expect(check({ terms: sale(offer, 6) }).result).toBe('approved')
    expect(check({ terms: sale(offer, 7) })).toEqual(human)
    expect(check({ mandate: withMandate({ approvalRule: { kind: 'always' } }) })).toEqual(human)
    const never = withMandate({ approvalRule: { kind: 'never' } })
    expect(check({ mandate: never, terms: sale(offer, 8) }).result).toBe('approved')
  })

  it("refuses a mandate that is malformed, expired, revoked or another key's", () => {
    expect(check({ mandate: withMandate({ limits: [] }) })).toEqual(
      denied('seller_mandate.invalid'),
    )
    expect(check({ now: mandate.expiry, terms: sale(offer, 2, mandate.expiry) })).toEqual(
      denied('seller_mandate.expired'),
    )
    expect(check({ revoked: true })).toEqual(denied('seller_mandate.revoked'))
    expect(check({ signingKey: OTHER_KEY })).toEqual(denied('seller_mandate.key_mismatch'))
  })

  it("reads an item's own line before its category's line for every other item", () => {
    // Fine-tuning runs have a $40 floor of their own, so the category's $5 floor never applies.
    expect(check({ terms: sale(withOffer({ unitPrice: dollars(39) })) })).toEqual(
      denied('seller_mandate.under_price_floor'),
    )
    const other = withOffer({
      item: { name: 'Eval run', summary: 'One evaluation run' },
      unitPrice: dollars(5),
    })
    expect(check({ terms: sale(other) }).result).toBe('approved')
    // The line for every other service takes four units an order, where fine-tuning takes eight.
    expect(check({ terms: sale(other, 5) })).toEqual(denied('seller_mandate.over_units_per_order'))
    expect(sellingLimitFor(mandate, 'service', 'Eval run')?.item).toBeNull()
    expect(sellingLimitFor(mandate, 'compute-job', 'inference')).toBeNull()
  })

  it('refuses an item the mandate has no line for', () => {
    const [named] = mandate.limits
    if (!named) throw new Error('the demo mandate has limits')
    const other = withOffer({ item: { name: 'Eval run', summary: 'One evaluation run' } })
    expect(check({ mandate: withMandate({ limits: [named] }), terms: sale(other) })).toEqual(
      denied('seller_mandate.item_not_allowed'),
    )
  })

  it('holds the price floor to the whole price over the units, and an order to its most', () => {
    expect(check({ terms: sale(withOffer({ unitPrice: dollars(40) })) }).result).toBe('approved')
    const cheap = withMandate({ maxOrderValue: dollars(99), maxOutstanding: dollars(99) })
    expect(check({ mandate: cheap })).toEqual(denied('seller_mandate.over_order_value'))
    const wide = withOffer({}, { maxPerBooking: 10 })
    // Nine runs at $50 are within $450, and over the eight an order takes.
    const roomy = withMandate({ maxOrderValue: dollars(450) })
    expect(check({ terms: sale(wide, 9), mandate: roomy })).toEqual(
      denied('seller_mandate.over_units_per_order'),
    )
  })

  it("refuses another currency than the mandate's", () => {
    const terms = { ...sale(), currency: 'EUR' as never }
    expect(check({ terms })).toEqual(denied('seller_mandate.currency_not_allowed'))
  })

  it("counts the delivery horizon and free cancellation from now, with the order clock's skew to spare", () => {
    const atHorizon = withOffer({}, { leadTime: 7n * DAY })
    expect(check({ terms: sale(atHorizon) }).result).toBe('approved')
    expect(check({ terms: sale(atHorizon, 2, NOW + SERVICE_ORDER_CLOCK_SKEW) }).result).toBe(
      'approved',
    )
    expect(check({ terms: sale(atHorizon, 2, NOW + SERVICE_ORDER_CLOCK_SKEW + 1n) })).toEqual(
      denied('seller_mandate.over_delivery_horizon'),
    )
    const longFree = withOffer({}, { freeCancelWindow: DAY + SERVICE_ORDER_CLOCK_SKEW + 1n })
    expect(check({ terms: sale(longFree) })).toEqual(denied('seller_mandate.charges_not_allowed'))
    expect(check({ terms: sale(withOffer({}, { freeCancelWindow: DAY })) }).result).toBe('approved')
  })

  it("refuses a charge under the mandate's lowest", () => {
    for (const rules of [{ lateCancellationBps: 1_999 }, { noShowBps: 4_999 }]) {
      expect(check({ terms: sale(withOffer({}, rules)) })).toEqual(
        denied('seller_mandate.charges_not_allowed'),
      )
    }
    // A charge the terms leave out is no charge, which a floor above zero refuses.
    expect(check({ terms: sale(withOffer({}, { lateCancellationBps: 0 })) })).toEqual(
      denied('seller_mandate.charges_not_allowed'),
    )
  })

  it("refuses a buyer the mandate's counterparty rules exclude", () => {
    const refused = denied('counterparty.not_eligible')
    expect(check({ buyer: { ...buyer, businessId: 'biz_blocked' } })).toEqual(refused)
    const only = withMandate({ buyers: ['biz_friend'] })
    expect(check({ mandate: only })).toEqual(refused)
    expect(check({ mandate: only, buyer: { ...buyer, businessId: 'biz_friend' } }).result).toBe(
      'approved',
    )
    const noKp = withMandate({ excludedCountries: ['KP'] })
    expect(check({ mandate: noKp }).result).toBe('approved')
    expect(check({ mandate: noKp, buyer: { ...buyer, country: 'KP' } })).toEqual(refused)
    // A policy that excludes countries can't pass a buyer whose country nobody knows.
    expect(check({ mandate: noKp, buyer: { ...buyer, country: null } })).toEqual(refused)
    expect(check({ buyer: { ...buyer, country: null } }).result).toBe('approved')
    const checked = withMandate({ requiresBusinessCheck: true })
    expect(check({ mandate: checked }).result).toBe('approved')
    expect(check({ mandate: checked, buyer: { ...buyer, passedBusinessCheck: false } })).toEqual(
      refused,
    )
  })

  it("counts what the ledger already holds against the day's units and what is outstanding", () => {
    expect(check({ ledger: { unitsToday: 18, outstanding: 0n } }).result).toBe('approved')
    expect(check({ ledger: { unitsToday: 19, outstanding: 0n } })).toEqual(
      denied('seller_mandate.over_daily_units'),
    )
    expect(check({ ledger: { unitsToday: 0, outstanding: dollars(1900) } }).result).toBe('approved')
    expect(check({ ledger: { unitsToday: 0, outstanding: dollars(1901) } })).toEqual(
      denied('seller_mandate.over_outstanding'),
    )
  })

  it("reads a job as one unit at the job's price, in version 2 or version 3 terms", () => {
    expect(check({ terms: job() }).result).toBe('approved')
    const chained = chainedJobTerms(job(), [
      { on: COMPUTE_REFERENCE, condition: 'accepted', disclosed: 'subject' },
    ])
    expect(check({ terms: chained }).result).toBe('approved')
    expect(saleFacts(chained)).toEqual({
      ok: true,
      value: {
        category: 'compute-job',
        item: 'fine-tuning',
        units: 1,
        price: dollars(120),
        deliverBy: NOW + 3n * HOUR,
      },
    })
    expect(check({ terms: job(dollars(99)) })).toEqual(denied('seller_mandate.under_price_floor'))
    expect(check({ terms: job(dollars(120), 'inference') })).toEqual(
      denied('seller_mandate.item_not_allowed'),
    )
    // The line takes three jobs a day.
    expect(check({ terms: job(), ledger: { unitsToday: 3, outstanding: 0n } })).toEqual(
      denied('seller_mandate.over_daily_units'),
    )
  })

  it("covers services and jobs only, and gives a template's own reason for terms it refuses", () => {
    expect(check({ terms: demoRequest(KEY).terms })).toEqual(
      denied('seller_mandate.template_not_covered'),
    )
    const terms = sale()
    const broken = { ...terms, subject: { ...terms.subject, quantity: 0 } }
    expect(check({ terms: broken })).toEqual(denied('terms.template_invalid'))
  })
})

describe("listing an offer under a seller's mandate", () => {
  const problem = (version = offer, change: Partial<SellerMandate> = {}) =>
    sellerOfferProblem({
      mandate: withMandate(change),
      signingKey: KEY,
      version,
      revoked: false,
      now: NOW,
    })

  it('lets the agent list an offer inside the mandate', () => {
    expect(problem()).toBeNull()
    expect(problem(withOffer({}, { leadTime: 7n * DAY, freeCancelWindow: DAY }))).toBeNull()
  })

  it('refuses each way an offer goes past the mandate', () => {
    const cases: [ServiceOfferVersion, ReasonCode][] = [
      [withOffer({ unitPrice: dollars(39) }), 'seller_mandate.under_price_floor'],
      [withOffer({ unitPrice: dollars(501) }), 'seller_mandate.over_order_value'],
      [withOffer({}, { maxPerBooking: 9 }), 'seller_mandate.over_units_per_order'],
      [withOffer({}, { leadTime: 7n * DAY + 1n }), 'seller_mandate.over_delivery_horizon'],
      [withOffer({}, { lateCancellationBps: 1_999 }), 'seller_mandate.charges_not_allowed'],
      [withOffer({}, { noShowBps: 4_999 }), 'seller_mandate.charges_not_allowed'],
      [withOffer({}, { freeCancelWindow: DAY + 1n }), 'seller_mandate.charges_not_allowed'],
      [withOffer({ supplier: 'biz_other' }), 'message.invalid'],
      [withOffer({ unitPrice: 0n }), 'message.invalid'],
    ]
    for (const [version, reason] of cases) expect(problem(version)).toBe(reason)
    const [named] = mandate.limits
    if (!named) throw new Error('the demo mandate has limits')
    const other = withOffer({ item: { name: 'Eval run', summary: 'One evaluation run' } })
    expect(problem(other, { limits: [named] })).toBe('seller_mandate.item_not_allowed')
  })

  it("refuses every listing once the mandate has ended, is revoked or is another key's", () => {
    const listing = { mandate, signingKey: KEY, version: offer, revoked: false, now: NOW }
    expect(sellerOfferProblem({ ...listing, now: mandate.expiry })).toBe('seller_mandate.expired')
    expect(sellerOfferProblem({ ...listing, revoked: true })).toBe('seller_mandate.revoked')
    expect(sellerOfferProblem({ ...listing, signingKey: OTHER_KEY })).toBe(
      'seller_mandate.key_mismatch',
    )
  })
})

describe("a well-formed seller's mandate", () => {
  it('passes as the demo writes it', () => {
    expect(sellerMandateProblem(mandate)).toBeNull()
  })

  it('refuses limits that conflict or leave something unsaid', () => {
    const [named, any] = mandate.limits
    if (!named || !any) throw new Error('the demo mandate has limits')
    const changes: Partial<SellerMandate>[] = [
      { businessId: '' },
      { currency: 'EUR' as never },
      { limits: [] },
      { limits: [named, { ...named, minUnitPrice: 1n }] },
      { limits: [any, { ...any }] },
      { limits: [{ ...named, category: 'compute' as never }] },
      { limits: [{ ...named, item: '' }] },
      { limits: [{ ...named, minUnitPrice: -1n }] },
      { limits: [{ ...named, maxUnitsPerOrder: 0 }] },
      { limits: [{ ...named, maxUnitsPerOrder: 1.5 }] },
      { limits: [{ ...named, maxUnitsPerDay: named.maxUnitsPerOrder - 1 }] },
      { limits: [{ ...named, maxUnitsPerDay: 2 ** 32 }] },
      { maxOrderValue: 0n },
      { maxOutstanding: mandate.maxOrderValue - 1n },
      { maxDeliveryHorizon: 0n },
      { maxFreeCancelWindow: -1n },
      { minLateCancellationBps: 10_001 },
      { minNoShowBps: -1 },
      { buyers: ['biz_buyer', 'biz_buyer'] },
      { buyers: ['biz_blocked'] },
      { excludedBuyers: [''] },
      { excludedCountries: ['jp'] },
      { excludedCountries: ['JPN'] },
      { excludedCountries: ['JP', 'JP'] },
      { requiresBusinessCheck: 1 as never },
      { negotiable: ['unitPrice'] },
      { approvalRule: { kind: 'sometimes' } as never },
      { approvalRule: { kind: 'above', amount: -1n } },
      { replaces: `0x${'00'.repeat(32)}` },
      { replaces: `0x${'AB'.repeat(32)}` },
      { replaces: '0x12' },
    ]
    for (const change of changes) {
      expect(sellerMandateProblem(withMandate(change)), JSON.stringify(toWire(change))).toBe(
        'seller_mandate.invalid',
      )
    }
  })

  it('takes a floor of zero, an empty counterparty policy and a mandate it replaces', () => {
    const [named] = mandate.limits
    if (!named) throw new Error('the demo mandate has limits')
    const open = withMandate({
      limits: [{ ...named, minUnitPrice: 0n }],
      excludedBuyers: [],
      minLateCancellationBps: 0,
      minNoShowBps: 0,
      maxFreeCancelWindow: 0n,
      replaces: id('the mandate before'),
    })
    expect(sellerMandateProblem(open)).toBeNull()
  })
})

describe("the signed form of a seller's mandate", () => {
  it("hashes one way, pinned so a change to the signed fields can't pass unseen", () => {
    expect(sellerMandateHash(mandate, DOMAIN)).toBe(
      '0x230906444b556a632e8598ba18147dd19d492741adc59004660c132cf6040764',
    )
  })

  it('changes its hash with any field, the lock or the chain', () => {
    const [named, any, jobs] = mandate.limits
    if (!named || !any || !jobs) throw new Error('the demo mandate has limits')
    const changes: Partial<SellerMandate>[] = [
      { mandateId: id('seller-mandate-2') },
      { businessId: 'biz_other' },
      { account: OTHER_KEY },
      { signingKey: OTHER_KEY },
      { limits: [named, any] },
      { limits: [{ ...named, item: null }, { ...any, item: 'Fine-tuning run' }, jobs] },
      { limits: [{ ...named, minUnitPrice: named.minUnitPrice - 1n }, any, jobs] },
      { limits: [{ ...named, maxUnitsPerOrder: 7 }, any, jobs] },
      { limits: [{ ...named, maxUnitsPerDay: 21 }, any, jobs] },
      { maxOrderValue: mandate.maxOrderValue + 1n },
      { maxOutstanding: mandate.maxOutstanding + 1n },
      { maxDeliveryHorizon: mandate.maxDeliveryHorizon + 1n },
      { minLateCancellationBps: 1_999 },
      { minNoShowBps: 4_999 },
      { maxFreeCancelWindow: mandate.maxFreeCancelWindow + 1n },
      { buyers: ['biz_friend'] },
      { excludedBuyers: [] },
      { excludedCountries: ['KP'] },
      { requiresBusinessCheck: true },
      { approvalRule: { kind: 'above', amount: dollars(301) } },
      { approvalRule: { kind: 'always' } },
      { expiry: mandate.expiry + 1n },
      { nonce: 2n },
      { replaces: id('the mandate before') },
    ]
    const hash = sellerMandateHash(mandate, DOMAIN)
    const hashes = changes.map((change) => sellerMandateHash(withMandate(change), DOMAIN))
    expect(new Set([hash, ...hashes]).size).toBe(changes.length + 1)
    expect(sellerMandateHash(mandate, { ...DOMAIN, verifyingContract: OTHER_LOCK })).not.toBe(hash)
    expect(sellerMandateHash(mandate, { ...DOMAIN, chainId: CHAIN_ID + 1 })).not.toBe(hash)
  })

  const signed: Signed<SellerMandate> = {
    type: 'SellerMandate',
    schemaVersion: '1',
    chainId: CHAIN_ID,
    lock: LOCK,
    message: mandate,
    signature: '0x1234',
  }
  const wire = (value: unknown = signed) => JSON.parse(JSON.stringify(toWire(value)))
  const expected = { chainId: CHAIN_ID, lock: LOCK }

  it('reads back from JSON as it was written', () => {
    expect(parseSellerMandate(wire(), expected)).toEqual({ ok: true, value: signed })
    const replacing = { ...signed, message: withMandate({ replaces: id('the mandate before') }) }
    expect(parseSellerMandate(wire(replacing), expected)).toEqual({ ok: true, value: replacing })
  })

  it("refuses another chain, lock, type or version, a field it doesn't know and a malformed mandate", () => {
    const reason = (json: unknown) => {
      const read = parseSellerMandate(json, expected)
      return read.ok ? null : read.reason
    }
    expect(reason({ ...wire(), chainId: CHAIN_ID + 1 })).toBe('message.wrong_chain')
    expect(reason({ ...wire(), lock: OTHER_LOCK })).toBe('message.wrong_contract')
    expect(reason({ ...wire(), type: 'Mandate' })).toBe('message.schema_unknown')
    expect(reason({ ...wire(), schemaVersion: '2' })).toBe('message.schema_unknown')
    expect(reason({ ...wire(), message: { ...wire().message, weeklyBudget: '1' } })).toBe(
      'message.invalid',
    )
    expect(reason({ ...wire(), message: { ...wire().message, negotiable: ['unitPrice'] } })).toBe(
      'seller_mandate.invalid',
    )
  })
})

describe("what a buyer hears of a seller's limits", () => {
  it("turns every reason about the seller's mandate into one that names no limit", () => {
    const codes = Object.keys(REASON_CODES) as ReasonCode[]
    const aboutLimits = codes.filter((code) => code.startsWith('seller_mandate.'))
    expect(aboutLimits.length).toBeGreaterThan(10)
    for (const code of aboutLimits) expect(buyerFacingReason(code)).toBe('supplier.not_authorized')
  })

  it('passes any other reason through', () => {
    for (const code of [
      'counterparty.not_eligible',
      'approval.human_required',
      'approved',
    ] as const) {
      expect(buyerFacingReason(code)).toBe(code)
    }
  })
})
