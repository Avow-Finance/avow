import { describe, expect, it } from 'vitest'
import { dollars, testnetDemoJobTerms } from './demo.js'
import { chainedJobTerms, JOB_CATEGORY } from './job.js'
import { discloseSection } from './terms.js'
import {
  type JobOffer,
  type OrderState,
  orderSignerProblem,
  parseDeliveryReport,
  parseJobOffer,
  parseOrderAnswer,
  parseOrderRequest,
  parseOrderState,
  parseQuoteRequest,
  parseTestCustomerProfile,
  type QuoteRequest,
  quoteTermsProblem,
  SIMULATED_RESULT_LABEL,
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

const FUNDED_IN = `0x${'f0'.repeat(32)}` as const
const reserve = { reference: JOB_REFERENCE, amount: dollars(10), fundedIn: FUNDED_IN }
const checks = [{ on: COMPUTE_REFERENCE, block: READ_BLOCK }]
const paid = JOB_EVENTS.find((e) => e.type === 'job_paid')
if (paid?.type !== 'job_paid') throw new Error('The fixtures have a payment')
const order = {
  orderId: ORDER,
  commitmentId: JOB_REFERENCE.commitmentId,
  customer,
  supplierBusinessId: 'biz_developer',
  said: [{ index: 0, text: 'Before I accept, I need to verify the compute you rely on.' }],
  facts: [
    {
      index: 0,
      text: 'Your compute booking was accepted and past its free cancellation.',
      check: 'dependency' as const,
      verifiedBy: 'customer' as const,
      reference: COMPUTE_REFERENCE,
      block: READ_BLOCK,
      transactionHash: null,
    },
  ],
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
  { ...order, status: 'cancelled', checks, reserve, cancellation: { cancelledAt: 1_800_000_010n } },
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
    // An order can be asked to go one named way, and no other.
    const cancels = { supplier, scenario: 'cancels_late' as const }
    expect(parseOrderRequest(overJson(cancels))).toEqual({ ok: true, value: cancels })
    expect(parseOrderRequest(overJson({ supplier, scenario: 'never_pays' })).ok).toBe(false)
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
    // A cancelled order says when, and an accepted one never carries a cancellation.
    const undated = { ...order, status: 'cancelled', checks, reserve }
    expect(parseOrderState(overJson(undated)).ok).toBe(false)
    const both = {
      ...order,
      status: 'accepted',
      checks,
      reserve,
      cancellation: { cancelledAt: 1n },
    }
    expect(parseOrderState(overJson(both)).ok).toBe(false)
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

  it('number the customer’s messages and facts from 0 in order, so each is posted once', () => {
    const skipped = { ...order, status: 'offered', said: [{ index: 1, text: 'Hello' }] }
    expect(parseOrderState(overJson(skipped)).ok).toBe(false)
    const twice = { ...order, status: 'offered', facts: [order.facts[0], order.facts[0]] }
    expect(parseOrderState(overJson(twice)).ok).toBe(false)
    // A fact the customer states is the customer's, and names its block and reference.
    const avows = {
      ...order,
      status: 'offered',
      facts: [{ ...order.facts[0], verifiedBy: 'avow' }],
    }
    expect(parseOrderState(overJson(avows)).ok).toBe(false)
    const unbound = { ...order, status: 'offered', facts: [{ ...order.facts[0], block: null }] }
    expect(parseOrderState(overJson(unbound)).ok).toBe(false)
  })

  it('take a delivery report that hands over a labelled result with its hash', () => {
    const report = {
      result: { label: SIMULATED_RESULT_LABEL, hash: `0x${'ab'.repeat(32)}` },
    }
    expect(parseDeliveryReport(overJson(report))).toEqual({ ok: true, value: report })
    expect(parseDeliveryReport({}).ok).toBe(false)
    // Only the one plain label, which says the result is simulated.
    const real = { result: { label: 'Fine-tuned model', hash: report.result.hash } }
    expect(parseDeliveryReport(real).ok).toBe(false)
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
