import { type Address, type Hex, keccak256, stringToHex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { dollars, testnetDemoTerms } from './demo.js'
import type { BuyerSideReference, PinnedBlock } from './dependencies.js'
import type { AvowDomain } from './eip712.js'
import type { GpuReservationTerms } from './gpu-reservation.js'
import type { JobEvent } from './job-session.js'
import type { RailToken } from './rail.js'
import { TEST_CUSTOMER_LABEL } from './test-customer.js'
import type { Mandate, ReserveRequest } from './types.js'

/** Shared test setup. Keys are generated for each run and never leave memory. */

export const CHAIN_ID = 42431
export const START = 1_800_000_000n
/** An hour before the window starts. */
export const NOW = START - 3600n
export const LOCK: Address = '0x00000000000000000000000000000000000010c4'
export const OTHER_LOCK: Address = '0x00000000000000000000000000000000000010c5'
export const PAYEE: Address = '0x000000000000000000000000000000000000beef'
/** The fallback arbiter the test terms name. */
export const ARBITER: Address = '0x000000000000000000000000000000000000a4b1'
export const TOKEN: RailToken = {
  rail: 'tempo',
  chainId: CHAIN_ID,
  token: '0x20c0000000000000000000000000000000000001',
  currency: 'USD',
  decimals: 6,
}
export const DOMAIN: AvowDomain = { chainId: CHAIN_ID, verifyingContract: LOCK }

export function newKey() {
  return privateKeyToAccount(generatePrivateKey())
}

export function id(label: string): Hex {
  return keccak256(stringToHex(label))
}

export function demoMandate(account: Address, agentKey: Address): Mandate {
  return {
    mandateId: id('mandate-1'),
    businessId: 'biz_buyer',
    agentId: 'agt_1',
    account,
    agentKey,
    actions: ['reserve', 'cancel', 'start'],
    currency: 'USD',
    capPerCommitment: dollars(1000),
    capOpenReserves: dollars(2000),
    suppliers: ['biz_supplier'],
    categories: ['compute'],
    paymentLimits: [{ token: TOKEN.token, amount: dollars(5000), period: 86_400n }],
    approvalRule: { kind: 'above', amount: dollars(800) },
    expiry: START + 30n * 86_400n,
    nonce: 1n,
  }
}

/** A reserve request under the demo's version 2 terms. */
export function demoRequest(agentKey: Address): ReserveRequest & { terms: GpuReservationTerms } {
  return {
    commitmentId: id('commitment-1'),
    agentKey,
    supplier: 'biz_supplier',
    payee: PAYEE,
    category: 'compute',
    terms: testnetDemoTerms(START, ARBITER),
  }
}

/** A commitment's salt, which the tests share. */
export const SALT = `0x${'55'.repeat(32)}` as const

/** An order id, as the test customer gives one. */
export const ORDER = 'a1'.repeat(16)

/** The job commitment, on the buyer side of the test customer's lock. */
export const JOB_REFERENCE: BuyerSideReference = {
  kind: 'commitment',
  chainId: CHAIN_ID,
  lock: OTHER_LOCK,
  commitmentId: id('the job'),
  side: 'buyer',
  termsHash: id('the job terms'),
}

/** The compute booking the job relies on, on the buyer side of the developer's lock. */
export const COMPUTE_REFERENCE: BuyerSideReference = {
  kind: 'commitment',
  chainId: CHAIN_ID,
  lock: LOCK,
  commitmentId: id('the compute'),
  side: 'buyer',
  termsHash: id('the compute terms'),
}

/** A block a check read at, finalized two seconds before the tests' clock. */
export const READ_BLOCK: PinnedBlock = {
  number: 4321n,
  hash: id('block 4321'),
  timestamp: NOW - 2n,
}

/** One event of each job type, in the order a job that runs to the end posts them. */
export const JOB_EVENTS: JobEvent[] = (() => {
  const base = { run: 2, source: 'script', orderId: ORDER } as const
  const checks = [{ on: COMPUTE_REFERENCE, block: READ_BLOCK }]
  return [
    {
      ...base,
      type: 'job_order_received',
      customer: { label: TEST_CUSTOMER_LABEL, businessId: 'biz_test_customer' },
      work: { kind: 'fine-tuning', summary: 'Fine-tune a small model on the demo dataset' },
      price: dollars(40),
      deliverBy: START + 1800n,
      requirement: { template: 'gpu-reservation/1', condition: 'accepted', disclosed: 'subject' },
    },
    {
      ...base,
      type: 'job_compute_secured',
      reference: COMPUTE_REFERENCE,
      supplier: 'avow-demo-gpu',
      amount: dollars(5),
      freeCancelBy: NOW - 30n,
      releaseDate: START + 7200n,
    },
    {
      ...base,
      type: 'job_quote_sent',
      termsHash: JOB_REFERENCE.termsHash,
      compute: COMPUTE_REFERENCE,
      price: dollars(40),
    },
    { ...base, type: 'job_customer_verifying' },
    { ...base, type: 'job_customer_verified', checks },
    {
      ...base,
      type: 'job_customer_refused',
      refusal: { code: 'dependency.cancellable', layer: 'customer', block: READ_BLOCK, index: 0 },
    },
    {
      ...base,
      type: 'job_commitment_checked',
      reference: JOB_REFERENCE,
      amount: dollars(10),
      charges: [
        { kind: 'lateCancellation', amount: dollars(10) },
        { kind: 'noShow', amount: dollars(6) },
      ],
      releaseDate: START + 7200n,
      checks,
      acceptedIn: { transactionHash: id('the acceptance'), blockNumber: 4325n },
    },
    {
      ...base,
      type: 'job_commitment_refused',
      code: 'approval.parties_mismatch',
      layer: 'service',
      block: null,
      index: null,
    },
    { ...base, type: 'job_work_started', reference: JOB_REFERENCE },
    { ...base, type: 'job_delivered', reference: JOB_REFERENCE },
    {
      ...base,
      type: 'job_paid',
      payment: {
        kind: 'payment',
        chainId: CHAIN_ID,
        transactionHash: id('the payment'),
        logIndex: 3,
        token: TOKEN.token,
        from: '0x00000000000000000000000000000000000c0571',
        to: PAYEE,
        amount: dollars(40),
        memo: JOB_REFERENCE.commitmentId,
      },
    },
    {
      ...base,
      type: 'job_reserve_released',
      role: 'compute',
      reference: COMPUTE_REFERENCE,
      release: { way: 'consent', reason: 'kept' },
      transactionHash: id('the compute release'),
    },
  ]
})()
