import {
  type ComputeTerms,
  digestOf,
  type Mandate,
  MemoryReplayGuard,
  mandateHash,
  mandateTypedData,
  PRODUCTION_PROFILE,
  type RailToken,
  type SupplierAuthorization,
  signForAccount,
  supplierAuthorizationTypedData,
  TESTNET_DEMO_PROFILE,
  termsHash,
  testnetDemoTerms,
  toWire,
} from '@avow-finance/spec'
import { type Address, type Hex, keccak256, stringToHex, zeroAddress } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { beforeEach, describe, expect, it } from 'vitest'
import { type LockedBacking, MemoryChain } from './chain.js'
import { type VerifierConfig, type VerifierDeps, verifySupplierAuthorization } from './verify.js'

// Keys are generated for each run and never leave memory.
const newKey = () => privateKeyToAccount(generatePrivateKey())
const id = (label: string): Hex => keccak256(stringToHex(label))

const CHAIN_ID = 42431
const START = 1_800_000_000n
const NOW = START - 3600n
const LOCK: Address = '0x00000000000000000000000000000000000010c4'
const PAYEE: Address = '0x000000000000000000000000000000000000beef'
const TOKEN: RailToken = {
  rail: 'tempo',
  chainId: CHAIN_ID,
  token: '0x20c0000000000000000000000000000000000001',
  currency: 'USD',
  decimals: 6,
}
const DOMAIN = { chainId: CHAIN_ID, verifyingContract: LOCK }
const SALT = `0x${'55'.repeat(32)}` as const
const COMMITMENT = id('commitment-1')
const KEY_TX = id('the transaction that authorized the agent key')

const avow = newKey()
const buyer = newKey() // the business account's root key, the administrator's on testnet
const agent = newKey()
const terms = testnetDemoTerms(START)
const TERMS_HASH = termsHash(terms, SALT)
const agreed = { commitmentId: COMMITMENT, termsHash: TERMS_HASH, category: 'compute' }

const mandate: Mandate = {
  mandateId: id('mandate-1'),
  businessId: 'biz_buyer',
  agentId: 'agt_1',
  account: buyer.address,
  agentKey: agent.address,
  actions: ['reserve'],
  currency: 'USD',
  capPerCommitment: 1_000_000_000n,
  capOpenReserves: 2_000_000_000n,
  suppliers: ['biz_supplier'],
  categories: [],
  paymentLimits: [{ token: TOKEN.token, amount: 5_000_000_000n, period: 86_400n }],
  approvalRule: { kind: 'never' },
  expiry: START + 30n * 86_400n,
  nonce: 1n,
}
const mHash = mandateHash(mandate, DOMAIN)

function authorization(change: Partial<SupplierAuthorization> = {}): SupplierAuthorization {
  return {
    commitmentId: COMMITMENT,
    termsHash: TERMS_HASH,
    salt: SALT,
    amount: terms.reserve,
    token: TOKEN.token,
    buyerBusinessId: 'biz_buyer',
    kybReference: 'mock-kyb-1',
    kybTestData: true,
    agentKey: agent.address,
    agentKeyAuthorizedIn: KEY_TX,
    mandateHash: mHash,
    payee: PAYEE,
    acceptBy: terms.acceptBy,
    chargeDeadline: terms.chargeDeadline,
    releaseDate: terms.releaseDate,
    nonce: 1n,
    expiry: NOW + 300n,
    ...change,
  }
}

const json = (value: unknown) => JSON.parse(JSON.stringify(toWire(value)))

async function signedAuthorization(
  message = authorization(),
  opts: { signer?: ReturnType<typeof newKey>; schemaVersion?: string; chainId?: number } = {},
): Promise<Record<string, unknown> & { message: Record<string, unknown> }> {
  const signer = opts.signer ?? avow
  const signature = await signer.sign({
    hash: digestOf(supplierAuthorizationTypedData(message, DOMAIN)),
  })
  return json({
    type: 'SupplierAuthorization',
    schemaVersion: opts.schemaVersion ?? '1',
    chainId: opts.chainId ?? CHAIN_ID,
    lock: LOCK,
    message,
    signature,
  })
}

/** The buyer's administrator signs as the business account, in Tempo's keychain envelope. */
async function signedMandate(m: Mandate, key = buyer): Promise<unknown> {
  const signature = await signForAccount(buyer.address, digestOf(mandateTypedData(m, DOMAIN)), key)
  return json({
    type: 'Mandate',
    schemaVersion: '1',
    chainId: CHAIN_ID,
    lock: LOCK,
    message: m,
    signature,
  })
}

function lockedBacking(change: Partial<LockedBacking> = {}): LockedBacking {
  return {
    state: 'reserved',
    token: TOKEN.token,
    amount: terms.reserve,
    payee: PAYEE,
    acceptBy: terms.acceptBy,
    chargeDeadline: terms.chargeDeadline,
    contestWindow: terms.contestWindow,
    releaseDate: terms.releaseDate,
    termsHash: TERMS_HASH,
    fundingKey: agent.address,
    ...change,
  }
}

const config: VerifierConfig = {
  chainId: CHAIN_ID,
  avowKeys: [avow.address],
  businessId: 'biz_supplier',
  payee: PAYEE,
  acceptedTokens: [TOKEN],
  profile: TESTNET_DEMO_PROFILE,
  acceptTestData: true,
}

let chain: MemoryChain
let deps: VerifierDeps

beforeEach(() => {
  chain = new MemoryChain(CHAIN_ID)
  chain.setLock(LOCK, { fromFactory: true, account: buyer.address })
  chain.setBacking(LOCK, COMMITMENT, 'buyer', lockedBacking())
  chain.setAgentKey(
    buyer.address,
    agent.address,
    { active: true, expiry: null, witness: mHash },
    KEY_TX,
  )
  deps = { config, chain, replay: new MemoryReplayGuard() }
})

async function verify(
  auth?: unknown,
  rest: {
    terms?: ComputeTerms
    agreed?: typeof agreed
    mandate?: unknown
    now?: bigint
    deps?: VerifierDeps
  } = {},
) {
  return verifySupplierAuthorization(
    {
      authorization: auth ?? (await signedAuthorization()),
      agreed: rest.agreed ?? agreed,
      terms: rest.terms ?? terms,
      ...(rest.mandate === undefined ? {} : { mandate: rest.mandate }),
      now: rest.now ?? NOW,
    },
    rest.deps ?? deps,
  )
}

const refused = (reason: string) => ({ ok: false, reason })

describe('a supplier verifies from the chain and the signatures alone', () => {
  it('accepts a reserve that matches the authorization and the terms', async () => {
    const result = await verify()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.signer).toBe(avow.address)
    expect(result.account).toBe(buyer.address)
    expect(result.authorization.amount).toBe(500_000_000n)
  })

  it('accepts the signed mandate too, signed in the keychain envelope', async () => {
    expect((await verify(undefined, { mandate: await signedMandate(mandate) })).ok).toBe(true)
  })

  it('refuses when the chain holds no reserve, whatever Avow signed', async () => {
    chain.setBacking(LOCK, COMMITMENT, 'buyer', null)
    expect(await verify()).toEqual(refused('chain.reserve_missing'))
  })

  it('refuses a reserve that has left the lock or that a supplier already accepted', async () => {
    chain.setBacking(LOCK, COMMITMENT, 'buyer', lockedBacking({ state: 'released' }))
    expect(await verify()).toEqual(refused('chain.reserve_missing'))
    chain.setBacking(LOCK, COMMITMENT, 'buyer', lockedBacking({ state: 'accepted' }))
    expect(await verify()).toEqual(refused('chain.reserve_accepted'))
  })

  it('refuses a reserve that differs from the authorization on-chain', async () => {
    const changes: Partial<LockedBacking>[] = [
      { amount: terms.reserve - 1n },
      { payee: '0x000000000000000000000000000000000000dead' },
      { token: '0x20c0000000000000000000000000000000000002' },
      { acceptBy: terms.acceptBy + 1n },
      { chargeDeadline: terms.chargeDeadline + 1n },
      { contestWindow: terms.contestWindow - 1n },
      { releaseDate: terms.releaseDate + 1n },
      { termsHash: id('other terms') },
      { fundingKey: newKey().address },
    ]
    for (const change of changes) {
      chain.setBacking(LOCK, COMMITMENT, 'buyer', lockedBacking(change))
      expect(await verify(), JSON.stringify(toWire(change))).toEqual(
        refused('chain.reserve_mismatch'),
      )
    }
  })

  it("accepts a reserve funded by the account's root key", async () => {
    chain.setBacking(LOCK, COMMITMENT, 'buyer', lockedBacking({ fundingKey: zeroAddress }))
    expect((await verify()).ok).toBe(true)
  })

  it("refuses a lock that isn't from Avow's factory", async () => {
    chain.setLock(LOCK, { fromFactory: false, account: buyer.address })
    expect(await verify()).toEqual(refused('chain.lock_unknown'))
    const empty = new MemoryChain(CHAIN_ID)
    expect(await verify(undefined, { deps: { ...deps, chain: empty } })).toEqual(
      refused('chain.lock_unknown'),
    )
  })

  it("refuses an agent key that's missing, revoked, expired or ends before the release date", async () => {
    const cases = [
      { active: false, expiry: null },
      { active: true, expiry: NOW },
      { active: true, expiry: terms.releaseDate - 1n },
    ]
    for (const c of cases) {
      chain.setAgentKey(buyer.address, agent.address, { ...c, witness: mHash }, KEY_TX)
      expect(await verify(), JSON.stringify(toWire(c))).toEqual(refused('chain.agent_key_inactive'))
    }
    chain.setAgentKey(
      buyer.address,
      agent.address,
      { active: true, expiry: terms.releaseDate, witness: mHash },
      KEY_TX,
    )
    expect((await verify()).ok).toBe(true)
  })

  it("refuses when the agent key's mandate isn't the one Avow named, or the transaction is wrong", async () => {
    chain.setAgentKey(
      buyer.address,
      agent.address,
      { active: true, expiry: null, witness: id('another mandate') },
      KEY_TX,
    )
    expect(await verify()).toEqual(refused('chain.mandate_mismatch'))
    chain.setAgentKey(
      buyer.address,
      agent.address,
      { active: true, expiry: null, witness: mHash },
      id('some other transaction'),
    )
    expect(await verify()).toEqual(refused('chain.mandate_mismatch'))
  })
})

describe('one commitment, one authorization', () => {
  it("refuses an authorization for a commitment the supplier didn't agree to, even on equal terms", async () => {
    const otherSalt = `0x${'77'.repeat(32)}` as const
    const other = authorization({
      commitmentId: id('commitment-2'),
      salt: otherSalt,
      termsHash: termsHash(terms, otherSalt),
    })
    chain.setBacking(
      LOCK,
      id('commitment-2'),
      'buyer',
      lockedBacking({ termsHash: other.termsHash }),
    )
    chain.setBacking(LOCK, COMMITMENT, 'buyer', null)
    expect(await verify(await signedAuthorization(other))).toEqual(
      refused('authorization.commitment_mismatch'),
    )
  })

  it('refuses a terms hash other than the one the supplier signed', async () => {
    expect(await verify(undefined, { agreed: { ...agreed, termsHash: id('x') } })).toEqual(
      refused('terms.hash_mismatch'),
    )
  })

  it('passes a commitment once, however many authorizations Avow signs for it', async () => {
    expect((await verify(await signedAuthorization())).ok).toBe(true)
    expect(await verify(await signedAuthorization(authorization({ nonce: 2n })))).toEqual(
      refused('message.replayed'),
    )
  })

  it("doesn't use up a commitment on a refusal", async () => {
    const auth = await signedAuthorization()
    chain.setBacking(LOCK, COMMITMENT, 'buyer', null)
    expect(await verify(auth)).toEqual(refused('chain.reserve_missing'))
    chain.setBacking(LOCK, COMMITMENT, 'buyer', lockedBacking())
    expect((await verify(auth)).ok).toBe(true)
  })
})

describe('the envelope, the signer and the validity window', () => {
  it("refuses an authorization from a schema version it can't read", async () => {
    expect(await verify(await signedAuthorization(undefined, { schemaVersion: '2' }))).toEqual(
      refused('message.schema_unknown'),
    )
  })

  it("refuses an authorization signed by a key that isn't Avow's", async () => {
    expect(await verify(await signedAuthorization(undefined, { signer: newKey() }))).toEqual(
      refused('message.signer_unknown'),
    )
  })

  it('refuses a signature that recovers no key', async () => {
    const auth = await signedAuthorization()
    expect(await verify({ ...auth, signature: `0x${'00'.repeat(65)}` })).toEqual(
      refused('message.signature_invalid'),
    )
  })

  it('refuses an expired authorization, one valid for too long, or one for another chain', async () => {
    expect(await verify(undefined, { now: NOW + 300n })).toEqual(refused('message.expired'))
    const month = await signedAuthorization(authorization({ expiry: NOW + 30n * 86_400n }))
    expect(await verify(month)).toEqual(refused('message.validity_too_long'))
    expect(await verify(await signedAuthorization(undefined, { chainId: 1 }))).toEqual(
      refused('message.wrong_chain'),
    )
  })

  it('reads hex in any letter case, so a relay that changes case changes nothing', async () => {
    const auth = await signedAuthorization()
    const upper = (h: unknown) => (h as string).toUpperCase().replace('0X', '0x')
    const shouting = {
      ...auth,
      message: { ...auth.message, termsHash: upper(auth.message.termsHash) },
    }
    expect((await verify(shouting)).ok).toBe(true)
  })

  it('returns a reason, never an exception, for an address with a broken checksum', async () => {
    const auth = await signedAuthorization()
    const result = await verify({
      ...auth,
      message: { ...auth.message, payee: '0x000000000000000000000000000000000000BeEf' },
    })
    expect(result.ok).toBe(true)
  })
})

describe('changes after signing', () => {
  it("refuses terms that aren't the ones Avow signed", async () => {
    for (const change of [
      { noShow: terms.noShow + 1n, reserve: terms.reserve + 1n },
      { gracePeriod: terms.gracePeriod + 1n },
      { resource: { ...terms.resource, count: 4 } },
    ]) {
      expect(await verify(undefined, { terms: { ...terms, ...change } })).toEqual(
        refused('terms.hash_mismatch'),
      )
    }
  })

  it('refuses an authorization changed after Avow signed it', async () => {
    const auth = await signedAuthorization()
    for (const [field, value] of [
      ['amount', '1'],
      ['payee', '0x000000000000000000000000000000000000dead'],
      ['salt', `0x${'66'.repeat(32)}`],
      ['kybTestData', false],
      ['agentKeyAuthorizedIn', id('another tx')],
      ['expiry', (NOW + 299n).toString()],
    ] as const) {
      const tampered = { ...auth, message: { ...auth.message, [field]: value } }
      expect(await verify(tampered), field).toEqual(refused('message.signer_unknown'))
    }
  })
})

describe("the buyer's mandate, when the supplier has it", () => {
  it("refuses a mandate that isn't the one the authorization names", async () => {
    const wider = { ...mandate, capPerCommitment: 2_000_000_000n }
    expect(await verify(undefined, { mandate: await signedMandate(wider) })).toEqual(
      refused('authorization.mandate_mismatch'),
    )
  })

  it("refuses a mandate the buyer's account didn't sign, or signed bare", async () => {
    expect(await verify(undefined, { mandate: await signedMandate(mandate, newKey()) })).toEqual(
      refused('mandate.signature_invalid'),
    )
    const bare = await buyer.sign({ hash: digestOf(mandateTypedData(mandate, DOMAIN)) })
    const signed = json({
      type: 'Mandate',
      schemaVersion: '1',
      chainId: CHAIN_ID,
      lock: LOCK,
      message: mandate,
      signature: bare,
    })
    expect(await verify(undefined, { mandate: signed })).toEqual(
      refused('mandate.signature_invalid'),
    )
  })

  it("accepts an admin key's signature when the account lists the key", async () => {
    const admin = newKey()
    chain.addAdminKey(buyer.address, admin.address)
    expect((await verify(undefined, { mandate: await signedMandate(mandate, admin) })).ok).toBe(
      true,
    )
  })

  it('refuses a mandate whose own limits rule out this reserve', async () => {
    const cases: [Partial<Mandate>, string][] = [
      [{ actions: ['cancel'] }, 'mandate.action_not_permitted'],
      [{ capPerCommitment: 100_000_000n }, 'mandate.over_commitment_cap'],
      [{ expiry: terms.releaseDate - 1n }, 'mandate.ends_before_window'],
      [{ suppliers: ['biz_someone_else'] }, 'mandate.supplier_not_allowed'],
      [{ categories: ['storage'] }, 'mandate.category_not_allowed'],
      [
        { paymentLimits: [{ token: TOKEN.token, amount: 100_000_000n, period: 0n }] },
        'mandate.over_payment_limit',
      ],
    ]
    for (const [change, reason] of cases) {
      const narrow = { ...mandate, ...change }
      const narrowHash = mandateHash(narrow, DOMAIN)
      chain.setAgentKey(
        buyer.address,
        agent.address,
        { active: true, expiry: null, witness: narrowHash },
        KEY_TX,
      )
      const auth = await signedAuthorization(authorization({ mandateHash: narrowHash }))
      expect(await verify(auth, { mandate: await signedMandate(narrow) }), reason).toEqual(
        refused(reason),
      )
    }
  })
})

describe("the supplier's own rules", () => {
  it('refuses a reserve that pays someone else', async () => {
    const deps2 = { ...deps, config: { ...config, payee: newKey().address } }
    expect(await verify(undefined, { deps: deps2 })).toEqual(
      refused('authorization.payee_mismatch'),
    )
  })

  it("refuses a token the supplier doesn't accept for the terms' currency", async () => {
    const other = { ...TOKEN, token: '0x20c0000000000000000000000000000000000002' } as const
    const deps2 = { ...deps, config: { ...config, acceptedTokens: [other] } }
    expect(await verify(undefined, { deps: deps2 })).toEqual(
      refused('authorization.token_not_accepted'),
    )
  })

  it('refuses test KYB data when the supplier turns it off', async () => {
    const deps2 = { ...deps, config: { ...config, acceptTestData: false } }
    expect(await verify(undefined, { deps: deps2 })).toEqual(refused('business.test_data'))
  })

  it("refuses the testnet's short contest window under the production profile", async () => {
    const deps2 = {
      ...deps,
      config: { ...config, profile: PRODUCTION_PROFILE, acceptTestData: false },
    }
    expect(await verify(undefined, { deps: deps2 })).toEqual(refused('business.test_data'))
    const realKyb = await signedAuthorization(authorization({ kybTestData: false }))
    expect(await verify(realKyb, { deps: deps2 })).toEqual(refused('terms.contest_window_short'))
  })

  it("refuses an authorization whose deadlines don't match the terms", async () => {
    const auth = await signedAuthorization(
      authorization({ chargeDeadline: terms.chargeDeadline - 60n }),
    )
    expect(await verify(auth)).toEqual(refused('authorization.terms_mismatch'))
  })

  it('refuses once the acceptance deadline has passed', async () => {
    const late = terms.acceptBy
    const auth = await signedAuthorization(authorization({ expiry: late + 300n }))
    expect(await verify(auth, { now: late })).toEqual(refused('authorization.accept_by_passed'))
  })
})

describe('setup mistakes stop the check', () => {
  it('throws when the chain reader is for another chain', async () => {
    const elsewhere = { ...deps, chain: new MemoryChain(1) }
    await expect(verify(undefined, { deps: elsewhere })).rejects.toThrow()
  })

  it('throws when test data or the demo profile would run outside a testnet', async () => {
    const mainnet = new MemoryChain(4217)
    await expect(
      verify(undefined, {
        deps: { ...deps, chain: mainnet, config: { ...config, chainId: 4217 } },
      }),
    ).rejects.toThrow()
  })
})
