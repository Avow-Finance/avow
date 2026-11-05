import { describe, expect, it } from 'vitest'
import { dollars, testnetDemoJobTerms } from './demo.js'
import { chainedJobTerms, JOB_CATEGORY } from './job.js'
import { discloseSection } from './terms.js'
import {
  type JobOffer,
  type OrderState,
  orderSignerProblem,
  parseJobOffer,
  parseOrderAnswer,
  parseOrderRequest,
  parseOrderState,
  parseQuoteRequest,
  parseTestCustomerProfile,
  type QuoteRequest,
  quoteTermsProblem,
  TEST_CUSTOMER_LABEL,
  TEST_CUSTOMER_PATHS,
  type TestCustomerProfile,
} from './test-customer.js'
import {
  ARBITER,
  CHAIN_ID,
  COMPUTE_REFERENCE,
  id,
  JOB_EVENTS,
  JOB_REFERENCE,
  LOCK,
  ORDER,
  OTHER_LOCK,
  PAYEE,
  READ_BLOCK,
  SALT,
  START,
} from './test-helpers.js'
import { toWire } from './wire.js'

const overJson = (value: unknown) => JSON.parse(JSON.stringify(toWire(value)))
const customer = { label: TEST_CUSTOMER_LABEL, businessId: 'biz_test_customer' } as const
const job = testnetDemoJobTerms(START, ARBITER)
const chained = chainedJobTerms(job, [
  { on: COMPUTE_REFERENCE, condition: 'accepted', disclosed: 'subject' },
])

const profile: TestCustomerProfile = {
  ...customer,
  account: '0x00000000000000000000000000000000000c0571',
  lock: OTHER_LOCK,
  chainId: CHAIN_ID,
  mandateHash: id('the customer mandate'),
  limits: { reserve: dollars(25), price: dollars(100), openOrders: 2 },
}

const offer: JobOffer = {
  orderId: ORDER,
  commitmentId: JOB_REFERENCE.commitmentId,
  customer,
  supplierBusinessId: 'biz_developer',
  terms: job,
  requirement: { template: 'gpu-reservation/1', condition: 'accepted', disclosed: 'subject' },
  expiry: START - 300n,
}

const quote: QuoteRequest = {
  terms: chained,
  salt: SALT,
  agreement: {
    commitmentId: JOB_REFERENCE.commitmentId,
    termsHash: JOB_REFERENCE.termsHash,
    category: JOB_CATEGORY,
    buyerBusinessId: customer.businessId,
    supplierBusinessId: 'biz_developer',
    mandateHash: profile.mandateHash,
    nonce: 7n,
    expiry: START - 300n,
  },
  supplierSignature: `0x${'1b'.repeat(65)}`,
  disclosed: [overJson(discloseSection(job, SALT, 'subject'))],
}

const reserve = { reference: JOB_REFERENCE, amount: dollars(10) }
const checks = [{ on: COMPUTE_REFERENCE, block: READ_BLOCK }]
const paid = JOB_EVENTS.find((e) => e.type === 'job_paid')
if (paid?.type !== 'job_paid') throw new Error('The fixtures have a payment')
const order = {
  orderId: ORDER,
  commitmentId: JOB_REFERENCE.commitmentId,
  customer,
  supplierBusinessId: 'biz_developer',
}

/** Where an order stands at each status. */
const states: OrderState[] = [
  { ...order, status: 'offered' },
  { ...order, status: 'verifying' },
  {
    ...order,
    status: 'refused',
    refusal: { code: 'dependency.required', layer: 'customer', block: null, index: null },
    checks: [],
  },
  { ...order, status: 'reserved', checks, reserve },
  { ...order, status: 'accepted', checks, reserve },
  { ...order, status: 'delivered', checks, reserve },
  { ...order, status: 'paid', checks, reserve, payment: paid.payment },
]

describe('the test customer’s routes', () => {
  it('name each order by its id, and refuse anything else in a path', () => {
    expect(TEST_CUSTOMER_PATHS.profile).toBe('/v1/profile')
    expect(TEST_CUSTOMER_PATHS.orders).toBe('/v1/orders')
    expect(TEST_CUSTOMER_PATHS.order(ORDER)).toBe(`/v1/orders/${ORDER}`)
    expect(TEST_CUSTOMER_PATHS.quote(ORDER)).toBe(`/v1/orders/${ORDER}/quote`)
    expect(TEST_CUSTOMER_PATHS.delivery(ORDER)).toBe(`/v1/orders/${ORDER}/delivery`)
    for (const bad of ['', ORDER.toUpperCase(), `${ORDER}/..`, '../profile']) {
      expect(() => TEST_CUSTOMER_PATHS.quote(bad), bad).toThrow(RangeError)
    }
  })

  it('read back the profile, the order request, the offer and the quote as they went out', () => {
    expect(parseTestCustomerProfile(overJson(profile))).toEqual({ ok: true, value: profile })
    const supplier = {
      businessId: 'biz_developer',
      account: LOCK,
      payee: PAYEE,
      signingKey: '0x000000000000000000000000000000000000519e',
    }
    expect(parseOrderRequest(overJson({ supplier }))).toEqual({ ok: true, value: { supplier } })
    expect(parseJobOffer(overJson(offer))).toEqual({ ok: true, value: offer })
    expect(parseQuoteRequest(overJson(quote))).toEqual({ ok: true, value: quote })
    // A quote whose terms name no compute still reads, so the customer can refuse it by reason.
    const bare = { ...quote, terms: job, disclosed: [] }
    expect(parseQuoteRequest(overJson(bare))).toEqual({ ok: true, value: bare })
  })

  it('label the customer as Avow’s test customer and nothing else', () => {
    const relabelled = { ...profile, label: 'A customer' }
    expect(parseTestCustomerProfile(overJson(relabelled)).ok).toBe(false)
    expect(parseJobOffer(overJson({ ...offer, customer: { ...customer, label: 'Acme' } })).ok).toBe(
      false,
    )
  })

  it('read every status of an order back exactly, with nothing a status doesn’t carry', () => {
    for (const state of states) {
      expect(parseOrderState(overJson(state)), state.status).toEqual({ ok: true, value: state })
    }
    const refused = { ...order, status: 'refused', checks: [] }
    expect(parseOrderState(overJson(refused)).ok).toBe(false)
    const reservedPaid = { ...order, status: 'reserved', checks, reserve, payment: paid.payment }
    expect(parseOrderState(overJson(reservedPaid)).ok).toBe(false)
    const unpaid = { ...order, status: 'paid', checks, reserve }
    expect(parseOrderState(overJson(unpaid)).ok).toBe(false)
  })

  it('take a quote or a delivery report only from the supplier the order was offered to', () => {
    const key = '0x000000000000000000000000000000000000519e' as const
    const registered = { businessId: order.supplierBusinessId, signingKey: key }
    expect(
      orderSignerProblem(order, registered, '0x000000000000000000000000000000000000519E'),
    ).toBeNull()
    expect(
      orderSignerProblem(order, registered, '0x000000000000000000000000000000000000beef'),
    ).toBe('order.supplier_mismatch')
    // Another supplier's own registered key, signing as itself, can't act on this order.
    const another = { businessId: 'biz_another', signingKey: key }
    expect(orderSignerProblem(order, another, key)).toBe('order.supplier_mismatch')
    const unbound = { ...order, status: 'offered' }
    const { supplierBusinessId: _, ...anyone } = unbound
    expect(parseOrderState(overJson(anyone)).ok).toBe(false)
  })

  it('take a quote whose terms only add the compute the job relies on', () => {
    expect(quoteTermsProblem(job, chained)).toBeNull()
    expect(quoteTermsProblem(job, job)).toBeNull()
    const pricier = { ...job, consideration: { kind: 'fixed', amount: dollars(41) } } as const
    expect(quoteTermsProblem(job, chainedJobTerms(pricier, chained.dependencies))).toBe(
      'order.terms_changed',
    )
    const later = { ...job.subject, deliverBy: job.subject.deliverBy + 1n }
    expect(quoteTermsProblem(job, { ...job, subject: later })).toBe('order.terms_changed')
  })

  it('answer a quote and a delivery report with where the order moved', () => {
    for (const status of ['verifying', 'delivered'] as const) {
      expect(parseOrderAnswer({ orderId: ORDER, status })).toEqual({
        ok: true,
        value: { orderId: ORDER, status },
      })
    }
    expect(parseOrderAnswer({ orderId: ORDER, status: 'paid' }).ok).toBe(false)
  })
})
