import {
  type Approval,
  approvalTypedData,
  digestOf,
  type Mandate,
  mandateHash,
  mandateTypedData,
  type SupplierAuthorization,
  signForAccount,
  supplierAuthorizationTypedData,
  TESTNET_DEMO_PROFILE,
  termsCharges,
  termsHash,
  testnetDemoTerms,
  toWire,
} from '@avow-finance/spec'
import {
  type Address,
  concatHex,
  createClient,
  custom,
  decodeFunctionData,
  encodeFunctionResult,
  type Hex,
  isAddressEqual,
  keccak256,
  stringToHex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import { type AcceptanceConfig, prepareAcceptance, signAcceptance } from './accept.js'
import { type ChainReader, MemoryChain } from './chain.js'
import { prepareReleaseConsent, signReleaseConsent } from './consent.js'
import { FACTORY_ABI, LOCK_ABI } from './lock-abi.js'
import { tempoChainReader } from './tempo.js'

/**
 * One commitment, from the bytes a lock returns for it to the messages the verifier builds. The
 * words below are what a lock at this address on this chain returns from `commitment` once the
 * reserve lands, and again once the acceptance lands. The Tempo reader decodes them, the verifier
 * builds an acceptance and two release consents from them, and the pins hold the messages and
 * signatures. A lock given these messages takes them, so a change to how the reader decodes the
 * lock or how the verifier builds a message fails here. The keys come from public labels and hold
 * nothing.
 */
const key = (role: string) => privateKeyToAccount(keccak256(stringToHex(`vector ${role}`)))
const id = (label: string): Hex => keccak256(stringToHex(label))

const CHAIN_ID = 42431
const LOCK: Address = '0x0000000000000000000000000000000000002510'
const FACTORY: Address = '0x0000000000000000000000000000000000002511'
const ALPHA_USD: Address = '0x20C0000000000000000000000000000000000001'
const START = 1_800_000_000n
const NOW = START - 3600n
const DOMAIN = { chainId: CHAIN_ID, verifyingContract: LOCK }
const KEY_TX = id('vector agent key authorization tx')

const business = key('business root key')
const agent = key('agent key')
const supplierAccount = key('supplier account')
const signingKey = key('supplier signing key')
const payout = key('payout')
const arbiter = key('arbiter')
const approvalKey = key('approval key')
const avowKey = key('avow authorization key')

const terms = testnetDemoTerms(START, arbiter.address)
const SALT = id('vector terms salt')
const COMMITMENT = id('vector commitment')
const TERMS_HASH = termsHash(terms, SALT)
const mandate: Mandate = {
  mandateId: id('vector mandate'),
  businessId: 'biz_vector_buyer',
  agentId: 'agt_vector',
  account: business.address,
  agentKey: agent.address,
  actions: ['reserve'],
  currency: 'USD',
  capPerCommitment: 1_000_000_000n,
  capOpenReserves: 2_000_000_000n,
  suppliers: ['biz_vector_supplier'],
  categories: ['compute'],
  paymentLimits: [{ token: ALPHA_USD, amount: 5_000_000_000n, period: 86_400n }],
  approvalRule: { kind: 'never' },
  expiry: START + 30n * 86_400n,
  nonce: 1n,
}
const MANDATE_HASH = mandateHash(mandate, DOMAIN)
const approval: Approval = {
  commitmentId: COMMITMENT,
  side: 'buyer',
  token: ALPHA_USD,
  amount: 500_000_000n,
  supplier: supplierAccount.address,
  supplierSigner: signingKey.address,
  payee: payout.address,
  freeCancelBy: terms.freeCancelBy,
  acceptBy: terms.acceptBy,
  chargeDeadline: terms.chargeDeadline,
  releaseDate: terms.releaseDate,
  contestWindow: terms.contestWindow,
  charges: termsCharges(terms, 6),
  day90SupplierShareBps: 5000,
  arbiter: arbiter.address,
  termsHash: TERMS_HASH,
  mandateHash: MANDATE_HASH,
  capPerCommitment: 1_000_000_000n,
  capOpenReserves: 2_000_000_000n,
  fundingKey: agent.address,
  nonce: 1n,
  expiry: NOW + 120n,
}

/** The lock's `commitment` once the agent's key reserved under the approval, one word per field. */
const RESERVED = concatHex([
  '0x0000000000000000000000000000000000000000000000000000000000000001', // state
  '0x0000000000000000000000000000000000000000000000000000000000000000', // hasReport
  '0x0000000000000000000000000000000000000000000000000000000000000000', // reportFinal
  '0x0000000000000000000000000000000000000000000000000000000000000000', // confirmed
  '0x0000000000000000000000000000000000000000000000000000000000000000', // contested
  '0x0000000000000000000000000000000000000000000000000000000000000000', // hasRuling
  '0x0000000000000000000000000000000000000000000000000000000000000003', // kinds
  '0x0000000000000000000000000000000000000000000000000000000000000000', // reportKind
  '0x0000000000000000000000000000000000000000000000000000000000000000', // reportCount
  '0x0000000000000000000000000000000000000000000000000000000000000000', // pausedBy
  '0x0000000000000000000000000000000000000000000000000000000000001388', // day90ShareBps
  '0x0000000000000000000000000000000000000000000000000000000000000000', // businessEvidence
  '0x0000000000000000000000000000000000000000000000000000000000000000', // supplierEvidence
  '0x000000000000000000000000000000000000000000000000000000006b49cfa8', // freeCancelBy
  '0x000000000000000000000000000000000000000000000000000000006b49d200', // acceptBy
  '0x000000000000000000000000000000000000000000000000000000006b49d908', // chargeDeadline
  '0x000000000000000000000000000000000000000000000000000000006b49d908', // releaseDate
  '0x0000000000000000000000000000000000000000000000000000000000000258', // contestWindow
  '0x0000000000000000000000000000000000000000000000000000000000000000', // reportDeadline
  '0x0000000000000000000000000000000000000000000000000000000000000000', // chargeStart
  '0x0000000000000000000000000000000000000000000000000000000000000000', // pausedAt
  '0x0000000000000000000000000000000000000000000000000000000000000000', // rulingPostedAt
  '0x0000000000000000000000000000000000000000000000000000000000000000', // reportedAt
  '0x000000000000000000000000000000000000000000000000000000001dcd6500', // amount
  '0x000000000000000000000000000000000000000000000000000000001dcd6500', // held
  '0x0000000000000000000000000000000000000000000000000000000000000000', // reportAmount
  '0x0000000000000000000000000000000000000000000000000000000000000000', // rulingToSupplier
  '0x0000000000000000000000008178a9247bb8a7d3b2c8f2e507942df6051e4ddf', // supplier
  '0x0000000000000000000000004c12507ebf4e499515ea3ccd66661897b2ba12ad', // supplierSigner
  '0x0000000000000000000000000ab1cdf1715cdb0429129ec26cff0c2151394e45', // payout
  '0x000000000000000000000000cc0fc0be0d456acb458ceab279b52c3e2e3f9a42', // arbiter
  '0x0000000000000000000000000000000000000000000000000000000000000000', // rulingByArbiter
  '0x00000000000000000000000087c14c2612d930fc1e5f7048f113d4e9a93d73d2', // fundedBy
  '0x6d09c304058e5913137b18adf4bd0f8a380fe2a9bc9011d88ce0f5a4bbe01d28', // termsHash
  '0xcf3572cb4b045642401859e4e1a779912990db9366d51cd1dcaed5fdee75cdce', // mandateHash
  '0xf80ee3ad8f52801c74dd2f2d431e24e2fe0cf9db19a15df9a475668d8dd23052', // approvalHash
  '0x0000000000000000000000000000000000000000000000000000000000000000', // reportEvidence
  '0x000000000000000000000000000000000000000000000000000000000ee6b280', // most[0]
  '0x000000000000000000000000000000000000000000000000000000001dcd6500', // most[1]
  '0x0000000000000000000000000000000000000000000000000000000000000000', // most[2]
  '0x0000000000000000000000000000000000000000000000000000000000000000', // most[3]
  '0x000000000000000000000000000000000000000000000000000000006b49cfa8', // earliest[0]
  '0x000000000000000000000000000000000000000000000000000000006b49d278', // earliest[1]
  '0x0000000000000000000000000000000000000000000000000000000000000000', // earliest[2]
  '0x0000000000000000000000000000000000000000000000000000000000000000', // earliest[3]
  '0x0000000000000000000000000000000000000000000000000000000000000000', // firstReportAt[0]
  '0x0000000000000000000000000000000000000000000000000000000000000000', // firstReportAt[1]
  '0x0000000000000000000000000000000000000000000000000000000000000000', // firstReportAt[2]
  '0x0000000000000000000000000000000000000000000000000000000000000000', // firstReportAt[3]
])

/** The same, once the supplier's acceptance landed. */
const ACCEPTED = concatHex([
  '0x0000000000000000000000000000000000000000000000000000000000000002', // state
  '0x0000000000000000000000000000000000000000000000000000000000000000', // hasReport
  '0x0000000000000000000000000000000000000000000000000000000000000000', // reportFinal
  '0x0000000000000000000000000000000000000000000000000000000000000000', // confirmed
  '0x0000000000000000000000000000000000000000000000000000000000000000', // contested
  '0x0000000000000000000000000000000000000000000000000000000000000000', // hasRuling
  '0x0000000000000000000000000000000000000000000000000000000000000003', // kinds
  '0x0000000000000000000000000000000000000000000000000000000000000000', // reportKind
  '0x0000000000000000000000000000000000000000000000000000000000000000', // reportCount
  '0x0000000000000000000000000000000000000000000000000000000000000000', // pausedBy
  '0x0000000000000000000000000000000000000000000000000000000000001388', // day90ShareBps
  '0x0000000000000000000000000000000000000000000000000000000000000000', // businessEvidence
  '0x0000000000000000000000000000000000000000000000000000000000000000', // supplierEvidence
  '0x000000000000000000000000000000000000000000000000000000006b49cfa8', // freeCancelBy
  '0x000000000000000000000000000000000000000000000000000000006b49d200', // acceptBy
  '0x000000000000000000000000000000000000000000000000000000006b49d908', // chargeDeadline
  '0x000000000000000000000000000000000000000000000000000000006b49d908', // releaseDate
  '0x0000000000000000000000000000000000000000000000000000000000000258', // contestWindow
  '0x0000000000000000000000000000000000000000000000000000000000000000', // reportDeadline
  '0x0000000000000000000000000000000000000000000000000000000000000000', // chargeStart
  '0x0000000000000000000000000000000000000000000000000000000000000000', // pausedAt
  '0x0000000000000000000000000000000000000000000000000000000000000000', // rulingPostedAt
  '0x0000000000000000000000000000000000000000000000000000000000000000', // reportedAt
  '0x000000000000000000000000000000000000000000000000000000001dcd6500', // amount
  '0x000000000000000000000000000000000000000000000000000000001dcd6500', // held
  '0x0000000000000000000000000000000000000000000000000000000000000000', // reportAmount
  '0x0000000000000000000000000000000000000000000000000000000000000000', // rulingToSupplier
  '0x0000000000000000000000008178a9247bb8a7d3b2c8f2e507942df6051e4ddf', // supplier
  '0x0000000000000000000000004c12507ebf4e499515ea3ccd66661897b2ba12ad', // supplierSigner
  '0x0000000000000000000000000ab1cdf1715cdb0429129ec26cff0c2151394e45', // payout
  '0x000000000000000000000000cc0fc0be0d456acb458ceab279b52c3e2e3f9a42', // arbiter
  '0x0000000000000000000000000000000000000000000000000000000000000000', // rulingByArbiter
  '0x00000000000000000000000087c14c2612d930fc1e5f7048f113d4e9a93d73d2', // fundedBy
  '0x6d09c304058e5913137b18adf4bd0f8a380fe2a9bc9011d88ce0f5a4bbe01d28', // termsHash
  '0xcf3572cb4b045642401859e4e1a779912990db9366d51cd1dcaed5fdee75cdce', // mandateHash
  '0xf80ee3ad8f52801c74dd2f2d431e24e2fe0cf9db19a15df9a475668d8dd23052', // approvalHash
  '0x0000000000000000000000000000000000000000000000000000000000000000', // reportEvidence
  '0x000000000000000000000000000000000000000000000000000000000ee6b280', // most[0]
  '0x000000000000000000000000000000000000000000000000000000001dcd6500', // most[1]
  '0x0000000000000000000000000000000000000000000000000000000000000000', // most[2]
  '0x0000000000000000000000000000000000000000000000000000000000000000', // most[3]
  '0x000000000000000000000000000000000000000000000000000000006b49cfa8', // earliest[0]
  '0x000000000000000000000000000000000000000000000000000000006b49d278', // earliest[1]
  '0x0000000000000000000000000000000000000000000000000000000000000000', // earliest[2]
  '0x0000000000000000000000000000000000000000000000000000000000000000', // earliest[3]
  '0x0000000000000000000000000000000000000000000000000000000000000000', // firstReportAt[0]
  '0x0000000000000000000000000000000000000000000000000000000000000000', // firstReportAt[1]
  '0x0000000000000000000000000000000000000000000000000000000000000000', // firstReportAt[2]
  '0x0000000000000000000000000000000000000000000000000000000000000000', // firstReportAt[3]
])

/** The lock's settings, which a lock at this address returns. */
const VIEWS = {
  factory: FACTORY,
  account: business.address,
  token: ALPHA_USD,
  minContestWindow: 600n,
  confirmWindow: 300n,
  rulingDelay: 300n,
  rulingKeyEnd: 1800n,
  day90: 5400n,
} as const

/** A node that answers the factory's and the lock's views with the bytes a lock returned. */
function node(commitment: Hex) {
  return createClient({
    transport: custom({
      async request({ method, params }) {
        if (method !== 'eth_call') throw new Error(`The test node doesn't answer ${method}`)
        const [{ to, data }] = params as [{ to: Address; data: Hex }]
        if (isAddressEqual(to, FACTORY)) {
          const call = decodeFunctionData({ abi: FACTORY_ABI, data })
          return encodeFunctionResult({
            abi: FACTORY_ABI,
            functionName: call.functionName,
            result: isAddressEqual(call.args[0], LOCK),
          })
        }
        if (!isAddressEqual(to, LOCK)) throw new Error(`No contract at ${to}`)
        const call = decodeFunctionData({ abi: LOCK_ABI, data })
        if (call.functionName === 'commitment') return commitment
        return encodeFunctionResult({
          abi: LOCK_ABI,
          functionName: call.functionName,
          result: VIEWS[call.functionName] as never,
        })
      },
    }),
  })
}

/** The lock read through the Tempo reader, and the keychain from memory. */
function chainOver(commitment: Hex): ChainReader {
  const memory = new MemoryChain(CHAIN_ID)
  memory.setAgentKey(
    business.address,
    agent.address,
    { active: true, expiry: null, witness: MANDATE_HASH },
    KEY_TX,
  )
  const reader = tempoChainReader(node(commitment), { factory: FACTORY, chainId: CHAIN_ID })
  return {
    chainId: CHAIN_ID,
    lock: reader.lock,
    backing: reader.backing,
    agentKey: (...args) => memory.agentKey(...args),
    isAccountSignature: (...args) => memory.isAccountSignature(...args),
  }
}

const json = (value: unknown) => JSON.parse(JSON.stringify(toWire(value)))

async function signed<T>(type: string, message: T, signature: Hex) {
  return json({ type, schemaVersion: '1', chainId: CHAIN_ID, lock: LOCK, message, signature })
}

const config: AcceptanceConfig = {
  chainId: CHAIN_ID,
  avowKeys: [avowKey.address],
  businessId: 'biz_vector_supplier',
  payee: payout.address,
  acceptedTokens: [
    { rail: 'tempo', chainId: CHAIN_ID, token: ALPHA_USD, currency: 'USD', decimals: 6 },
  ],
  profile: TESTNET_DEMO_PROFILE,
  acceptTestData: true,
  account: supplierAccount.address,
  signingKey: signingKey.address,
}

const RESERVED_HASH = '0x5de255933eaf28622e1d925ec8d091c4411f25f57d5ebe340231e51b2852fe3d'
const ACCEPTED_HASH = '0x29ff0f64a54ef41adb5ab9696089de84d6418f267eab92e5f0ffea3392ff3679'
const APPROVAL_DIGEST = '0xf80ee3ad8f52801c74dd2f2d431e24e2fe0cf9db19a15df9a475668d8dd23052'
const ACCEPTANCE_DIGEST = '0x707443cfb18a2bd2791d5c3fb42093b147152c80456ffd0b4e9350fc605c99aa'
const ACCEPTANCE_SIGNATURE =
  '0x33f1634a853ff8b897aba30c5f611bbfa08671ac56f8b5425d3bc0ded448a4cc5c7fa7a6806dbd834d5d6d70aa31126078468f9fdecd1634090db7efd4ce12851b'
const CONSENT_DIGEST = '0x8687081a38c4c6ca855989e989ffa9ebd17970c4c2b0be25234b3fdc733503b4'
const CONSENT_SIGNATURE =
  '0x048178a9247bb8a7d3b2c8f2e507942df6051e4ddf03261bd999cab9dd2d9d50ea9de78fab9830b44ebf0789fcc137b3db3f4d8a11699943fa3b2e9fc6a5fe33cab06fea4de1fdffaf6fe59fe03ec929b25584f7901b'
const ADVANCE_CONSENT_DIGEST = '0xb2162ec5b22b8e14db5fb5890df09b0b8ee8437e420d6c3331399da5964e03ee'
const ADVANCE_CONSENT_SIGNATURE =
  '0x048178a9247bb8a7d3b2c8f2e507942df6051e4ddf85a73bd2f2d3fb730b11130cad0c2d51d263f3d4d51dd5fcc9f06faf7f1a4a6240d4db2a792a01b9e3fb63d488fb963f6d91322622931b55be2d402c64ea85fc1c'

const authorization: SupplierAuthorization = {
  commitmentId: COMMITMENT,
  termsHash: TERMS_HASH,
  salt: SALT,
  amount: 500_000_000n,
  token: ALPHA_USD,
  buyerBusinessId: 'biz_vector_buyer',
  kybReference: 'mock-kyb-vector',
  kybTestData: true,
  agentKey: agent.address,
  agentKeyAuthorizedIn: KEY_TX,
  mandateHash: MANDATE_HASH,
  payee: payout.address,
  acceptBy: terms.acceptBy,
  chargeDeadline: terms.chargeDeadline,
  releaseDate: terms.releaseDate,
  nonce: 1n,
  expiry: NOW + 300n,
}

async function prepare(chain: ChainReader) {
  return prepareAcceptance(
    {
      authorization: await signed(
        'SupplierAuthorization',
        authorization,
        await avowKey.sign({
          hash: digestOf(supplierAuthorizationTypedData(authorization, DOMAIN)),
        }),
      ),
      approval: await signed(
        'Approval',
        approval,
        await approvalKey.sign({ hash: digestOf(approvalTypedData(approval, DOMAIN)) }),
      ),
      mandate: await signed(
        'Mandate',
        mandate,
        await signForAccount(
          business.address,
          digestOf(mandateTypedData(mandate, DOMAIN)),
          business,
        ),
      ),
      agreed: { commitmentId: COMMITMENT, termsHash: TERMS_HASH, category: 'compute' },
      terms,
      now: NOW + 60n,
      nonce: 1n,
    },
    { config, chain },
  )
}

function consent(
  chain: ChainReader,
  reportCount: number | undefined,
  evidence: string,
  nonce: bigint,
) {
  return prepareReleaseConsent(
    {
      lock: LOCK,
      commitmentId: COMMITMENT,
      reason: 'kept',
      evidenceHash: id(evidence),
      ...(reportCount === undefined ? {} : { reportCount }),
      expiry: START + 1800n,
      now: NOW + 120n,
      nonce,
    },
    {
      config: {
        chainId: CHAIN_ID,
        account: supplierAccount.address,
        acceptedTokens: config.acceptedTokens,
      },
      chain,
    },
  )
}

describe("the lock's own bytes, read by the Tempo reader", () => {
  it('decode to the reserve the approval set up, field by field', async () => {
    expect(keccak256(RESERVED)).toBe(RESERVED_HASH)
    const chain = chainOver(RESERVED)
    expect(await chain.lock(LOCK)).toEqual({
      fromFactory: true,
      account: business.address,
      token: ALPHA_USD,
      timing: TESTNET_DEMO_PROFILE.lockTiming,
    })
    expect(await chain.backing(LOCK, COMMITMENT, 'buyer')).toEqual({
      state: 'reserved',
      token: ALPHA_USD,
      amount: 500_000_000n,
      held: 500_000_000n,
      payee: payout.address,
      supplier: supplierAccount.address,
      supplierSigner: signingKey.address,
      freeCancelBy: terms.freeCancelBy,
      acceptBy: terms.acceptBy,
      chargeDeadline: terms.chargeDeadline,
      contestWindow: terms.contestWindow,
      releaseDate: terms.releaseDate,
      charges: termsCharges(terms, 6),
      day90SupplierShareBps: 5000,
      arbiter: arbiter.address,
      termsHash: TERMS_HASH,
      mandateHash: MANDATE_HASH,
      approvalHash: APPROVAL_DIGEST,
      fundingKey: agent.address,
      reportCount: 0,
      hasRuling: false,
    })
  })

  it("read no lock that the pinned factory didn't create", async () => {
    const chain = chainOver(RESERVED)
    expect(await chain.lock('0x0000000000000000000000000000000000002512')).toBeNull()
  })

  it('decode the accepted reserve, which differs only in its state', async () => {
    expect(keccak256(ACCEPTED)).toBe(ACCEPTED_HASH)
    const reserved = await chainOver(RESERVED).backing(LOCK, COMMITMENT, 'buyer')
    expect(await chainOver(ACCEPTED).backing(LOCK, COMMITMENT, 'buyer')).toEqual({
      ...reserved,
      state: 'accepted',
    })
  })
})

describe('the messages the verifier builds from them', () => {
  it('is the acceptance the lock takes, naming the digest the lock stored', async () => {
    const prepared = await prepare(chainOver(RESERVED))
    if (!prepared.ok) throw new Error(prepared.reason)
    const signedAcceptance = await signAcceptance(prepared, signingKey, {
      disclosureId: prepared.disclosure.id,
    })
    expect(signedAcceptance.message).toEqual({
      commitmentId: COMMITMENT,
      side: 'buyer',
      approvalHash: APPROVAL_DIGEST,
      termsHash: TERMS_HASH,
      amount: 500_000_000n,
      token: ALPHA_USD.toLowerCase(),
      acceptBy: START,
      nonce: 1n,
      expiry: NOW + 660n,
    })
    expect(prepared.digest).toBe(ACCEPTANCE_DIGEST)
    expect(signedAcceptance.signature).toBe(ACCEPTANCE_SIGNATURE)
  })

  it('is the release consent for the current count, which the lock takes', async () => {
    const chain = chainOver(ACCEPTED)
    const prepared = await consent(chain, undefined, 'vector job kept', 1n)
    if (!prepared.ok) throw new Error(prepared.reason)
    expect(prepared.consent.reportCount).toBe(0)
    expect(prepared.disclosure.preauthorization).toBeNull()
    const signedConsent = await signReleaseConsent(
      prepared,
      supplierAccount,
      { disclosureId: prepared.disclosure.id },
      { chain },
    )
    expect(prepared.digest).toBe(CONSENT_DIGEST)
    // The envelope writes the account in its checksum case.
    expect(signedConsent.signature.toLowerCase()).toBe(CONSENT_SIGNATURE)
  })

  it('is a consent in advance only once the signer confirms the preauthorization', async () => {
    const chain = chainOver(ACCEPTED)
    const prepared = await consent(chain, 1, 'vector consent in advance', 2n)
    if (!prepared.ok) throw new Error(prepared.reason)
    expect(prepared.disclosure.preauthorization).toEqual({ currentCount: 0, consentCount: 1 })
    const confirm = { disclosureId: prepared.disclosure.id }
    await expect(signReleaseConsent(prepared, supplierAccount, confirm, { chain })).rejects.toThrow(
      /preauthorize/,
    )
    const signedConsent = await signReleaseConsent(
      prepared,
      supplierAccount,
      { ...confirm, preauthorize: true },
      { chain },
    )
    expect(prepared.digest).toBe(ADVANCE_CONSENT_DIGEST)
    // The envelope writes the account in its checksum case.
    expect(signedConsent.signature.toLowerCase()).toBe(ADVANCE_CONSENT_SIGNATURE)
  })
})
