import {
  type AnyTerms,
  AUTHORIZATION_TERMS_FIELDS,
  type AuthorizationTermsField,
  digestOf,
  type GpuReservationTerms,
  LOCK_RECORD_FIELDS,
  type Mandate,
  MemoryReplayGuard,
  mandateHash,
  mandateTypedData,
  PRODUCTION_PROFILE,
  type SupplierAuthorization,
  termsHash,
  toWire,
} from '@avow-finance/spec'
import { zeroAddress } from 'viem'
import { beforeEach, describe, expect, it } from 'vitest'
import { type LockedBacking, MemoryChain } from './chain.js'
import {
  agent,
  agreed,
  authorization,
  avow,
  buyer,
  CHAIN_ID,
  COMMITMENT,
  config,
  DOMAIN,
  id,
  json,
  KEY_TX,
  LOCK,
  LOCK_TERMS,
  lockedBacking,
  lockInfo,
  mandate,
  mHash,
  NOW,
  newKey,
  RECORD_CHANGES,
  reservedChain,
  signedAuthorization,
  signedMandate,
  TOKEN,
  terms,
} from './test-helpers.js'
import { type Agreed, type VerifierDeps, verifySupplierAuthorization } from './verify.js'

let chain: MemoryChain
let deps: VerifierDeps

beforeEach(() => {
  chain = reservedChain()
  deps = { config, chain, replay: new MemoryReplayGuard() }
})

async function verify(
  auth?: unknown,
  rest: {
    terms?: AnyTerms
    agreed?: Agreed
    mandate?: unknown
    now?: bigint
    deps?: VerifierDeps
  } = {},
) {
  return verifySupplierAuthorization(
    {
      authorization: auth ?? (await signedAuthorization()),
      agreed: rest.agreed ?? agreed,
      terms: 'terms' in rest ? (rest.terms as AnyTerms) : terms,
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
      { amount: LOCK_TERMS.amount - 1n },
      { payee: '0x000000000000000000000000000000000000dead' },
      { token: '0x20c0000000000000000000000000000000000002' },
      { acceptBy: LOCK_TERMS.acceptBy + 1n },
      { chargeDeadline: LOCK_TERMS.chargeDeadline + 1n },
      { contestWindow: LOCK_TERMS.contestWindow - 1n },
      { releaseDate: LOCK_TERMS.releaseDate + 1n },
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

  it('refuses a reserve whose lock enforces another value than the terms in any field it stores', async () => {
    for (const field of LOCK_RECORD_FIELDS) {
      chain.setBacking(LOCK, COMMITMENT, 'buyer', lockedBacking({ [field]: RECORD_CHANGES[field] }))
      expect(await verify(), field).toEqual(refused('chain.reserve_mismatch'))
    }
  })

  it("accepts a reserve funded by the account's root key", async () => {
    chain.setBacking(LOCK, COMMITMENT, 'buyer', lockedBacking({ fundingKey: zeroAddress }))
    expect((await verify()).ok).toBe(true)
  })

  it("refuses a lock that isn't from Avow's factory", async () => {
    chain.setLock(LOCK, lockInfo({ fromFactory: false }))
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
      { active: true, expiry: LOCK_TERMS.releaseDate - 1n },
    ]
    for (const c of cases) {
      chain.setAgentKey(buyer.address, agent.address, { ...c, witness: mHash }, KEY_TX)
      expect(await verify(), JSON.stringify(toWire(c))).toEqual(refused('chain.agent_key_inactive'))
    }
    chain.setAgentKey(
      buyer.address,
      agent.address,
      { active: true, expiry: LOCK_TERMS.releaseDate, witness: mHash },
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
    const [late, noShow] = terms.remedies.charges
    if (!late || !noShow) throw new Error('the test terms have two charges')
    const changes: GpuReservationTerms[] = [
      {
        ...terms,
        remedies: { ...terms.remedies, charges: [late, { ...noShow, amount: noShow.amount + 1n }] },
        backing: { ...terms.backing, amount: terms.backing.amount + 1n },
      },
      {
        ...terms,
        remedies: {
          ...terms.remedies,
          charges: [late, { ...noShow, earliest: noShow.earliest + 1n }],
        },
      },
      {
        ...terms,
        subject: { ...terms.subject, resource: { ...terms.subject.resource, count: 4 } },
      },
      { ...terms, consideration: { kind: 'rate', amount: 1n, unit: 'gpu-hour' } },
    ]
    for (const change of changes) {
      expect(await verify(undefined, { terms: change })).toEqual(refused('terms.hash_mismatch'))
    }
  })

  it('refuses terms the hash would not cover in full, before hashing them', async () => {
    const { resolution: _, ...noResolution } = terms
    const cases: [unknown, string][] = [
      [noResolution, 'terms.incomplete'],
      [{ ...terms, gracePeriod: 60n }, 'terms.invalid'],
      [{ ...terms, version: 3 }, 'terms.version_unknown'],
      [null, 'terms.invalid'],
    ]
    for (const [t, reason] of cases) {
      expect(await verify(undefined, { terms: t as AnyTerms }), reason).toEqual(refused(reason))
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

describe('the buyer the supplier agreed with', () => {
  it("refuses an authorization for another buyer, or another mandate, than the agreement's", async () => {
    expect(
      await verify(undefined, { agreed: { ...agreed, buyerBusinessId: 'biz_other' } }),
    ).toEqual(refused('authorization.buyer_mismatch'))
    expect(await verify(undefined, { agreed: { ...agreed, mandateHash: id('other') } })).toEqual(
      refused('authorization.mandate_mismatch'),
    )
  })

  it('checks neither when the supplier leaves them out', async () => {
    const { buyerBusinessId: _b, mandateHash: _m, ...older } = agreed
    expect((await verify(undefined, { agreed: older })).ok).toBe(true)
  })

  it("refuses a mandate signed for another business than the authorization's buyer", async () => {
    const other = { ...mandate, businessId: 'biz_someone_else' }
    const otherHash = mandateHash(other, DOMAIN)
    chain.setAgentKey(
      buyer.address,
      agent.address,
      { active: true, expiry: null, witness: otherHash },
      KEY_TX,
    )
    const auth = await signedAuthorization(authorization({ mandateHash: otherHash }))
    expect(
      await verify(auth, {
        mandate: await signedMandate(other),
        agreed: { ...agreed, mandateHash: otherHash },
      }),
    ).toEqual(refused('authorization.mandate_mismatch'))
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
      [{ expiry: LOCK_TERMS.releaseDate - 1n }, 'mandate.ends_before_window'],
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
      const narrowAgreed = { ...agreed, mandateHash: narrowHash }
      expect(
        await verify(auth, { mandate: await signedMandate(narrow), agreed: narrowAgreed }),
        reason,
      ).toEqual(refused(reason))
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

  it('refuses an authorization that differs from the terms in any lock-enforced field it carries', async () => {
    // One change to each such field. It's typed over the fields the authorization carries, so a
    // field added to that list fails the type check here until it has a change of its own. The
    // lock's record still matches the terms, so only the authorization's own check can refuse.
    const changes: { readonly [K in AuthorizationTermsField]: SupplierAuthorization[K] } = {
      amount: LOCK_TERMS.amount - 1n,
      acceptBy: LOCK_TERMS.acceptBy + 60n,
      chargeDeadline: LOCK_TERMS.chargeDeadline - 60n,
      releaseDate: LOCK_TERMS.releaseDate + 60n,
    }
    expect(Object.keys(changes).sort()).toEqual([...AUTHORIZATION_TERMS_FIELDS].sort())
    for (const field of AUTHORIZATION_TERMS_FIELDS) {
      const auth = await signedAuthorization(authorization({ [field]: changes[field] }))
      // A replay guard of its own, so no row's outcome rests on another's.
      const alone = { ...deps, replay: new MemoryReplayGuard() }
      expect(await verify(auth, { deps: alone }), field).toEqual(
        refused('authorization.terms_mismatch'),
      )
    }
  })

  it('refuses once the acceptance deadline has passed', async () => {
    const late = LOCK_TERMS.acceptBy
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
