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

const avow = newKey()
const buyer = newKey() // the business account's root key, the administrator's on testnet
const agent = newKey()
const terms = testnetDemoTerms(START)

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
    termsHash: termsHash(terms, SALT),
    salt: SALT,
    amount: terms.reserve,
    token: TOKEN.token,
    buyerBusinessId: 'biz_buyer',
    kybReference: 'mock-kyb-1',
    kybTestData: true,
    agentKey: agent.address,
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

async function signedAuthorization(
  message = authorization(),
  opts: { signer?: ReturnType<typeof newKey>; schemaVersion?: string; chainId?: number } = {},
): Promise<unknown> {
  const signer = opts.signer ?? avow
  const signature = await signer.sign({
    hash: digestOf(supplierAuthorizationTypedData(message, DOMAIN)),
  })
  return JSON.parse(
    JSON.stringify(
      toWire({
        type: 'SupplierAuthorization',
        schemaVersion: opts.schemaVersion ?? '1',
        chainId: opts.chainId ?? CHAIN_ID,
        lock: LOCK,
        message,
        signature,
      }),
    ),
  )
}

async function signedMandate(m: Mandate, signer = buyer): Promise<unknown> {
  const signature = await signer.sign({ hash: digestOf(mandateTypedData(m, DOMAIN)) })
  return JSON.parse(
    JSON.stringify(
      toWire({
        type: 'Mandate',
        schemaVersion: '1',
        chainId: CHAIN_ID,
        lock: LOCK,
        message: m,
        signature,
      }),
    ),
  )
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
    termsHash: termsHash(terms, SALT),
    fundingKey: agent.address,
    ...change,
  }
}

const config: VerifierConfig = {
  chainId: CHAIN_ID,
  avowKeys: [avow.address],
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
  chain.setAgentKey(buyer.address, agent.address, { active: true, expiry: null, witness: mHash })
  deps = { config, chain, replay: new MemoryReplayGuard() }
})

async function verify(
  auth?: unknown,
  rest: { terms?: ComputeTerms; mandate?: unknown; now?: bigint; deps?: VerifierDeps } = {},
) {
  return verifySupplierAuthorization(
    {
      authorization: auth ?? (await signedAuthorization()),
      terms: rest.terms ?? terms,
      ...(rest.mandate === undefined ? {} : { mandate: rest.mandate }),
      now: rest.now ?? NOW,
    },
    rest.deps ?? deps,
  )
}

const refused = (reason: string) => ({ ok: false, reason })

describe('a supplier verifies from the chain and the signatures alone (acceptance test 6)', () => {
  it('accepts a reserve that matches the authorization and the terms', async () => {
    const result = await verify()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.signer).toBe(avow.address)
    expect(result.account).toBe(buyer.address)
    expect(result.authorization.amount).toBe(500_000_000n)
  })

  it('accepts the signed mandate too, when the supplier has it', async () => {
    expect((await verify(undefined, { mandate: await signedMandate(mandate) })).ok).toBe(true)
  })

  it('refuses when the chain holds no reserve, whatever Avow signed', async () => {
    chain.setBacking(LOCK, COMMITMENT, 'buyer', null)
    expect(await verify()).toEqual(refused('chain.reserve_missing'))
  })

  it('refuses a reserve that has already left the lock', async () => {
    chain.setBacking(LOCK, COMMITMENT, 'buyer', lockedBacking({ state: 'released' }))
    expect(await verify()).toEqual(refused('chain.reserve_missing'))
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
    chain = new MemoryChain(CHAIN_ID)
    expect(await verify(undefined, { deps: { ...deps, chain } })).toEqual(
      refused('chain.lock_unknown'),
    )
  })

  it("refuses when the agent's key is revoked or expired", async () => {
    chain.setAgentKey(buyer.address, agent.address, { active: false, expiry: null, witness: mHash })
    expect(await verify()).toEqual(refused('chain.agent_key_inactive'))
    chain.setAgentKey(buyer.address, agent.address, { active: true, expiry: NOW, witness: mHash })
    expect(await verify()).toEqual(refused('chain.agent_key_inactive'))
  })

  it("refuses when the agent key's on-chain mandate isn't the one Avow named", async () => {
    chain.setAgentKey(buyer.address, agent.address, {
      active: true,
      expiry: null,
      witness: id('another mandate'),
    })
    expect(await verify()).toEqual(refused('chain.mandate_mismatch'))
  })
})

describe('replays (acceptance test 4)', () => {
  it('refuses the same authorization twice', async () => {
    const auth = await signedAuthorization()
    expect((await verify(auth)).ok).toBe(true)
    expect(await verify(auth)).toEqual(refused('message.replayed'))
  })

  it("doesn't use up a nonce on a refusal", async () => {
    const auth = await signedAuthorization()
    chain.setBacking(LOCK, COMMITMENT, 'buyer', null)
    expect(await verify(auth)).toEqual(refused('chain.reserve_missing'))
    chain.setBacking(LOCK, COMMITMENT, 'buyer', lockedBacking())
    expect((await verify(auth)).ok).toBe(true)
  })
})

describe('schema versions (acceptance test 5)', () => {
  it("refuses an authorization from a schema version it can't read", async () => {
    expect(await verify(await signedAuthorization(undefined, { schemaVersion: '2' }))).toEqual(
      refused('message.schema_unknown'),
    )
  })
})

describe('changes after signing (acceptance test 8)', () => {
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
    const auth = (await signedAuthorization()) as { message: Record<string, unknown> }
    for (const [field, value] of [
      ['amount', '1'],
      ['payee', '0x000000000000000000000000000000000000dead'],
      ['salt', `0x${'66'.repeat(32)}`],
      ['kybTestData', false],
      ['expiry', (NOW + 299n).toString()],
    ] as const) {
      const tampered = { ...auth, message: { ...auth.message, [field]: value } }
      expect(await verify(tampered), field).toEqual(refused('message.signer_unknown'))
    }
  })

  it("refuses a mandate that isn't the one the authorization names", async () => {
    const wider = { ...mandate, capPerCommitment: 2_000_000_000n }
    expect(await verify(undefined, { mandate: await signedMandate(wider) })).toEqual(
      refused('authorization.mandate_mismatch'),
    )
  })

  it("refuses a mandate the buyer's account didn't sign", async () => {
    expect(await verify(undefined, { mandate: await signedMandate(mandate, newKey()) })).toEqual(
      refused('mandate.signature_invalid'),
    )
  })
})

describe('the envelope and the signer', () => {
  it("refuses an authorization signed by a key that isn't Avow's", async () => {
    expect(await verify(await signedAuthorization(undefined, { signer: newKey() }))).toEqual(
      refused('message.signer_unknown'),
    )
  })

  it('refuses a signature that recovers no key', async () => {
    const auth = (await signedAuthorization()) as Record<string, unknown>
    expect(await verify({ ...auth, signature: `0x${'00'.repeat(65)}` })).toEqual(
      refused('message.signature_invalid'),
    )
  })

  it('refuses an expired authorization or one for another chain', async () => {
    expect(await verify(undefined, { now: NOW + 300n })).toEqual(refused('message.expired'))
    expect(await verify(await signedAuthorization(undefined, { chainId: 1 }))).toEqual(
      refused('message.wrong_chain'),
    )
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

  it('refuses test KYB data outside testnet', async () => {
    const deps2 = { ...deps, config: { ...config, acceptTestData: false } }
    expect(await verify(undefined, { deps: deps2 })).toEqual(refused('business.test_data'))
  })

  it("refuses the testnet's short contest window under the production profile", async () => {
    const deps2 = { ...deps, config: { ...config, profile: PRODUCTION_PROFILE } }
    expect(await verify(undefined, { deps: deps2 })).toEqual(refused('terms.contest_window_short'))
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
