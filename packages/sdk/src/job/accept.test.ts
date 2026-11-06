import {
  type Approval,
  acceptanceTypedData,
  approvalDigest,
  approvalTypedData,
  chainedJobTerms,
  digestOf,
  discloseSection,
  dollars,
  gpuReservationTerms,
  lockTerms,
  type Mandate,
  MESSAGE_VERSIONS,
  mandateHash,
  type PinnedBlock,
  type QuoteRequest,
  type RailState,
  type SupplierAuthorization,
  type SupplierAuthorizationAnswer,
  supplierAuthorizationTypedData,
  TEST_CUSTOMER_LABEL,
  TESTNET_DEMO_PROFILE,
  type TestCustomerProfile,
  termsHash,
  testnetDemoJobTerms,
  toWire,
} from '@avow-finance/spec'
import {
  type AcceptanceConfig,
  acceptCall,
  type LockedBacking,
  MemoryChain,
  type PinnedLockReader,
  prepareAcceptance,
} from '@avow-finance/verifier'
import { type Address, type Hex, isAddressEqual, recoverAddress } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import { AvowApiError } from '../http.js'
import { SendError } from '../send.js'
import { accountSigner, signMandate } from '../sign.js'
import { ARBITER, id, NOW, START, TOKEN } from '../test/fixture.js'
import { acceptanceSendRefusal, acceptJob, type JobAcceptanceDeps } from './accept.js'

/*
 * A job as the developer's business quoted it: one H100 for ten minutes of fine-tuning, relying on
 * eight H100s the business booked from a GPU cloud in its own lock. Avow's test customer funded its
 * reserve for the job under Avow's approval, which names the developer's account and signing key.
 * Every key is made for the run and held only in memory.
 */

const avow = privateKeyToAccount(generatePrivateKey())
const customerRoot = privateKeyToAccount(generatePrivateKey())
const customerAgent = privateKeyToAccount(generatePrivateKey())
/** The developer's business account, whose lock holds its compute booking. */
const developer = privateKeyToAccount(generatePrivateKey())
/** The developer's signing key, which Avow registered for the business as a supplier. */
const signer = privateKeyToAccount(generatePrivateKey())
const gpuCloud = privateKeyToAccount(generatePrivateKey()).address

const CHAIN_ID = 42431
const CUSTOMER_LOCK: Address = '0x00000000000000000000000000000000000010c4'
const DEVELOPER_LOCK: Address = '0x00000000000000000000000000000000000010c6'
const FACTORY: Address = '0x00000000000000000000000000000000000fac01'
const CUSTOMER_DOMAIN = { chainId: CHAIN_ID, verifyingContract: CUSTOMER_LOCK }
const KEY_TX = id('the customer authorized its agent key')
/** The finalized block the compute is read at, two seconds before the tests' clock. */
const PINNED: PinnedBlock = { number: 4321n, hash: id('block 4321'), timestamp: NOW - 2n }

const computeTerms = gpuReservationTerms({
  resource: { gpu: 'H100', count: 8, region: 'demo', sku: 'demo-h100x8' },
  currency: 'USD',
  windowStart: START,
  windowDuration: 3600n,
  pricePerGpuHour: dollars(2),
  freeCancelBy: NOW - 600n,
  lateCancellation: dollars(100),
  noShow: dollars(100),
  gracePeriod: 120n,
  chargeDeadline: START + 3600n,
  contestWindow: 600n,
  releaseDate: START + 3600n,
  arbiter: ARBITER,
  day90SupplierShareBps: 5000,
})
const COMPUTE_SALT: Hex = `0x${'77'.repeat(32)}`
const computeOn = {
  kind: 'commitment',
  chainId: CHAIN_ID,
  lock: DEVELOPER_LOCK,
  commitmentId: id('the developer books its compute'),
  side: 'buyer',
  termsHash: termsHash(computeTerms, COMPUTE_SALT),
} as const

const jobTerms = chainedJobTerms(testnetDemoJobTerms(START, ARBITER), [
  { on: computeOn, condition: 'accepted', disclosed: 'subject' },
])
const SALT: Hex = `0x${'42'.repeat(32)}`
const JOB = id('the job')
const JOB_HASH = termsHash(jobTerms, SALT)

const mandate: Mandate = {
  mandateId: id('the customer mandate'),
  businessId: 'biz_test_customer',
  agentId: 'agt_test_customer',
  account: customerRoot.address,
  agentKey: customerAgent.address,
  actions: ['reserve'],
  currency: 'USD',
  capPerCommitment: dollars(25),
  capOpenReserves: dollars(50),
  suppliers: ['biz_developer'],
  categories: ['compute-job'],
  paymentLimits: [{ token: TOKEN.token, amount: dollars(500), period: 86_400n }],
  approvalRule: { kind: 'never' },
  expiry: START + 30n * 86_400n,
  nonce: 1n,
}
const mHash = mandateHash(mandate, CUSTOMER_DOMAIN)

const customer: TestCustomerProfile = {
  label: TEST_CUSTOMER_LABEL,
  businessId: mandate.businessId,
  account: customerRoot.address,
  lock: CUSTOMER_LOCK,
  chainId: CHAIN_ID,
  mandateHash: mHash,
  limits: { reserve: dollars(25), price: dollars(100), openOrders: 2 },
}

const agreed = {
  commitmentId: JOB,
  termsHash: JOB_HASH,
  category: 'compute-job',
  buyerBusinessId: customer.businessId,
  mandateHash: mHash,
}

const quote: QuoteRequest = {
  terms: jobTerms,
  salt: SALT,
  agreement: { ...agreed, supplierBusinessId: 'biz_developer', nonce: 1n, expiry: NOW + 300n },
  supplierSignature: '0x',
  disclosed: [toWire(discloseSection(computeTerms, COMPUTE_SALT, 'subject'))],
}

const config: AcceptanceConfig = {
  chainId: CHAIN_ID,
  avowKeys: [avow.address],
  businessId: 'biz_developer',
  payee: developer.address,
  acceptedTokens: [TOKEN],
  profile: TESTNET_DEMO_PROFILE,
  acceptTestData: true,
  account: developer.address,
  signingKey: signer.address,
}

/** Avow's approval of the customer's reserve, as the API builds it from the terms and mandate. */
const approval: Approval = {
  commitmentId: JOB,
  token: TOKEN.token,
  ...lockTerms(jobTerms, TOKEN.decimals),
  supplier: developer.address,
  supplierSigner: signer.address,
  payee: developer.address,
  termsHash: JOB_HASH,
  mandateHash: mHash,
  capPerCommitment: mandate.capPerCommitment,
  capOpenReserves: mandate.capOpenReserves,
  fundingKey: customerAgent.address,
  nonce: 1n,
  expiry: NOW + 120n,
}

const authorization: SupplierAuthorization = {
  commitmentId: JOB,
  termsHash: JOB_HASH,
  salt: SALT,
  amount: approval.amount,
  token: TOKEN.token,
  buyerBusinessId: customer.businessId,
  kybReference: 'mock-kyb-1',
  kybTestData: true,
  agentKey: customerAgent.address,
  agentKeyAuthorizedIn: KEY_TX,
  mandateHash: mHash,
  payee: developer.address,
  acceptBy: approval.acceptBy,
  chargeDeadline: approval.chargeDeadline,
  releaseDate: approval.releaseDate,
  nonce: 1n,
  expiry: NOW + 300n,
}

/** Avow's answer for the customer's commitment, signed as the API signs it. */
async function authorized(): Promise<Extract<SupplierAuthorizationAnswer, { ok: true }>> {
  const envelope = { chainId: CHAIN_ID, lock: CUSTOMER_LOCK }
  return {
    ok: true,
    authorization: {
      type: 'SupplierAuthorization',
      schemaVersion: MESSAGE_VERSIONS.SupplierAuthorization,
      ...envelope,
      message: authorization,
      signature: await avow.sign({
        hash: digestOf(supplierAuthorizationTypedData(authorization, CUSTOMER_DOMAIN)),
      }),
    },
    approval: {
      type: 'Approval',
      schemaVersion: MESSAGE_VERSIONS.Approval,
      ...envelope,
      message: approval,
      signature: await avow.sign({ hash: digestOf(approvalTypedData(approval, CUSTOMER_DOMAIN)) }),
    },
    mandate: await signMandate(
      mandate,
      CUSTOMER_DOMAIN,
      accountSigner(customerRoot.address, customerRoot),
    ),
  }
}

/** The customer's commitment as its lock holds it, reserved under the approval by default. */
function onLock(state: RailState = 'reserved', change: Partial<LockedBacking> = {}): LockedBacking {
  return {
    state,
    token: approval.token,
    amount: approval.amount,
    held: approval.amount,
    payee: approval.payee,
    supplier: approval.supplier,
    supplierSigner: approval.supplierSigner,
    freeCancelBy: approval.freeCancelBy,
    acceptBy: approval.acceptBy,
    chargeDeadline: approval.chargeDeadline,
    contestWindow: approval.contestWindow,
    releaseDate: approval.releaseDate,
    charges: approval.charges,
    day90SupplierShareBps: approval.day90SupplierShareBps,
    arbiter: approval.arbiter,
    termsHash: approval.termsHash,
    mandateHash: approval.mandateHash,
    approvalHash: approvalDigest(approval, CUSTOMER_DOMAIN),
    fundingKey: approval.fundingKey,
    reportCount: 0,
    reportKind: null,
    reportAmount: 0n,
    hasReport: false,
    contested: false,
    chargeStart: 0n,
    pausedAt: 0n,
    hasRuling: false,
    ...change,
  }
}

/** The developer's lock as a finalized block shows it, holding the compute in the given state. */
function developerLock(compute: RailState): PinnedLockReader {
  return {
    chainId: CHAIN_ID,
    factory: FACTORY,
    head: async () => PINNED,
    blockHash: async (n) => (n === PINNED.number ? PINNED.hash : null),
    isLock: async (lock) => isAddressEqual(lock, DEVELOPER_LOCK),
    lockFields: async () => ({ factory: FACTORY, account: developer.address }),
    commitment: async (lock, commitmentId, side) =>
      isAddressEqual(lock, DEVELOPER_LOCK) &&
      commitmentId === computeOn.commitmentId &&
      side === 'buyer'
        ? {
            state: compute,
            hasReport: false,
            termsHash: computeOn.termsHash,
            supplier: gpuCloud,
            freeCancelBy: NOW - 600n,
          }
        : null,
  }
}

/**
 * The developer's side of the job, with the customer's commitment on its lock as `job` holds it and
 * the compute in its state. Its sender records each call, and with `onSend` it does what the chain
 * does while the call is on its way, or throws as the sender would.
 */
function developerSide(
  change: {
    job?: LockedBacking
    compute?: RailState
    answer?: () => Promise<SupplierAuthorizationAnswer>
    onSend?: (chain: MemoryChain) => void
  } = {},
) {
  const chain = new MemoryChain(CHAIN_ID)
  chain.setLock(CUSTOMER_LOCK, {
    fromFactory: true,
    account: customerRoot.address,
    token: TOKEN.token,
    timing: TESTNET_DEMO_PROFILE.lockTiming,
  })
  chain.setBacking(CUSTOMER_LOCK, JOB, 'buyer', change.job ?? onLock())
  chain.setAgentKey(
    customerRoot.address,
    customerAgent.address,
    { active: true, expiry: null, witness: mHash },
    KEY_TX,
  )
  const asked: unknown[] = []
  const sent: { to: Address; data: Hex }[] = []
  const deps: JobAcceptanceDeps = {
    config,
    chain,
    dependencies: { readers: [developerLock(change.compute ?? 'accepted')] },
    authorize: async (c) => {
      asked.push(c)
      return (change.answer ?? authorized)()
    },
    signingKey: signer,
    send: async (call) => {
      sent.push(call)
      change.onSend?.(chain)
      return { transactionHash: id('the acceptance'), blockNumber: 4325n }
    },
    now: () => NOW,
  }
  return { deps, chain, asked, sent }
}

const refused = (
  code: string,
  layer: string,
  block: PinnedBlock | null = null,
  index: number | null = null,
) => ({ ok: false, code, layer, block, index })

/** The commitment found accepted, with the compute read again at the pinned block. */
const foundAccepted = { ok: true, sent: null, checks: [{ on: computeOn, block: PINNED }] }

/** A send whose transaction landed and reverted. */
const reverted = () =>
  new SendError(`The transaction ${id('tx')} reverted`, 'failed', {
    hashes: [id('tx')],
    signings: 1,
  })

describe('accepting a job’s commitment', () => {
  it('accepts once every check passes, signed by the registered key and sent to the customer’s lock', async () => {
    const side = developerSide()
    const result = await acceptJob(side.deps, { customer, quote })
    if (!result.ok || !result.sent) throw new Error('the commitment was not accepted')
    const { acceptance, disclosureId, landed } = result.sent
    expect(side.asked).toEqual([{ chainId: CHAIN_ID, lock: CUSTOMER_LOCK, commitmentId: JOB }])
    expect(acceptance.message).toMatchObject({
      commitmentId: JOB,
      side: 'buyer',
      approvalHash: approvalDigest(approval, CUSTOMER_DOMAIN),
      termsHash: JOB_HASH,
      amount: approval.amount,
    })
    // The signing key Avow registered for the business signed it.
    const digest = digestOf(acceptanceTypedData(acceptance.message, CUSTOMER_DOMAIN))
    const by = await recoverAddress({ hash: digest, signature: acceptance.signature })
    expect(isAddressEqual(by, signer.address)).toBe(true)
    // The disclosure it confirmed is the one the verifier shows for exactly this acceptance.
    const answer = await authorized()
    const shown = await prepareAcceptance(
      {
        authorization: toWire(answer.authorization),
        approval: toWire(answer.approval),
        mandate: toWire(answer.mandate),
        agreed,
        terms: jobTerms,
        disclosed: quote.disclosed,
        now: NOW,
        nonce: acceptance.message.nonce,
      },
      side.deps,
    )
    expect(shown.ok && shown.disclosure.id).toBe(disclosureId)
    // It went to the customer's lock, once, as acceptCall builds it.
    expect(side.sent).toEqual([acceptCall(acceptance)])
    expect(side.sent[0]?.to).toBe(CUSTOMER_LOCK)
    expect(landed).toEqual({ transactionHash: id('the acceptance'), blockNumber: 4325n })
    expect(result.checks).toEqual([{ on: computeOn, block: PINNED }])
  })

  it('names Avow when it has nothing to authorize, and sends nothing', async () => {
    const side = developerSide({
      answer: async () => ({ ok: false, reason: 'chain.reserve_missing' }),
    })
    expect(await acceptJob(side.deps, { customer, quote })).toEqual(
      refused('chain.reserve_missing', 'avow'),
    )
    expect(side.sent).toEqual([])
  })

  it('names Avow when its API refuses the request outright, and throws when no answer came', async () => {
    const refusal = new AvowApiError('refused', {
      status: 403,
      reason: 'request.signer_unknown',
      requestId: id('request'),
      definite: true,
    })
    const refusing = developerSide({
      answer: async () => {
        throw refusal
      },
    })
    expect(await acceptJob(refusing.deps, { customer, quote })).toEqual(
      refused('request.signer_unknown', 'avow'),
    )
    const silent = developerSide({
      answer: async () => {
        throw new AvowApiError('no answer', {
          status: 0,
          reason: null,
          requestId: id('request'),
          definite: false,
        })
      },
    })
    await expect(acceptJob(silent.deps, { customer, quote })).rejects.toThrow('no answer')
    expect([...refusing.sent, ...silent.sent]).toEqual([])
  })

  it('names the service when its checks refuse, with the compute booking that failed and its block', async () => {
    const side = developerSide({ compute: 'reserved' })
    expect(await acceptJob(side.deps, { customer, quote })).toEqual(
      refused('dependency.not_accepted', 'service', PINNED, 0),
    )
    const other = developerSide({
      answer: async () => ({ ...(await authorized()), approval: { not: 'an approval' } as never }),
    })
    expect(await acceptJob(other.deps, { customer, quote })).toEqual(
      refused('message.invalid', 'service'),
    )
    expect([...side.sent, ...other.sent]).toEqual([])
  })
})

describe('a commitment the lock already shows accepted', () => {
  it('counts as accepted under the business’s signing key, with the compute read again', async () => {
    // Avow sees the acceptance an earlier call sent, whose send gave no answer.
    const toldByAvow = developerSide({
      job: onLock('accepted'),
      answer: async () => ({ ok: false, reason: 'chain.reserve_accepted' }),
    })
    expect(await acceptJob(toldByAvow.deps, { customer, quote })).toEqual(foundAccepted)
    // Avow authorized it first, and the service's own check reads it accepted.
    const readByService = developerSide({ job: onLock('accepted') })
    expect(await acceptJob(readByService.deps, { customer, quote })).toEqual(foundAccepted)
    expect([...toldByAvow.sent, ...readByService.sent]).toEqual([])
  })

  it('counts as accepted when a second acceptance reverts because the first one landed', async () => {
    const side = developerSide({
      onSend: (chain) => {
        chain.setBacking(CUSTOMER_LOCK, JOB, 'buyer', onLock('accepted'))
        throw reverted()
      },
    })
    expect(await acceptJob(side.deps, { customer, quote })).toEqual(foundAccepted)
    expect(side.sent).toHaveLength(1)
  })

  it('stays refused under another signing key or other terms, or while the lock shows it reserved', async () => {
    const accepted = async () => ({ ok: false, reason: 'chain.reserve_accepted' }) as const
    const others = [
      onLock('accepted', { supplierSigner: privateKeyToAccount(generatePrivateKey()).address }),
      onLock('accepted', { termsHash: id('other terms') }),
      onLock('reserved'),
    ]
    for (const job of others) {
      const side = developerSide({ job, answer: accepted })
      expect(await acceptJob(side.deps, { customer, quote })).toEqual(
        refused('chain.reserve_accepted', 'avow'),
      )
    }
    const stillReserved = developerSide({
      onSend: () => {
        throw reverted()
      },
    })
    expect(await acceptJob(stillReserved.deps, { customer, quote })).toEqual(
      refused('chain.acceptance_reverted', 'lock'),
    )
  })

  it('throws when the compute no longer stands, since an accepted commitment can’t be refused', async () => {
    const side = developerSide({
      job: onLock('accepted'),
      compute: 'released',
      answer: async () => ({ ok: false, reason: 'chain.reserve_accepted' }),
    })
    await expect(acceptJob(side.deps, { customer, quote })).rejects.toThrow(
      `The customer's lock shows commitment ${JOB} accepted under your signing key, but the compute booking it relies on doesn't stand at block 4321`,
    )
  })
})

describe('an acceptance refused on its way to the lock', () => {
  const sent = { hashes: [id('tx')], signings: 1 }

  it('is the lock’s when its transaction landed and reverted', () => {
    expect(acceptanceSendRefusal(reverted())).toEqual({
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
