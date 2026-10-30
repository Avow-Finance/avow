import {
  type AnyTerms,
  type Approval,
  acceptanceTypedData,
  type ChainedTerms,
  chainedTerms,
  digestOf,
  elideDependencies,
  elidedTermsHash,
  type GpuReservationTerms,
  isKeySignature,
  LOCK_RECORD_FIELDS,
  lockTerms,
  type Mandate,
  mandateHash,
  PRODUCTION_PROFILE,
  termsHash,
  testnetDemoTermsV1,
  toWire,
} from '@avow-finance/spec'
import {
  type Address,
  decodeFunctionData,
  getAbiItem,
  getAddress,
  type Hex,
  toFunctionSelector,
  zeroAddress,
} from 'viem'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  ACCEPT_ABI,
  ACCEPTANCE_VALIDITY,
  type AcceptanceDeps,
  acceptCall,
  prepareAcceptance,
  signAcceptance,
} from './accept.js'
import type { LockedBacking, MemoryChain } from './chain.js'
import { disclosureId, formatDuration, formatTime } from './disclosure.js'
import {
  ARBITER,
  acceptanceConfig,
  agent,
  agreed,
  approval,
  authorization,
  buyer,
  COMMITMENT,
  DOMAIN,
  dependencyOn,
  id,
  KEY_TX,
  LOCK,
  LOCK_TERMS,
  type LockScript,
  lockedBacking,
  lockInfo,
  mandate,
  mHash,
  NOW,
  newKey,
  PAYEE,
  PINNED,
  RECORD_CHANGES,
  recordKey,
  reservedChain,
  SALT,
  START,
  SUPPLIER_LOCK,
  scriptedLocks,
  shownUpstream,
  signedApproval,
  signedAuthorization,
  signedMandate,
  supplierAccount,
  supplierKey,
  supplierLock,
  TOKEN,
  terms,
} from './test-helpers.js'

let chain: MemoryChain
let deps: AcceptanceDeps

beforeEach(() => {
  chain = reservedChain()
  deps = { config: acceptanceConfig, chain }
})

const refused = (reason: string) => ({ ok: false, reason })

async function prepare(
  change: {
    authorization?: unknown
    approval?: unknown
    mandate?: unknown
    terms?: AnyTerms
    agreed?: typeof agreed
    now?: bigint
    deps?: AcceptanceDeps
  } = {},
) {
  return prepareAcceptance(
    {
      authorization: change.authorization ?? (await signedAuthorization()),
      approval: change.approval ?? (await signedApproval()),
      mandate: 'mandate' in change ? change.mandate : await signedMandate(mandate),
      agreed: change.agreed ?? agreed,
      terms: 'terms' in change ? (change.terms as AnyTerms) : terms,
      now: change.now ?? NOW,
      nonce: 7n,
    },
    change.deps ?? deps,
  )
}

async function ready() {
  const prepared = await prepare()
  if (!prepared.ok) throw new Error(prepared.reason)
  return prepared
}

describe('the supported acceptance path', () => {
  it('builds the acceptance the lock checks, naming the digest the lock stored', async () => {
    const prepared = await ready()
    const stored = lockedBacking().approvalHash
    expect(prepared.approvalDigest).toBe(stored)
    expect(prepared.acceptance).toEqual({
      commitmentId: COMMITMENT,
      side: 'buyer',
      approvalHash: stored,
      termsHash: agreed.termsHash,
      amount: 500_000_000n,
      token: approval().token,
      acceptBy: LOCK_TERMS.acceptBy,
      nonce: 7n,
      expiry: NOW + ACCEPTANCE_VALIDITY,
    })
    expect(prepared.digest).toBe(digestOf(acceptanceTypedData(prepared.acceptance, DOMAIN)))
    expect(prepared.signingKey).toBe(supplierKey.address)
  })

  it('never lets the acceptance outlive the acceptance deadline', async () => {
    const late = LOCK_TERMS.acceptBy - 60n
    const auth = await signedAuthorization(authorization({ expiry: late + 300n }))
    const prepared = await prepare({ authorization: auth, now: late })
    expect(prepared.ok && prepared.acceptance.expiry).toBe(LOCK_TERMS.acceptBy)
  })

  it('accepts a reserve the business funded with its root key', async () => {
    const a = approval({ fundingKey: zeroAddress })
    chain.setBacking(LOCK, COMMITMENT, 'buyer', lockedBacking({}, a))
    expect((await prepare({ approval: await signedApproval(a) })).ok).toBe(true)
  })

  it('records nothing, so the same reserve can be prepared again', async () => {
    expect((await prepare()).ok).toBe(true)
    expect((await prepare()).ok).toBe(true)
  })
})

describe('the call that hands an acceptance to the lock', () => {
  it("has the selector of the compiled testnet lock's accept", () => {
    expect(toFunctionSelector(getAbiItem({ abi: ACCEPT_ABI, name: 'accept' }))).toBe(
      toFunctionSelector(
        'accept((bytes32,uint8,bytes32,bytes32,uint256,address,uint64,uint256,uint64),bytes)',
      ),
    )
  })

  it('carries the acceptance to its lock exactly as it was signed', async () => {
    const prepared = await ready()
    const signed = await signAcceptance(prepared, supplierKey, {
      disclosureId: prepared.disclosure.id,
    })
    const call = acceptCall(signed)
    expect(call.to).toBe(LOCK)
    const { args } = decodeFunctionData({ abi: ACCEPT_ABI, data: call.data })
    const [message, signature] = args
    expect(signature).toBe(signed.signature)
    expect(message).toEqual({
      ...prepared.acceptance,
      side: 0,
      token: getAddress(prepared.acceptance.token),
    })
  })
})

describe('signing the acceptance', () => {
  it('signs with the supplier signing key once the disclosure is confirmed', async () => {
    const prepared = await ready()
    const signed = await signAcceptance(prepared, supplierKey, {
      disclosureId: prepared.disclosure.id,
    })
    expect(signed).toMatchObject({ type: 'Acceptance', chainId: 42431, lock: LOCK })
    expect(signed.message).toEqual(prepared.acceptance)
    expect(isKeySignature(prepared.digest, signed.signature, supplierKey.address)).toBe(true)
  })

  it('refuses without the confirmation, or with another disclosure id', async () => {
    const prepared = await ready()
    await expect(
      signAcceptance(prepared, supplierKey, { disclosureId: undefined as never }),
    ).rejects.toThrow(/disclosure/)
    await expect(
      signAcceptance(prepared, supplierKey, { disclosureId: id('another disclosure') }),
    ).rejects.toThrow(/disclosure/)
  })

  it("refuses a key that isn't the signing key the approval names", async () => {
    const prepared = await ready()
    await expect(
      signAcceptance(prepared, newKey(), { disclosureId: prepared.disclosure.id }),
    ).rejects.toThrow(/signing key/)
  })

  it('refuses a copy or an edit of what prepareAcceptance returned', async () => {
    const prepared = await ready()
    const confirm = { disclosureId: prepared.disclosure.id }
    const notBuilt = /as it returned it/
    // A copy with another amount.
    const changedAcceptance = {
      ...prepared,
      acceptance: { ...prepared.acceptance, amount: prepared.acceptance.amount - 1n },
    }
    await expect(signAcceptance(changedAcceptance, supplierKey, confirm)).rejects.toThrow(notBuilt)
    // A copy with its digest and disclosure rebuilt to match, so it agrees with itself.
    const later = { ...prepared.acceptance, expiry: prepared.acceptance.expiry + 3600n }
    const digest = digestOf(acceptanceTypedData(later, prepared.domain))
    const sections = [{ heading: 'Nothing to see', lines: ['Sign here'] }]
    const rebuilt = {
      ...prepared,
      acceptance: later,
      digest,
      disclosure: {
        ...prepared.disclosure,
        digest,
        sections,
        id: disclosureId({ ...prepared.disclosure, digest, sections }),
      },
    }
    await expect(
      signAcceptance(rebuilt, supplierKey, { disclosureId: rebuilt.disclosure.id }),
    ).rejects.toThrow(notBuilt)
    // The object itself can't be changed in place.
    expect(() => {
      ;(prepared.acceptance as { amount: bigint }).amount = 1n
    }).toThrow(TypeError)
    const lines = (prepared.disclosure.sections[0]?.lines ?? []) as string[]
    expect(lines.length).toBeGreaterThan(0)
    expect(() => lines.push('More')).toThrow(TypeError)
    expect((await signAcceptance(prepared, supplierKey, confirm)).message.amount).toBe(500_000_000n)
  })
})

describe('every term of the approval that binds the supplier', () => {
  const other: Address = '0x000000000000000000000000000000000000dead'
  const charges = approval().charges
  const [late, noShow] = charges as [(typeof charges)[0], (typeof charges)[0]]
  const cases: [string, Partial<Approval>, string][] = [
    ['commitment', { commitmentId: id('commitment-2') }, 'approval.commitment_mismatch'],
    ['supplier account', { supplier: newKey().address }, 'approval.parties_mismatch'],
    ['signing key', { supplierSigner: newKey().address }, 'approval.parties_mismatch'],
    ['payout', { payee: other }, 'approval.parties_mismatch'],
    ['side', { side: 'supplier' }, 'approval.terms_mismatch'],
    ['token', { token: '0x20c0000000000000000000000000000000000002' }, 'approval.terms_mismatch'],
    ['amount', { amount: 500_000_001n }, 'approval.terms_mismatch'],
    [
      'free cancellation',
      { freeCancelBy: LOCK_TERMS.freeCancelBy + 1n },
      'approval.terms_mismatch',
    ],
    ['acceptance deadline', { acceptBy: LOCK_TERMS.acceptBy + 1n }, 'approval.terms_mismatch'],
    [
      'charge deadline',
      { chargeDeadline: LOCK_TERMS.chargeDeadline + 1n },
      'approval.terms_mismatch',
    ],
    ['release date', { releaseDate: LOCK_TERMS.releaseDate + 1n }, 'approval.terms_mismatch'],
    ['contest window', { contestWindow: LOCK_TERMS.contestWindow - 1n }, 'approval.terms_mismatch'],
    ['terms hash', { termsHash: id('other terms') }, 'approval.terms_mismatch'],
    ['first kind', { charges: [{ ...late, kind: 'noShow' }, noShow] }, 'approval.charges_mismatch'],
    [
      'first most',
      { charges: [{ ...late, most: late.most - 1n }, noShow] },
      'approval.charges_mismatch',
    ],
    [
      'first earliest',
      { charges: [{ ...late, earliest: late.earliest + 1n }, noShow] },
      'approval.charges_mismatch',
    ],
    [
      'second most',
      { charges: [late, { ...noShow, most: noShow.most + 1n }] },
      'approval.charges_mismatch',
    ],
    [
      'second earliest',
      { charges: [late, { ...noShow, earliest: noShow.earliest - 1n }] },
      'approval.charges_mismatch',
    ],
    ['a charge dropped', { charges: [noShow] }, 'approval.charges_mismatch'],
    ['charges reordered', { charges: [noShow, late] }, 'approval.charges_mismatch'],
    ['day-90 share', { day90SupplierShareBps: 4999 }, 'approval.dispute_mismatch'],
    ['arbiter', { arbiter: other }, 'approval.dispute_mismatch'],
    ['mandate hash', { mandateHash: id('another mandate') }, 'approval.mandate_mismatch'],
    ['cap per commitment', { capPerCommitment: 1_000_000_001n }, 'approval.mandate_mismatch'],
    ['cap on open reserves', { capOpenReserves: 2_000_000_001n }, 'approval.mandate_mismatch'],
    ['funding key', { fundingKey: newKey().address }, 'approval.mandate_mismatch'],
    ['root key in place of the agent', { fundingKey: zeroAddress }, 'approval.mandate_mismatch'],
    ['nonce', { nonce: 2n }, 'chain.approval_mismatch'],
    ['expiry', { expiry: NOW + 121n }, 'chain.approval_mismatch'],
  ]

  it('covers every field of the approval', () => {
    const changed = new Set(cases.flatMap(([, change]) => Object.keys(change)))
    expect([...changed].sort()).toEqual(Object.keys(approval()).sort())
  })

  it("maps the supplier's terms to the lock fields these tests write out by hand", () => {
    expect(lockTerms(terms, TOKEN.decimals)).toEqual(LOCK_TERMS)
  })

  for (const [name, change, reason] of cases) {
    it(`refuses an approval with another ${name}, while the lock holds the original`, async () => {
      const tampered = await signedApproval(approval(change))
      expect(await prepare({ approval: tampered })).toEqual(refused(reason))
    })
  }

  it('refuses an approval for another lock', async () => {
    const tampered = {
      ...(await signedApproval()),
      lock: '0x00000000000000000000000000000000000010c5',
    }
    expect(await prepare({ approval: tampered })).toEqual(refused('message.wrong_contract'))
  })

  it('refuses an approval that is missing a term', async () => {
    const signed = await signedApproval()
    const { arbiter: _, ...message } = signed.message as Record<string, unknown>
    expect(await prepare({ approval: { ...signed, message } })).toEqual(refused('message.invalid'))
  })
})

describe('a commitment made under version 1 terms', () => {
  it('still verifies end to end through the same checks, under its version 1 hash', async () => {
    const v1 = testnetDemoTermsV1(START, ARBITER)
    const hash = termsHash(v1, SALT)
    expect(hash).not.toBe(agreed.termsHash)
    const a = approval({ termsHash: hash })
    chain.setBacking(LOCK, COMMITMENT, 'buyer', lockedBacking({}, a))
    const prepared = await prepare({
      terms: v1,
      agreed: { ...agreed, termsHash: hash },
      authorization: await signedAuthorization(authorization({ termsHash: hash })),
      approval: await signedApproval(a),
    })
    expect(prepared.ok && prepared.acceptance.termsHash).toBe(hash)
  })

  it("refuses one version's terms under the other version's hash for the same booking and salt", async () => {
    const v1 = testnetDemoTermsV1(START, ARBITER)
    const v1Hash = termsHash(v1, SALT)
    // Version 1 terms, where every message names the version 2 hash.
    expect(await prepare({ terms: v1 })).toEqual(refused('terms.hash_mismatch'))
    // Version 2 terms, where every message and the lock name the version 1 hash.
    const a = approval({ termsHash: v1Hash })
    chain.setBacking(LOCK, COMMITMENT, 'buyer', lockedBacking({}, a))
    const underV1 = {
      terms,
      agreed: { ...agreed, termsHash: v1Hash },
      authorization: await signedAuthorization(authorization({ termsHash: v1Hash })),
      approval: await signedApproval(a),
    }
    expect(await prepare(underV1)).toEqual(refused('terms.hash_mismatch'))
    expect((await prepare({ ...underV1, terms: v1 })).ok).toBe(true)
  })
})

describe("the supplier's own terms", () => {
  it('refuses terms that are no object or carry a field the hash leaves out, without throwing', async () => {
    expect(await prepare({ terms: null as unknown as AnyTerms })).toEqual(refused('terms.invalid'))
    const extra = { ...terms, gracePeriod: 60n } as AnyTerms
    expect(await prepare({ terms: extra })).toEqual(refused('terms.invalid'))
  })

  it('refuses version 1 terms without the dispute block', async () => {
    const { dispute: _, ...older } = testnetDemoTermsV1(START, ARBITER)
    expect(await prepare({ terms: older as AnyTerms })).toEqual(refused('terms.incomplete'))
  })

  it('refuses terms other than the ones the supplier agreed to and Avow signed', async () => {
    const [late, noShow] = terms.remedies.charges
    if (!late || !noShow) throw new Error('the test terms have two charges')
    const changes: GpuReservationTerms[] = [
      { ...terms, resolution: { ...terms.resolution, arbiter: newKey().address } },
      { ...terms, resolution: { ...terms.resolution, day90SupplierShareBps: 10_000 } },
      {
        ...terms,
        remedies: { ...terms.remedies, charges: [late, { ...noShow, amount: noShow.amount - 1n }] },
      },
      {
        ...terms,
        remedies: {
          ...terms.remedies,
          charges: [late, { ...noShow, earliest: noShow.earliest + 1n }],
        },
      },
      { ...terms, backing: { ...terms.backing, releaseDate: terms.backing.releaseDate + 1n } },
      {
        ...terms,
        subject: { ...terms.subject, resource: { ...terms.subject.resource, count: 4 } },
      },
    ]
    for (const change of changes) {
      expect(await prepare({ terms: change }), JSON.stringify(toWire(change))).toEqual(
        refused('terms.hash_mismatch'),
      )
    }
  })

  it("refuses a buyer or a mandate other than the ones the supplier's agreement names", async () => {
    expect(await prepare({ agreed: { ...agreed, buyerBusinessId: 'biz_other' } })).toEqual(
      refused('authorization.buyer_mismatch'),
    )
    expect(await prepare({ agreed: { ...agreed, mandateHash: id('other mandate') } })).toEqual(
      refused('authorization.mandate_mismatch'),
    )
  })

  it('needs the buyer and the mandate from the agreement', async () => {
    const { buyerBusinessId: _b, ...noBuyer } = agreed
    expect(await prepare({ agreed: noBuyer as typeof agreed })).toEqual(refused('message.invalid'))
    const { mandateHash: _m, ...noMandate } = agreed
    expect(await prepare({ agreed: noMandate as typeof agreed })).toEqual(
      refused('message.invalid'),
    )
  })

  it('refuses a commitment the supplier did not agree to', async () => {
    expect(await prepare({ agreed: { ...agreed, commitmentId: id('commitment-2') } })).toEqual(
      refused('authorization.commitment_mismatch'),
    )
  })
})

describe("the buyer's mandate and the agent's authority", () => {
  /** Rewires the chain, the authorization and the approval for another mandate. */
  async function under(m: Mandate) {
    const h = mandateHash(m, DOMAIN)
    const a = approval({
      mandateHash: h,
      capPerCommitment: m.capPerCommitment,
      capOpenReserves: m.capOpenReserves,
    })
    chain.setAgentKey(
      buyer.address,
      agent.address,
      { active: true, expiry: null, witness: h },
      KEY_TX,
    )
    chain.setBacking(LOCK, COMMITMENT, 'buyer', lockedBacking({}, a))
    return prepare({
      authorization: await signedAuthorization(authorization({ mandateHash: h })),
      approval: await signedApproval(a),
      mandate: await signedMandate(m),
      agreed: { ...agreed, mandateHash: h },
    })
  }

  it('passes the same reserve under a mandate that allows it', async () => {
    expect((await under({ ...mandate, nonce: 2n })).ok).toBe(true)
  })

  it('refuses without the mandate', async () => {
    expect(await prepare({ mandate: undefined })).toEqual(refused('mandate.missing'))
    expect(await prepare({ mandate: null })).toEqual(refused('mandate.missing'))
  })

  it("refuses a mandate the buyer's account didn't sign", async () => {
    expect(await prepare({ mandate: await signedMandate(mandate, newKey()) })).toEqual(
      refused('mandate.signature_invalid'),
    )
  })

  it("refuses a mandate other than the one Avow's authorization names", async () => {
    const other = await signedMandate({ ...mandate, capPerCommitment: 900_000_000n })
    expect(await prepare({ mandate: other })).toEqual(refused('authorization.mandate_mismatch'))
  })

  it("refuses a mandate signed for another business than the agreement's buyer", async () => {
    expect(await under({ ...mandate, businessId: 'biz_someone_else' })).toEqual(
      refused('authorization.mandate_mismatch'),
    )
  })

  it('refuses a mandate that has expired or ends before the release date', async () => {
    expect(await under({ ...mandate, expiry: NOW })).toEqual(refused('mandate.expired'))
    expect(await under({ ...mandate, expiry: LOCK_TERMS.releaseDate - 1n })).toEqual(
      refused('mandate.ends_before_window'),
    )
  })

  it('refuses an agent key that is revoked, expires too soon or carries another mandate', async () => {
    const set = (info: { active: boolean; expiry: bigint | null; witness: `0x${string}` }) =>
      chain.setAgentKey(buyer.address, agent.address, info, KEY_TX)
    set({ active: false, expiry: null, witness: mHash })
    expect(await prepare()).toEqual(refused('chain.agent_key_inactive'))
    set({ active: true, expiry: LOCK_TERMS.releaseDate - 1n, witness: mHash })
    expect(await prepare()).toEqual(refused('chain.agent_key_inactive'))
    set({ active: true, expiry: null, witness: id('another mandate') })
    expect(await prepare()).toEqual(refused('chain.mandate_mismatch'))
  })

  it("refuses a reserve outside the mandate's scope", async () => {
    const cases: [Partial<Mandate>, string][] = [
      [{ actions: ['cancel'] }, 'mandate.action_not_permitted'],
      [{ suppliers: ['biz_someone_else'] }, 'mandate.supplier_not_allowed'],
      [{ categories: ['storage'] }, 'mandate.category_not_allowed'],
      [{ capPerCommitment: 100_000_000n }, 'mandate.over_commitment_cap'],
      [
        {
          paymentLimits: [
            { token: '0x20c0000000000000000000000000000000000002', amount: 1n, period: 0n },
          ],
        },
        'mandate.token_not_allowed',
      ],
      [
        { paymentLimits: [{ token: approval().token, amount: 100_000_000n, period: 0n }] },
        'mandate.over_payment_limit',
      ],
    ]
    for (const [change, reason] of cases) {
      expect(await under({ ...mandate, ...change }), reason).toEqual(refused(reason))
    }
  })
})

describe('the lock', () => {
  it('refuses when the lock holds the reserve under another approval', async () => {
    chain.setBacking(
      LOCK,
      COMMITMENT,
      'buyer',
      lockedBacking({ approvalHash: id('another approval') }),
    )
    expect(await prepare()).toEqual(refused('chain.approval_mismatch'))
  })

  it("refuses when the lock's record names other parties or another mandate than the approval", async () => {
    const changes: Partial<LockedBacking>[] = [
      { supplier: newKey().address },
      { supplierSigner: newKey().address },
      { mandateHash: id('another mandate') },
    ]
    for (const change of changes) {
      chain.setBacking(LOCK, COMMITMENT, 'buyer', lockedBacking(change))
      expect(await prepare(), Object.keys(change).join()).toEqual(
        refused('chain.approval_mismatch'),
      )
    }
  })

  it('refuses when the lock enforces another value than the terms in any field it stores', async () => {
    // The authorization's checks compare the record with the terms before the approval is read.
    for (const field of LOCK_RECORD_FIELDS) {
      chain.setBacking(LOCK, COMMITMENT, 'buyer', lockedBacking({ [field]: RECORD_CHANGES[field] }))
      expect(await prepare(), field).toEqual(refused('chain.reserve_mismatch'))
    }
  })

  it('refuses a reserve that is missing, already accepted, or funded by another key', async () => {
    chain.setBacking(LOCK, COMMITMENT, 'buyer', null)
    expect(await prepare()).toEqual(refused('chain.reserve_missing'))
    chain.setBacking(LOCK, COMMITMENT, 'buyer', lockedBacking({ state: 'accepted' }))
    expect(await prepare()).toEqual(refused('chain.reserve_accepted'))
    chain.setBacking(LOCK, COMMITMENT, 'buyer', lockedBacking({ fundingKey: newKey().address }))
    expect(await prepare()).toEqual(refused('chain.reserve_mismatch'))
  })

  it("refuses a lock that isn't from Avow's factory", async () => {
    chain.setLock(LOCK, lockInfo({ fromFactory: false }))
    expect(await prepare()).toEqual(refused('chain.lock_unknown'))
  })

  it("refuses a lock whose dispute timing or token isn't the profile's", async () => {
    const timing = lockInfo().timing
    for (const change of [
      { timing: { ...timing, confirmWindow: timing.confirmWindow + 1n } },
      { timing: { ...timing, rulingKeyEnd: timing.rulingKeyEnd - 1n } },
      { timing: { ...timing, day90: timing.day90 * 2n } },
      { timing: { ...timing, rulingDelay: 0n } },
      { timing: { ...timing, minContestWindow: 60n } },
      { timing: PRODUCTION_PROFILE.lockTiming },
      { token: '0x20c0000000000000000000000000000000000002' as Address },
    ]) {
      chain.setLock(LOCK, lockInfo(change))
      expect(await prepare(), JSON.stringify(toWire(change))).toEqual(
        refused('chain.lock_timing_unexpected'),
      )
    }
  })
})

describe('the disclosure', () => {
  it('shows the exposure, the deadlines and the dispute terms before anything is signed', async () => {
    const { disclosure } = await ready()
    const text = disclosure.sections.map((s) => `${s.heading}\n${s.lines.join('\n')}`).join('\n')
    expect(disclosure.sections.map((s) => s.heading)).toEqual([
      "What you're accepting",
      'Your exposure',
      'Deadlines',
      'Disputes',
    ])
    for (const expected of [
      COMMITMENT,
      lockedBacking().approvalHash,
      'The business reserved USD 500 (500000000 base units',
      'A late cancellation can charge up to USD 250 (250000000 base units',
      `reported from ${formatTime(LOCK_TERMS.freeCancelBy)}`,
      'A no-show can charge up to USD 500 (500000000 base units',
      // The no-show is chargeable once the 2-minute grace period after the window's start passes.
      `reported from ${formatTime(START + 120n)}`,
      `Free cancellation ends at ${formatTime(LOCK_TERMS.freeCancelBy)}`,
      `This acceptance stops working at ${formatTime(NOW + ACCEPTANCE_VALIDITY)}`,
      `the lock takes no acceptance from ${formatTime(LOCK_TERMS.acceptBy)}`,
      `Report any charge before ${formatTime(LOCK_TERMS.chargeDeadline)}`,
      `goes back to the business at ${formatTime(LOCK_TERMS.releaseDate)}`,
      'within 5 minutes',
      "contest a confirmed charge for 10 minutes, and a report Avow hasn't confirmed at any time",
      'Avow can also pause a confirmed charge before its contest window closes',
      'The commitment takes at most two reports, one at a time.',
      'rule for 30 minutes after the pause',
      `the arbiter ${'0x000000000000000000000000000000000000A4b1'}`,
      'until 90 minutes after it',
      'takes effect 5 minutes after',
      'pays you 50% of it',
    ]) {
      expect(text).toContain(expected)
    }
    expect(text.toLowerCase()).toContain(PAYEE.toLowerCase())
    expect(text.toLowerCase()).toContain(ARBITER.toLowerCase())
    expect(disclosure.preauthorization).toBeNull()
    expect(disclosure.digest).toBe((await ready()).digest)
  })

  it('writes durations in the largest whole unit', () => {
    expect(formatDuration(259_200n)).toBe('3 days')
    expect(formatDuration(86_400n)).toBe('1 day')
    expect(formatDuration(5400n)).toBe('90 minutes')
    expect(formatDuration(90n)).toBe('90 seconds')
  })
})

describe('a booking that relies on the supplier’s own booking', () => {
  const chained = chainedTerms(terms, [dependencyOn()])
  const hash = termsHash(chained, SALT)

  /** Prepares the acceptance of terms Avow approved, under their own terms hash by default. */
  async function prepareChained(
    change: {
      script?: LockScript
      disclosed?: unknown[]
      dependencies?: 'none'
      terms?: ChainedTerms
      termsHash?: Hex
    } = {},
  ) {
    const t = change.terms ?? chained
    const h = change.termsHash ?? termsHash(t, SALT)
    const approved = approval({ termsHash: h })
    chain.setBacking(LOCK, COMMITMENT, 'buyer', lockedBacking({}, approved))
    const { reader, calls } = scriptedLocks(change.script)
    const prepared = await prepareAcceptance(
      {
        authorization: await signedAuthorization(authorization({ termsHash: h })),
        approval: await signedApproval(approved),
        mandate: await signedMandate(mandate),
        agreed: { ...agreed, termsHash: h },
        terms: t,
        disclosed: change.disclosed ?? [shownUpstream],
        now: NOW,
        nonce: 7n,
      },
      change.dependencies === 'none' ? deps : { ...deps, dependencies: { readers: [reader] } },
    )
    return { prepared, calls }
  }

  it('prepares the acceptance once the upstream booking is accepted, recording the block read', async () => {
    const { prepared, calls } = await prepareChained()
    if (!prepared.ok) throw new Error(prepared.reason)
    expect(prepared.acceptance.termsHash).toBe(hash)
    expect(prepared.dependencies).toEqual([{ on: dependencyOn().on, block: PINNED }])
    for (const c of calls) expect(c.at, c.call).toBe(PINNED.number)
  })

  it('freezes its own copies of each reference and block, leaving the caller’s objects alone', async () => {
    const own = chainedTerms(terms, [dependencyOn()])
    const head = { number: 4321n, hash: id('block 4321') }
    const { prepared } = await prepareChained({ terms: own, script: { head } })
    if (!prepared.ok) throw new Error(prepared.reason)
    const [listed] = prepared.dependencies
    expect(listed).toEqual({ on: own.dependencies[0].on, block: head })
    expect(Object.isFrozen(listed?.on)).toBe(true)
    expect(Object.isFrozen(listed?.block)).toBe(true)
    expect(Object.isFrozen(own.dependencies[0].on)).toBe(false)
    expect(Object.isFrozen(head)).toBe(false)
  })

  it('refuses while the upstream booking is only reserved, saying which and as of which block', async () => {
    const script = { locks: { [SUPPLIER_LOCK]: supplierLock({ state: 'reserved' }) } }
    expect((await prepareChained({ script })).prepared).toEqual({
      ok: false,
      reason: 'dependency.not_accepted',
      index: 0,
      block: PINNED,
    })
  })

  it('reads the bookings relied on before anything else reads the terms', async () => {
    const script = { locks: { [SUPPLIER_LOCK]: supplierLock({ state: 'reserved' }) } }
    const { reader } = scriptedLocks(script)
    // An authorization that doesn't even parse is never reached while the dependency fails.
    const prepared = await prepareAcceptance(
      {
        authorization: 'not an authorization',
        approval: 'not an approval',
        mandate: await signedMandate(mandate),
        agreed: { ...agreed, termsHash: hash },
        terms: chained,
        disclosed: [shownUpstream],
        now: NOW,
      },
      { ...deps, dependencies: { readers: [reader] } },
    )
    expect(prepared).toMatchObject({ ok: false, reason: 'dependency.not_accepted' })
  })

  it('still refuses a rule the plain booking it makes would break, once its dependency passes', async () => {
    // The reserve no longer equals the largest charge. The lock still holds the original reserve,
    // so the terms have to be refused before the chain is read, or the lock's record would be.
    const backing = { ...terms.backing, amount: terms.backing.amount + 1n }
    const broken = chainedTerms({ ...terms, backing }, [dependencyOn()])
    const brokenHash = termsHash(broken, SALT)
    const b = approval({ termsHash: brokenHash, amount: backing.amount })
    const { reader } = scriptedLocks()
    const prepared = await prepareAcceptance(
      {
        authorization: await signedAuthorization(
          authorization({ termsHash: brokenHash, amount: backing.amount }),
        ),
        approval: await signedApproval(b),
        mandate: await signedMandate(mandate),
        agreed: { ...agreed, termsHash: brokenHash },
        terms: broken,
        disclosed: [shownUpstream],
        now: NOW,
      },
      { ...deps, dependencies: { readers: [reader] } },
    )
    expect(prepared).toEqual({ ok: false, reason: 'terms.reserve_mismatch' })
  })

  it('runs the dependency check in either setting, since the supplier holds the terms in full', async () => {
    const byAvow = chainedTerms(terms, [dependencyOn()], 'avow')
    const { prepared, calls } = await prepareChained({ terms: byAvow })
    if (!prepared.ok) throw new Error(prepared.reason)
    expect(prepared.acceptance.termsHash).toBe(termsHash(byAvow, SALT))
    expect(prepared.dependencies).toEqual([{ on: dependencyOn().on, block: PINNED }])
    expect(calls.map((c) => c.call)).toContain('commitment')
    const script = { locks: { [SUPPLIER_LOCK]: supplierLock({ state: 'reserved' }) } }
    expect((await prepareChained({ terms: byAvow, script })).prepared).toEqual({
      ok: false,
      reason: 'dependency.not_accepted',
      index: 0,
      block: PINNED,
    })
  })

  it('refuses the buyer’s view in place of the terms, before reading anything', async () => {
    const view = elideDependencies(chainedTerms(terms, [dependencyOn()], 'avow'), SALT)
    const { prepared, calls } = await prepareChained({
      terms: view as unknown as ChainedTerms,
      termsHash: elidedTermsHash(view),
    })
    expect(prepared).toEqual({ ok: false, reason: 'dependency.elided', index: null, block: null })
    expect(calls).toEqual([])
  })

  it('refuses a booking that relies on itself, wherever its lock sits', async () => {
    // The booking being accepted is reserved in its buyer's lock, which isn't the supplier's. Its
    // terms can't name their own hash, so the dependency names the hash the lock is given here.
    const itself = (lock: Address) =>
      chainedTerms(terms, [dependencyOn({ lock, commitmentId: COMMITMENT, termsHash: hash })])
    const held = {
      [recordKey(COMMITMENT, 'buyer')]: {
        state: 'reserved' as const,
        hasReport: false,
        termsHash: hash,
        supplier: supplierAccount.address,
      },
    }
    const buyerLock = { ...supplierLock(null), account: buyer.address, records: held }
    const inBuyerLock = await prepareChained({
      terms: itself(LOCK),
      script: { locks: { [LOCK]: buyerLock } },
    })
    expect(inBuyerLock.prepared).toMatchObject({ ok: false, reason: 'dependency.not_owned' })
    // Held in the supplier's own lock, the supplier would have supplied it to itself.
    const inOwnLock = await prepareChained({
      terms: itself(SUPPLIER_LOCK),
      script: { locks: { [SUPPLIER_LOCK]: { ...supplierLock(null), records: held } } },
    })
    expect(inOwnLock.prepared).toMatchObject({ ok: false, reason: 'dependency.self_supplied' })
  })

  it('refuses an upstream booking in another business’s lock', async () => {
    const elsewhere = { ...supplierLock(), account: newKey().address }
    const { prepared } = await prepareChained({ script: { locks: { [SUPPLIER_LOCK]: elsewhere } } })
    expect(prepared).toMatchObject({ ok: false, reason: 'dependency.not_owned' })
  })

  it('refuses without the subject the supplier showed', async () => {
    const { prepared } = await prepareChained({ disclosed: [] })
    expect(prepared).toMatchObject({ ok: false, reason: 'dependency.disclosure_invalid' })
  })

  it('refuses when no chain and factory are supported for bookings relied on', async () => {
    const { prepared } = await prepareChained({ dependencies: 'none' })
    expect(prepared).toEqual({
      ok: false,
      reason: 'dependency.lock_unknown',
      index: 0,
      block: null,
    })
  })

  it('reads no upstream lock for a plain booking', async () => {
    const { reader, calls } = scriptedLocks()
    const prepared = await prepare({ deps: { ...deps, dependencies: { readers: [reader] } } })
    expect(prepared.ok && prepared.dependencies).toEqual([])
    expect(calls).toEqual([])
  })
})
