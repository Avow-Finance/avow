import {
  type BuyerSideReference,
  checkSectionDisclosure,
  type DeliveryReport,
  digestOf,
  JOB_CATEGORY,
  type JobOffer,
  parseQuoteRequest,
  parseSectionDisclosure,
  quoteTermsProblem,
  type RequestKey,
  SIMULATED_RESULT_LABEL,
  type SupplierProfile,
  TEST_CUSTOMER_LABEL,
  type TestCustomerProfile,
  termsAgreementTypedData,
  termsHash,
  testnetDemoJobTerms,
  testnetDemoTerms,
  toWire,
} from '@avow-finance/spec'
import { type Address, recoverAddress } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import { AvowApiError } from '../http.js'
import { id, NOW, START } from '../test/fixture.js'
import { connectTestCustomer, TestCustomerError } from './customer.js'
import { quoteJob } from './quote.js'

const ARBITER: Address = '0x000000000000000000000000000000000000a4b1'
const CUSTOMER_LOCK: Address = '0x00000000000000000000000000000000000010c4'
const ORDER = 'a1'.repeat(16)
const signer = privateKeyToAccount(generatePrivateKey())
const signingKey: RequestKey = {
  address: signer.address,
  signDigest: (hash) => signer.sign({ hash }),
}
const supplier: SupplierProfile = {
  businessId: 'biz_developer',
  account: '0x00000000000000000000000000000000000de7e1',
  payee: '0x00000000000000000000000000000000000de7e1',
  signingKey: signer.address,
}
const profile: TestCustomerProfile = {
  label: TEST_CUSTOMER_LABEL,
  businessId: 'biz_test_customer',
  account: '0x00000000000000000000000000000000000c0571',
  lock: CUSTOMER_LOCK,
  chainId: 42431,
  mandateHash: id('the customer mandate'),
  limits: { reserve: 25_000_000n, price: 100_000_000n, openOrders: 2 },
}
const offer: JobOffer = {
  orderId: ORDER,
  commitmentId: id('the job'),
  customer: { label: TEST_CUSTOMER_LABEL, businessId: profile.businessId },
  supplierBusinessId: supplier.businessId,
  terms: testnetDemoJobTerms(START, ARBITER),
  requirement: { template: 'gpu-reservation/1', condition: 'accepted', disclosed: 'subject' },
  expiry: NOW + 300n,
}
const computeTerms = testnetDemoTerms(START, ARBITER)
const computeSalt = `0x${'77'.repeat(32)}` as const
const compute = {
  reference: {
    kind: 'commitment',
    chainId: 42431,
    lock: supplier.account,
    commitmentId: id('the compute'),
    side: 'buyer',
    termsHash: termsHash(computeTerms, computeSalt),
  } satisfies BuyerSideReference,
  terms: computeTerms,
  salt: computeSalt,
}
const overJson = (value: unknown) => JSON.parse(JSON.stringify(toWire(value)))

describe('quoting a job', () => {
  it('adds the compute booking to the offer’s terms and signs the agreement with the signing key', async () => {
    const quote = await quoteJob({
      offer,
      customer: profile,
      supplier,
      signingKey,
      compute,
      expiry: NOW + 300n,
    })
    expect(quoteTermsProblem(offer.terms, quote.terms)).toBeNull()
    expect('dependencies' in quote.terms && quote.terms.dependencies[0]?.on).toEqual(
      compute.reference,
    )
    expect(quote.agreement).toMatchObject({
      commitmentId: offer.commitmentId,
      termsHash: termsHash(quote.terms, quote.salt),
      category: JOB_CATEGORY,
      buyerBusinessId: profile.businessId,
      supplierBusinessId: supplier.businessId,
      mandateHash: profile.mandateHash,
      expiry: NOW + 300n,
    })
    const domain = { chainId: profile.chainId, verifyingContract: CUSTOMER_LOCK }
    const digest = digestOf(termsAgreementTypedData(quote.agreement, domain))
    const who = await recoverAddress({ hash: digest, signature: quote.supplierSignature })
    expect(who).toBe(signer.address)
    // The customer reads the quote off the wire, and the shown subject hashes to the booking's.
    expect(parseQuoteRequest(overJson(quote))).toEqual({ ok: true, value: quote })
    const shown = parseSectionDisclosure(overJson(quote.disclosed[0]))
    if (!shown.ok) throw new Error(shown.reason)
    expect(checkSectionDisclosure(shown.value, compute.reference.termsHash)).toBeNull()
  })

  it('quotes the offer’s terms alone when the business booked no compute', async () => {
    const quote = await quoteJob({
      offer,
      customer: profile,
      supplier,
      signingKey,
      compute: null,
      expiry: NOW + 300n,
    })
    expect(quote.terms).toEqual(offer.terms)
    expect(quote.disclosed).toEqual([])
  })

  it('refuses a key other than the supplier’s signing key', async () => {
    const other = privateKeyToAccount(generatePrivateKey())
    const key = {
      address: other.address,
      signDigest: (hash: `0x${string}`) => other.sign({ hash }),
    }
    await expect(
      quoteJob({
        offer,
        customer: profile,
        supplier,
        signingKey: key,
        compute,
        expiry: NOW + 300n,
      }),
    ).rejects.toThrow("isn't the supplier's signing key")
  })
})

/** A test customer that answers each route as the spec defines it, recording what it was sent. */
function customerServer(change: { profile?: object; offer?: object } = {}) {
  const sent: { method: string; path: string; authorized: boolean; body: unknown }[] = []
  const reply = (json: unknown, status = 200) =>
    new Response(JSON.stringify(toWire(json)), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  const fetchFake: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    const body = init?.body ? JSON.parse(new TextDecoder().decode(init.body as Uint8Array)) : null
    const headers = new Headers(init?.headers)
    const method = init?.method ?? 'GET'
    sent.push({ method, path: url.pathname, authorized: headers.has('authorization'), body })
    if (url.pathname === '/v1/profile') return reply({ ...profile, ...change.profile })
    if (url.pathname === '/v1/orders') return reply({ ...offer, ...change.offer })
    if (url.pathname === `/v1/orders/${ORDER}`) {
      const { orderId, commitmentId, customer, supplierBusinessId } = offer
      return reply({
        orderId,
        commitmentId,
        customer,
        supplierBusinessId,
        status: 'verifying',
        said: [],
        facts: [],
      })
    }
    if (url.pathname.startsWith(`/v1/orders/${ORDER}/`)) {
      const status = url.pathname.endsWith('/quote') ? 'verifying' : 'delivered'
      return reply({ orderId: ORDER, status }, 202)
    }
    return reply({ error: { reason: 'order.unknown', message: 'No such order' } }, 404)
  }
  const connect = () =>
    connectTestCustomer({
      baseUrl: 'https://customer.test',
      key: signingKey,
      chainId: 42431,
      fetch: fetchFake,
      now: () => NOW,
      retryFor: 0n,
    })
  return { sent, connect }
}

describe('the test customer client', () => {
  it('reads the profile, then signs each POST and reads each answer', async () => {
    const server = customerServer()
    const customer = await server.connect()
    expect(customer.profile).toEqual(profile)
    expect(await customer.order(supplier)).toEqual(offer)
    expect(await customer.state(ORDER)).toMatchObject({ orderId: ORDER, status: 'verifying' })
    const report: DeliveryReport = {
      result: { label: SIMULATED_RESULT_LABEL, hash: id('the placeholder result') },
    }
    expect(await customer.delivery(ORDER, report)).toEqual({ orderId: ORDER, status: 'delivered' })
    expect(server.sent.map((s) => [s.method, s.path, s.authorized])).toEqual([
      ['GET', '/v1/profile', false],
      ['POST', '/v1/orders', true],
      ['GET', `/v1/orders/${ORDER}`, false],
      ['POST', `/v1/orders/${ORDER}/delivery`, true],
    ])
    expect(server.sent[1]?.body).toEqual({ supplier: overJson(supplier) })
    expect(server.sent[3]?.body).toEqual(report)
  })

  it('refuses a customer on another chain, and an offer made to another supplier', async () => {
    await expect(customerServer({ profile: { chainId: 1 } }).connect()).rejects.toThrow('chain 1')
    const customer = await customerServer({ offer: { supplierBusinessId: 'biz_other' } }).connect()
    await expect(customer.order(supplier)).rejects.toBeInstanceOf(AvowApiError)
  })

  it('throws the customer’s refusal of an order it doesn’t have', async () => {
    const customer = await customerServer().connect()
    const other = 'b2'.repeat(16)
    const refusal = await customer.state(other).catch((e: unknown) => e)
    expect(refusal).toBeInstanceOf(TestCustomerError)
    expect(refusal).toMatchObject({ status: 404, reason: 'order.unknown' })
  })
})
