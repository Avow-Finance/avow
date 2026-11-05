import {
  chainedJobTerms,
  type QuoteRequest,
  TEST_CUSTOMER_LABEL,
  TESTNET_DEMO_PROFILE,
  type TestCustomerProfile,
  testnetDemoJobTerms,
} from '@avow-finance/spec'
import type { ChainReader } from '@avow-finance/verifier'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import { AvowApiError } from '../http.js'
import { SendError } from '../send.js'
import { id, NOW, START, TOKEN } from '../test/fixture.js'
import { acceptanceSendRefusal, acceptJob, type JobAcceptanceDeps } from './accept.js'

const signer = privateKeyToAccount(generatePrivateKey())
const customer: TestCustomerProfile = {
  label: TEST_CUSTOMER_LABEL,
  businessId: 'biz_test_customer',
  account: '0x00000000000000000000000000000000000c0571',
  lock: '0x00000000000000000000000000000000000010c4',
  chainId: 42431,
  mandateHash: id('the customer mandate'),
  limits: { reserve: 25_000_000n, price: 100_000_000n, openOrders: 2 },
}
const quote: QuoteRequest = {
  terms: chainedJobTerms(testnetDemoJobTerms(START, '0x000000000000000000000000000000000000a4b1'), [
    {
      on: {
        kind: 'commitment',
        chainId: 42431,
        lock: '0x00000000000000000000000000000000000de7e1',
        commitmentId: id('the compute'),
        side: 'buyer',
        termsHash: id('the compute terms'),
      },
      condition: 'accepted',
      disclosed: 'subject',
    },
  ]),
  salt: `0x${'42'.repeat(32)}`,
  agreement: {
    commitmentId: id('the job'),
    termsHash: id('the job terms'),
    category: 'compute-job',
    buyerBusinessId: customer.businessId,
    supplierBusinessId: 'biz_developer',
    mandateHash: customer.mandateHash,
    nonce: 1n,
    expiry: NOW + 300n,
  },
  supplierSignature: '0x',
  disclosed: [],
}

/** Settings that never reach the chain, so only the steps before it run. */
function deps(change: Partial<JobAcceptanceDeps> = {}) {
  const asked: unknown[] = []
  const sent: unknown[] = []
  const d: JobAcceptanceDeps = {
    config: {
      chainId: 42431,
      avowKeys: [privateKeyToAccount(generatePrivateKey()).address],
      businessId: 'biz_developer',
      payee: '0x00000000000000000000000000000000000de7e1',
      acceptedTokens: [TOKEN],
      profile: TESTNET_DEMO_PROFILE,
      acceptTestData: true,
      account: '0x00000000000000000000000000000000000de7e1',
      signingKey: signer.address,
    },
    chain: {} as ChainReader,
    dependencies: { readers: [] },
    authorize: async (c) => {
      asked.push(c)
      return { ok: false, reason: 'chain.reserve_missing' }
    },
    signingKey: signer,
    send: async (call) => {
      sent.push(call)
      return { transactionHash: id('accept'), blockNumber: 1n }
    },
    now: () => NOW,
    ...change,
  }
  return { d, asked, sent }
}

describe('accepting a job’s commitment', () => {
  it('asks Avow for the commitment on the customer’s lock, and names Avow when it has none to authorize', async () => {
    const { d, asked, sent } = deps()
    const result = await acceptJob(d, { customer, quote })
    expect(asked).toEqual([
      { chainId: 42431, lock: customer.lock, commitmentId: quote.agreement.commitmentId },
    ])
    expect(result).toEqual({
      ok: false,
      code: 'chain.reserve_missing',
      layer: 'avow',
      block: null,
      index: null,
    })
    expect(sent).toEqual([])
  })

  it('names Avow when its API refuses the request outright, and throws when no answer came', async () => {
    const refusal = new AvowApiError('refused', {
      status: 403,
      reason: 'request.signer_unknown',
      requestId: id('request'),
      definite: true,
    })
    const refused = deps({
      authorize: async () => {
        throw refusal
      },
    })
    expect(await acceptJob(refused.d, { customer, quote })).toEqual({
      ok: false,
      code: 'request.signer_unknown',
      layer: 'avow',
      block: null,
      index: null,
    })
    const silent = deps({
      authorize: async () => {
        throw new AvowApiError('no answer', {
          status: 0,
          reason: null,
          requestId: id('request'),
          definite: false,
        })
      },
    })
    await expect(acceptJob(silent.d, { customer, quote })).rejects.toThrow('no answer')
    expect([...refused.sent, ...silent.sent]).toEqual([])
  })

  it('sends nothing when the verifier refuses what Avow sent', async () => {
    const { d, sent } = deps({
      authorize: async () => ({
        ok: true,
        authorization: {} as never,
        approval: { not: 'an approval' } as never,
        mandate: {} as never,
      }),
    })
    // The approval names the owner of the compute, so it's read first, and this one doesn't read.
    const result = await acceptJob(d, { customer, quote })
    expect(result).toEqual({
      ok: false,
      code: 'message.invalid',
      layer: 'supplier',
      block: null,
      index: null,
    })
    expect(sent).toEqual([])
  })
})

describe('an acceptance refused on its way to the lock', () => {
  const sent = { hashes: [id('tx')], signings: 1 }

  it('is the lock’s when its transaction landed and reverted', () => {
    const error = new SendError(`The transaction ${id('tx')} reverted`, 'failed', sent)
    expect(acceptanceSendRefusal(error)).toEqual({
      code: 'chain.acceptance_reverted',
      layer: 'lock',
    })
  })

  it('is the relay’s when the relay refused to pay its fee, with the relay’s reason', () => {
    const relay = new AvowApiError('over budget', {
      status: 429,
      reason: 'sponsorship.budget_spent',
      requestId: id('sponsor'),
      definite: true,
    })
    const error = new SendError("The relay didn't co-sign: over budget", 'failed', sent, {
      cause: relay,
    })
    expect(acceptanceSendRefusal(error)).toEqual({
      code: 'sponsorship.budget_spent',
      layer: 'relay',
    })
  })

  it('is nobody’s while the transaction may still have landed', () => {
    const unknown = new SendError('No receipt after waiting', 'unknown', sent)
    expect(acceptanceSendRefusal(unknown)).toBeNull()
    expect(acceptanceSendRefusal(new Error('the node went away'))).toBeNull()
  })
})
