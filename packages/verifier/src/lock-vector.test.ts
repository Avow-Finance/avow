import {
  type Approval,
  approvalTypedData,
  digestOf,
  type Mandate,
  mandateHash,
  mandateTypedData,
  reportTypedData,
  type SupplierAuthorization,
  signForAccount,
  supplierAuthorizationTypedData,
  TESTNET_DEMO_PROFILE,
  termsCharges,
  termsHash,
  testnetDemoTermsV1,
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
  pad,
  stringToHex,
  toHex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import { type AcceptanceConfig, prepareAcceptance, signAcceptance } from './accept.js'
import { type ChainReader, MemoryChain } from './chain.js'
import { prepareReleaseConsent, signReleaseConsent } from './consent.js'
import { FACTORY_ABI, LOCK_ABI } from './lock-abi.js'
import { prepareReport } from './report.js'
import { tempoChainReader } from './tempo.js'

/**
 * One commitment, from the bytes a lock returns for it to the messages the verifier builds. The
 * words below are what a lock at this address on this chain returns from `commitment` once the
 * reserve lands, once the acceptance lands, once a contested charge is confirmed and once a ruling
 * is posted. The Tempo reader decodes them, the verifier builds an acceptance and two release
 * consents from them, and the pins hold the messages and signatures. It builds a report from them
 * too, with its fields taken from the record the reader decoded. A lock given these messages
 * takes them, so a change to how the reader decodes the lock or how the verifier builds a message
 * fails here. The keys come from public labels and hold nothing.
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

// The release date comes after the charge deadline, so a reader that swapped the two would show it.
// These are version 1 terms, and the pins below are the ones version 1 shipped with, so a
// commitment made under version 1 stays verifiable by this verifier.
const terms = { ...testnetDemoTermsV1(START, arbiter.address), releaseDate: START + 2400n }
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
  '0x000000000000000000000000000000000000000000000000000000006b49db60', // releaseDate
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
  '0xf4db49672915b11d002f2d00425de38dc7ecf4f5dc6c069c5c3d484fff6ba137', // termsHash
  '0xcf3572cb4b045642401859e4e1a779912990db9366d51cd1dcaed5fdee75cdce', // mandateHash
  '0x42f5952b6f4467b486b0d1ed8342bc69344ee2f803bdc962e520026f7fbbd24e', // approvalHash
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

/** The words of the lock's `commitment` record, by field, in the lock's order. */
const FIELDS = (
  LOCK_ABI.find((f) => f.name === 'commitment') as {
    outputs: readonly [{ components: readonly { name: string; type: string }[] }]
  }
).outputs[0].components.flatMap((c) =>
  c.type.endsWith('[4]') ? [0, 1, 2, 3].map((i) => `${c.name}[${i}]`) : [c.name],
)

/** A record with some of its words replaced, by field name. */
function withWords(base: Hex, changes: Record<string, bigint | Hex>): Hex {
  const words = FIELDS.map((_, i) => `0x${base.slice(2 + i * 64, 2 + (i + 1) * 64)}` as Hex)
  for (const [field, value] of Object.entries(changes)) {
    const i = FIELDS.indexOf(field)
    if (i < 0) throw new Error(`The record has no field ${field}`)
    words[i] = pad(typeof value === 'bigint' ? toHex(value) : value, { size: 32 })
  }
  return concatHex(words)
}

/** The same record once the supplier's acceptance landed. */
const ACCEPTED = withWords(RESERVED, { state: 2n })

/**
 * Then the supplier reports a $100 late cancellation once free cancellation ends, the business
 * contests a minute later, and Avow confirms a minute after that. The charge is paused, final and
 * confirmed, and the lock holds only the charge.
 */
const CONTESTED = withWords(ACCEPTED, {
  state: 4n,
  hasReport: 1n,
  reportFinal: 1n,
  confirmed: 1n,
  contested: 1n,
  reportCount: 1n,
  pausedBy: 3n,
  reportDeadline: START - 300n,
  pausedAt: START - 540n,
  reportedAt: START - 600n,
  held: 100_000_000n,
  reportAmount: 100_000_000n,
  reportEvidence: id('vector late cancellation'),
  'firstReportAt[0]': START - 600n,
})

/** Then Avow's ruling key gives the supplier $60 of it, a minute after the confirmation. */
const RULED = withWords(CONTESTED, {
  hasRuling: 1n,
  rulingPostedAt: START - 420n,
  rulingToSupplier: 60_000_000n,
})

/**
 * The accepted record just after the same report, open and waiting for Avow, so it stands while
 * nothing has made it final or contested it. Unlike the records above, no lock's own bytes pin this
 * one or the next. They're built from the accepted record by the lock's rules for those steps.
 */
const REPORTED = withWords(ACCEPTED, {
  hasReport: 1n,
  reportCount: 1n,
  reportDeadline: START - 300n,
  reportedAt: START - 600n,
  reportAmount: 100_000_000n,
  reportEvidence: id('vector late cancellation'),
  'firstReportAt[0]': START - 600n,
})

/**
 * Then the business contests it a minute later, and the supplier account withdraws it half a minute
 * after that, before Avow answers. The commitment is accepted again with no report standing, and the
 * contest stays on record.
 */
const WITHDRAWN = withWords(REPORTED, {
  hasReport: 0n,
  contested: 1n,
  pausedBy: 3n,
  pausedAt: START - 540n,
})

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

/**
 * A node that answers the factory's and the lock's views with the bytes a lock returned. It
 * answers only the calls the reader should make, so a reader that asked for another commitment,
 * side or function would fail.
 */
function node(commitment: Hex) {
  return createClient({
    transport: custom({
      async request({ method, params }) {
        if (method !== 'eth_call') throw new Error(`The test node doesn't answer ${method}`)
        const [{ to, data }] = params as [{ to: Address; data: Hex }]
        if (isAddressEqual(to, FACTORY)) {
          const call = decodeFunctionData({ abi: FACTORY_ABI, data })
          if (call.functionName !== 'isLock') {
            throw new Error(`The reader called the factory's ${call.functionName}`)
          }
          return encodeFunctionResult({
            abi: FACTORY_ABI,
            functionName: 'isLock',
            result: isAddressEqual(call.args[0], LOCK),
          })
        }
        if (!isAddressEqual(to, LOCK)) throw new Error(`No contract at ${to}`)
        const call = decodeFunctionData({ abi: LOCK_ABI, data })
        if (call.functionName === 'commitment') {
          const [commitmentId, side] = call.args
          if (commitmentId !== COMMITMENT || side !== 0) {
            throw new Error(`The reader asked for ${commitmentId} on side ${side}`)
          }
          return commitment
        }
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
    transfer: (...args) => memory.transfer(...args),
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

// keccak256 of each record, which the lock's own bytes match.
const RESERVED_HASH = '0xaad41999ade7dc3b5adc841478a3bd1d99fe4653821b902b2f2463e11383559c'
const ACCEPTED_HASH = '0x0e7482703f079b1d97315ed785f54b0721b2c964d0e8146161768b8277199223'
const CONTESTED_HASH = '0x0cca5218290367f0be776d4980613dfead2b2f76f8509682315a658b98412356'
const RULED_HASH = '0x0ecde66501dcc5df9861c94cebb71b28d89a0619aeb06011a27665f88f2ac62d'
const APPROVAL_DIGEST = '0x42f5952b6f4467b486b0d1ed8342bc69344ee2f803bdc962e520026f7fbbd24e'
const ACCEPTANCE_DIGEST = '0xd56ce48b6ff6cb21cfde205ac5be8499ad41bbe2a994ab4b20e1dca0f8663a8e'
const ACCEPTANCE_SIGNATURE =
  '0x6d90e2766a73339b8426adaaf0b233a8f96b8457efca8017d23643abd9c402bf3c37beaab21ac8f18f1a018b88a0c81fc4eda27ee456d6bcf9a3dac5be4f37a61b'
const CONSENT_DIGEST = '0x8687081a38c4c6ca855989e989ffa9ebd17970c4c2b0be25234b3fdc733503b4'
const CONSENT_SIGNATURE =
  '0x048178a9247bb8a7d3b2c8f2e507942df6051e4ddf03261bd999cab9dd2d9d50ea9de78fab9830b44ebf0789fcc137b3db3f4d8a11699943fa3b2e9fc6a5fe33cab06fea4de1fdffaf6fe59fe03ec929b25584f7901b'
const ADVANCE_CONSENT_DIGEST = '0xb2162ec5b22b8e14db5fb5890df09b0b8ee8437e420d6c3331399da5964e03ee'
const ADVANCE_CONSENT_SIGNATURE =
  '0x048178a9247bb8a7d3b2c8f2e507942df6051e4ddf85a73bd2f2d3fb730b11130cad0c2d51d263f3d4d51dd5fcc9f06faf7f1a4a6240d4db2a792a01b9e3fb63d488fb963f6d91322622931b55be2d402c64ea85fc1c'

/** What the reader should decode from the reserved record, field by field. */
const reservedBacking = {
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
  hasReport: false,
  hasRuling: false,
}

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
      agreed: {
        commitmentId: COMMITMENT,
        termsHash: TERMS_HASH,
        category: 'compute',
        buyerBusinessId: 'biz_vector_buyer',
        mandateHash: MANDATE_HASH,
      },
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
  it('match the records a lock returned, step by step', () => {
    expect(keccak256(RESERVED)).toBe(RESERVED_HASH)
    expect(keccak256(ACCEPTED)).toBe(ACCEPTED_HASH)
    expect(keccak256(CONTESTED)).toBe(CONTESTED_HASH)
    expect(keccak256(RULED)).toBe(RULED_HASH)
  })

  it('decode to the reserve the approval set up, field by field', async () => {
    const chain = chainOver(RESERVED)
    expect(await chain.lock(LOCK)).toEqual({
      fromFactory: true,
      account: business.address,
      token: ALPHA_USD,
      timing: TESTNET_DEMO_PROFILE.lockTiming,
    })
    expect(await chain.backing(LOCK, COMMITMENT, 'buyer')).toEqual(reservedBacking)
  })

  it('decode each later step, with the fields that step changed', async () => {
    const read = (record: Hex) => chainOver(record).backing(LOCK, COMMITMENT, 'buyer')
    expect(await read(ACCEPTED)).toEqual({ ...reservedBacking, state: 'accepted' })
    expect(await read(CONTESTED)).toEqual({
      ...reservedBacking,
      state: 'paused',
      held: 100_000_000n,
      reportCount: 1,
      hasReport: true,
    })
    expect(await read(RULED)).toEqual({
      ...reservedBacking,
      state: 'paused',
      held: 100_000_000n,
      reportCount: 1,
      hasReport: true,
      hasRuling: true,
    })
  })

  it('decode whether a report stands apart from whether it is final or contested', async () => {
    const read = (record: Hex) => chainOver(record).backing(LOCK, COMMITMENT, 'buyer')
    // Open, so it stands though nothing has made it final or contested it.
    expect(await read(REPORTED)).toEqual({
      ...reservedBacking,
      state: 'accepted',
      reportCount: 1,
      hasReport: true,
    })
    // Withdrawn, so nothing stands though the contest stays on record.
    expect(await read(WITHDRAWN)).toEqual({
      ...reservedBacking,
      state: 'accepted',
      reportCount: 1,
      hasReport: false,
    })
  })

  it("read no lock that the pinned factory didn't create", async () => {
    expect(await chainOver(RESERVED).lock('0x0000000000000000000000000000000000002512')).toBeNull()
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

  it('builds no acceptance once the reserve is accepted', async () => {
    expect(await prepare(chainOver(ACCEPTED))).toEqual({
      ok: false,
      reason: 'chain.reserve_accepted',
    })
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
    expect(signedConsent.signature.toLowerCase()).toBe(ADVANCE_CONSENT_SIGNATURE)
  })

  it('is the same consent for the current count once the report is filed', async () => {
    const prepared = await consent(chainOver(CONTESTED), undefined, 'vector consent in advance', 2n)
    if (!prepared.ok) throw new Error(prepared.reason)
    expect(prepared.consent.reportCount).toBe(1)
    expect(prepared.disclosure.preauthorization).toBeNull()
    expect(prepared.digest).toBe(ADVANCE_CONSENT_DIGEST)
    expect(await consent(chainOver(CONTESTED), 0, 'vector job kept', 1n)).toEqual({
      ok: false,
      reason: 'consent.count_passed',
    })
  })

  it('builds no consent once a ruling is posted, where the lock takes none', async () => {
    expect(await consent(chainOver(RULED), undefined, 'vector consent in advance', 2n)).toEqual({
      ok: false,
      reason: 'consent.not_releasable',
    })
  })

  it('is a report of the charge the accepted record holds, and none once a report stands', async () => {
    const report = (record: Hex) =>
      prepareReport(
        {
          lock: LOCK,
          commitmentId: COMMITMENT,
          kind: 'lateCancellation',
          evidenceHash: id('vector late cancellation'),
          now: START - 300n,
          nonce: 3n,
        },
        {
          config: {
            chainId: CHAIN_ID,
            signingKey: signingKey.address,
            acceptedTokens: config.acceptedTokens,
          },
          chain: chainOver(record),
        },
      )
    const prepared = await report(ACCEPTED)
    if (!prepared.ok) throw new Error(prepared.reason)
    // The late cancellation's most, $250, as the record's first charge holds it.
    expect(prepared.report).toEqual({
      commitmentId: COMMITMENT,
      side: 'buyer',
      kind: 'lateCancellation',
      amount: 250_000_000n,
      evidenceHash: id('vector late cancellation'),
      nonce: 3n,
      expiry: START + 300n,
    })
    expect(prepared.digest).toBe(digestOf(reportTypedData(prepared.report, DOMAIN)))
    expect(prepared.reportNumber).toBe(1)
    expect(await report(REPORTED)).toEqual({ ok: false, reason: 'report.open' })
    expect(await report(CONTESTED)).toEqual({ ok: false, reason: 'report.not_reportable' })
    // Once the first is withdrawn, the next report is the commitment's second.
    const second = await report(WITHDRAWN)
    expect(second.ok && second.reportNumber).toBe(2)
  })
})
