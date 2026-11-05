import {
  type ChainedTerms,
  chainedJobTerms,
  chainedTerms,
  type Dependencies,
  discloseSection,
  elideDependencies,
  type JobVerification,
  jobVerificationOf,
  RAIL_STATES,
  type RailState,
  type ReasonCode,
  termsHash,
  testnetDemoJobTerms,
  testnetDemoTerms,
} from '@avow-finance/spec'
import type { Address, Hex } from 'viem'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type DependencyDeps,
  type DependencyInput,
  type DependencyRecord,
  type PinnedBlock,
  type PinnedLockReader,
  verifyDependencies,
  verifyJobVerification,
} from './dependency.js'
import {
  ARBITER,
  blockAt,
  buyer,
  CHAIN_ID,
  CLOSED_FREE_CANCEL,
  dependencyOn,
  gpuCloud,
  id,
  json,
  LOCK,
  type LockScript,
  NOW,
  newKey,
  OTHER_FACTORY,
  PINNED,
  recordKey,
  SALT,
  START,
  SUPPLIER_LOCK,
  scriptedLocks,
  shownUpstream,
  supplierAccount,
  supplierLock,
  UPSTREAM_COMMITMENT,
  UPSTREAM_HASH,
  UPSTREAM_RATE,
  UPSTREAM_SALT,
  upstreamTerms,
} from './test-helpers.js'

/** What the buyer books from the supplier: 8 H100s for 30 minutes inside the supplier's hour. */
const plain = testnetDemoTerms(START, ARBITER)
const downstream = chainedTerms(plain, [dependencyOn()])

/** The terms with the subject's resource or window changed. */
function asking(change: Partial<typeof plain.subject.resource>, window: object = {}) {
  const subject = {
    ...plain.subject,
    ...window,
    resource: { ...plain.subject.resource, ...change },
  }
  return chainedTerms({ ...plain, subject }, [dependencyOn()])
}

/** Avow's approval of the booking's reserve, naming the supplier given as its supplier. */
const approvedFor = (supplier: Address) => ({ side: 'buyer', supplier }) as const

async function check(
  change: Partial<DependencyInput> & {
    /** The supplier Avow's approval names, the supplier's account by default. */
    supplier?: Address
    script?: LockScript
    readers?: PinnedLockReader[]
    maxReadAge?: bigint
  } = {},
) {
  const { reader, calls } = scriptedLocks(change.script)
  const input: DependencyInput = {
    terms: change.terms ?? downstream,
    approval: change.approval ?? approvedFor(change.supplier ?? supplierAccount.address),
    disclosed: change.disclosed ?? [shownUpstream],
    now: change.now ?? NOW,
  }
  const deps: DependencyDeps = { readers: change.readers ?? [reader] }
  if (change.maxReadAge !== undefined) deps.maxReadAge = change.maxReadAge
  return { result: await verifyDependencies(input, deps), calls }
}

const refused = (
  reason: ReasonCode,
  block: PinnedBlock | null = PINNED,
  index: number | null = 0,
) => ({ ok: false, reason, index, block })

/** A pass, with the terms the check hands back and each booking with its block. */
const passed = (
  checked: { on: unknown; block: PinnedBlock }[],
  terms: ChainedTerms = downstream,
) => ({
  ok: true,
  terms,
  checked,
})

const withRecord = (record: Parameters<typeof supplierLock>[0]): LockScript => ({
  locks: { [SUPPLIER_LOCK]: supplierLock(record) },
})

describe('a booking that relies on the supplier’s accepted booking', () => {
  it('passes, and records the one block every read was pinned to', async () => {
    const { result, calls } = await check()
    expect(result).toEqual(passed([{ on: dependencyOn().on, block: PINNED }]))
    expect(calls.map((c) => c.call)).toEqual([
      'head',
      'isLock',
      'lockFields',
      'commitment',
      'blockHash',
    ])
    for (const c of calls) expect(c.at, c.call).toBe(PINNED.number)
  })

  it('is confirmed from the chain and the shown subject alone, without the supplier’s rate', async () => {
    // The upstream charges are in the lock's public view, so the rate is what stays hidden.
    const input = {
      terms: downstream,
      supplier: supplierAccount.address,
      disclosed: [shownUpstream],
    }
    const seen = JSON.stringify(json(input))
    expect(seen).not.toContain(UPSTREAM_RATE)
    expect(seen).toContain(UPSTREAM_HASH)
    const { result, calls } = await check(input)
    expect(result.ok).toBe(true)
    // The only thing it reads beyond the terms and the shown section is the chain, at one block.
    expect(new Set(calls.map((c) => c.call))).toEqual(
      new Set(['head', 'isLock', 'lockFields', 'commitment', 'blockHash']),
    )
    // Without the shown section, nothing passes.
    const unshown = await check({ ...input, disclosed: [] })
    expect(unshown.result).toMatchObject({ ok: false, reason: 'dependency.disclosure_invalid' })
  })

  it('checks terms Avow checks for the buyer exactly as it checks the buyer’s own', async () => {
    const terms = chainedTerms(plain, [dependencyOn()], 'avow')
    const { result, calls } = await check({ terms })
    expect(result).toEqual(passed([{ on: dependencyOn().on, block: PINNED }], terms))
    expect(calls.map((c) => c.call)).toEqual([
      'head',
      'isLock',
      'lockFields',
      'commitment',
      'blockHash',
    ])
    const reserved = await check({ terms, script: withRecord({ state: 'reserved' }) })
    expect(reserved.result).toEqual(refused('dependency.not_accepted'))
  })

  it('passes two bookings that rely on the same one, since overselling is not checked', async () => {
    // Together these ask for 12 GPUs of the supplier's 8, and each passes on its own.
    const four = asking({ count: 4 })
    const eight = asking({})
    const { reader } = scriptedLocks()
    const deps = { readers: [reader] }
    const shown = { approval: approvedFor(supplierAccount.address), disclosed: [shownUpstream] }
    const a = await verifyDependencies({ terms: four, ...shown, now: NOW }, deps)
    const b = await verifyDependencies({ terms: eight, ...shown, now: NOW }, deps)
    expect(a.ok && b.ok).toBe(true)
  })

  it('checks every booking named, in order, and says which one failed', async () => {
    const second = dependencyOn({ commitmentId: id('second upstream') })
    const terms = chainedTerms(plain, [dependencyOn(), second])
    const both = { disclosed: [shownUpstream, shownUpstream], terms }
    expect((await check(both)).result).toEqual(refused('dependency.not_found', PINNED, 1))
    const lock = supplierLock()
    lock.records[recordKey(second.on.commitmentId, 'buyer')] = {
      state: 'accepted',
      hasReport: false,
      termsHash: UPSTREAM_HASH,
      supplier: gpuCloud.address,
      freeCancelBy: CLOSED_FREE_CANCEL,
    }
    const { result } = await check({ ...both, script: { locks: { [SUPPLIER_LOCK]: lock } } })
    expect(result).toEqual(
      passed(
        [
          { on: dependencyOn().on, block: PINNED },
          { on: second.on, block: PINNED },
        ],
        terms,
      ),
    )
  })

  it('reads every booking named at the one block it pinned, while the chain moves on', async () => {
    const second = dependencyOn({ commitmentId: id('second upstream') })
    const terms = chainedTerms(plain, [dependencyOn(), second])
    const lock = supplierLock()
    lock.records[recordKey(second.on.commitmentId, 'buyer')] = {
      state: 'accepted',
      hasReport: false,
      termsHash: UPSTREAM_HASH,
      supplier: gpuCloud.address,
      freeCancelBy: CLOSED_FREE_CANCEL,
    }
    const first = blockAt(101n)
    const next = blockAt(102n)
    const script = { locks: { [SUPPLIER_LOCK]: lock }, heads: [first, next] }
    const disclosed = [shownUpstream, shownUpstream]
    const { result, calls } = await check({ terms, disclosed, script })
    expect(result).toEqual(
      passed(
        [
          { on: dependencyOn().on, block: first },
          { on: second.on, block: first },
        ],
        terms,
      ),
    )
    expect(calls.filter((c) => c.call === 'head')).toHaveLength(1)
    for (const c of calls) expect(c.at, c.call).toBe(first.number)
  })
})

describe('each of the twelve reasons, each triggered on its own', () => {
  const someoneElse = newKey().address
  const digestOnly = elideDependencies(chainedTerms(plain, [dependencyOn()], 'avow'), SALT)
  /**
   * What's wrong, the reason it gives, the change that makes it so, and whether a block was read,
   * none was, or the terms were refused before any dependency was looked at.
   */
  const cases: [
    string,
    ReasonCode,
    Parameters<typeof check>[0],
    'pinned' | 'not read' | 'unread terms',
  ][] = [
    [
      'the dependencies section only as its digest',
      'dependency.elided',
      {
        terms: { ...downstream, dependencies: digestOnly.dependencies } as unknown as ChainedTerms,
      },
      'unread terms',
    ],
    [
      'a chain with no supported factory',
      'dependency.lock_unknown',
      { terms: chainedTerms(plain, [dependencyOn({ chainId: 1 })]) },
      'not read',
    ],
    [
      'a lock the supported factory does not list',
      'dependency.lock_unknown',
      { script: { locks: { [SUPPLIER_LOCK]: { ...supplierLock(), listed: false } } } },
      'pinned',
    ],
    [
      'another business’s accepted booking',
      'dependency.not_owned',
      { script: { locks: { [SUPPLIER_LOCK]: { ...supplierLock(), account: someoneElse } } } },
      'pinned',
    ],
    [
      'no commitment with that id and side',
      'dependency.not_found',
      { script: withRecord(null) },
      'pinned',
    ],
    [
      'a booking the supplier supplied from its own account',
      'dependency.self_supplied',
      { script: withRecord({ supplier: supplierAccount.address }) },
      'pinned',
    ],
    [
      'a reserved booking',
      'dependency.not_accepted',
      { script: withRecord({ state: 'reserved' }) },
      'pinned',
    ],
    [
      'an accepted booking with a report filed',
      'dependency.charge_pending',
      { script: withRecord({ hasReport: true }) },
      'pinned',
    ],
    [
      'a released booking',
      'dependency.ended',
      { script: withRecord({ state: 'released' }) },
      'pinned',
    ],
    [
      'another terms hash on the lock',
      'dependency.terms_mismatch',
      { script: withRecord({ termsHash: id('other terms') }) },
      'pinned',
    ],
    ['no subject shown', 'dependency.disclosure_invalid', { disclosed: [] }, 'pinned'],
    [
      'more GPUs than the supplier booked',
      'dependency.does_not_fit',
      { terms: asking({ count: 9 }) },
      'pinned',
    ],
    ['a read that fails', 'dependency.unreadable', { script: { fails: 'commitment' } }, 'pinned'],
  ]
  for (const [name, reason, change, read] of cases) {
    it(`${name}: ${reason}`, async () => {
      const block = read === 'pinned' ? PINNED : null
      const index = read === 'unread terms' ? null : 0
      expect((await check(change)).result).toEqual(refused(reason, block, index))
    })
  }

  it('covers all twelve dependency reasons the spec has', () => {
    const named = new Set(cases.map(([, reason]) => reason))
    expect([...named].sort()).toEqual([
      'dependency.charge_pending',
      'dependency.disclosure_invalid',
      'dependency.does_not_fit',
      'dependency.elided',
      'dependency.ended',
      'dependency.lock_unknown',
      'dependency.not_accepted',
      'dependency.not_found',
      'dependency.not_owned',
      'dependency.self_supplied',
      'dependency.terms_mismatch',
      'dependency.unreadable',
    ])
  })
})

describe('provenance', () => {
  it('refuses a lookalike lock outside the factory, with the same functions and an accepted booking', async () => {
    const lookalike: Address = '0x00000000000000000000000000000000000010c7'
    // It names the supported factory in its own field, belongs to the supplier and holds the
    // booking as accepted, and the factory doesn't list it.
    const terms = chainedTerms(plain, [dependencyOn({ lock: lookalike })])
    const script = { locks: { [lookalike]: { ...supplierLock(), listed: false } } }
    const { result, calls } = await check({ terms, script })
    expect(result).toEqual(refused('dependency.lock_unknown'))
    // Nothing is read from the lookalike itself.
    expect(calls.map((c) => c.call)).toEqual(['head', 'isLock', 'blockHash'])
  })

  it('refuses a lock from a factory missing from the supported list', async () => {
    const elsewhere = { ...supplierLock(), listed: false, factory: OTHER_FACTORY }
    const script = { locks: { [SUPPLIER_LOCK]: elsewhere } }
    expect((await check({ script })).result).toEqual(refused('dependency.lock_unknown'))
  })

  it('refuses a listed lock whose own factory field names another factory', async () => {
    const script = { locks: { [SUPPLIER_LOCK]: { ...supplierLock(), factory: OTHER_FACTORY } } }
    expect((await check({ script })).result).toEqual(refused('dependency.lock_unknown'))
  })

  it('reads only the chains it supports, and passes a lock from any supported factory on one', async () => {
    const other = scriptedLocks({
      factory: OTHER_FACTORY,
      locks: {},
      head: blockAt(9n),
    })
    // Its node is a block ahead, and knows block 9 too, as any node past finality does.
    const supported = scriptedLocks({ heads: [blockAt(10n), blockAt(9n)] })
    const { result } = await check({ readers: [other.reader, supported.reader] })
    // The chain was pinned at block 9 by its first read, so the second reader reads there too.
    expect(result).toEqual(passed([{ on: dependencyOn().on, block: blockAt(9n) }]))
    expect(supported.calls.map((c) => c.call)).not.toContain('head')
    const elsewhere = scriptedLocks({ chainId: CHAIN_ID + 1 })
    expect((await check({ readers: [elsewhere.reader] })).result).toEqual(
      refused('dependency.lock_unknown', null),
    )
    expect(elsewhere.calls).toEqual([])
    expect((await check({ readers: [] })).result).toEqual(refused('dependency.lock_unknown', null))
  })

  it('stops at the first supported factory that lists the lock', async () => {
    const supported = scriptedLocks({ head: blockAt(10n) })
    const other = scriptedLocks({ factory: OTHER_FACTORY, locks: {} })
    const { result } = await check({ readers: [supported.reader, other.reader] })
    expect(result).toEqual(passed([{ on: dependencyOn().on, block: blockAt(10n) }]))
    expect(other.calls).toEqual([])
  })

  it('records the block the chain was pinned at when no factory lists the lock', async () => {
    const first = scriptedLocks({ locks: {}, head: blockAt(9n) })
    const second = scriptedLocks({
      factory: OTHER_FACTORY,
      locks: {},
      heads: [PINNED, blockAt(9n)],
    })
    const { result } = await check({ readers: [first.reader, second.reader] })
    expect(result).toEqual(refused('dependency.lock_unknown', blockAt(9n)))
    for (const c of second.calls) expect(c.at, c.call).toBe(9n)
  })
})

describe('ownership', () => {
  it('refuses a booking on the supplier side before reading anything, as the terms forbid it', async () => {
    const terms = chainedTerms(plain, [dependencyOn({ side: 'supplier' })])
    const lock = supplierLock()
    lock.records[recordKey(UPSTREAM_COMMITMENT, 'supplier')] = {
      state: 'accepted',
      hasReport: false,
      termsHash: UPSTREAM_HASH,
      supplier: gpuCloud.address,
      freeCancelBy: CLOSED_FREE_CANCEL,
    }
    const script = { locks: { [SUPPLIER_LOCK]: lock } }
    const { result, calls } = await check({ terms, script })
    expect(result).toEqual(refused('terms.invalid', null, null))
    expect(calls).toEqual([])
  })

  it('refuses when Avow’s approval names another supplier than the lock’s account', async () => {
    const { result } = await check({ supplier: newKey().address })
    expect(result).toEqual(refused('dependency.not_owned'))
  })

  it('takes the owner from the approval alone, so a seller naming the lock’s owner gains nothing', async () => {
    // A seller that cites the supplier's booking is refused once Avow's approval names the seller,
    // whoever the seller claims to be.
    const seller = newKey().address
    const { result } = await check({ approval: approvedFor(seller) })
    expect(result).toEqual(refused('dependency.not_owned'))
  })

  it('refuses an approval for the supplier side before reading anything', async () => {
    const approval = { side: 'supplier', supplier: supplierAccount.address } as const
    const { result, calls } = await check({ approval })
    expect(result).toEqual(refused('approval.terms_mismatch', null, null))
    expect(calls).toEqual([])
  })
})

describe('a job that relies on the compute it runs on', () => {
  const job = chainedJobTerms(testnetDemoJobTerms(START, ARBITER), [dependencyOn()])

  it('passes when the supplier’s accepted GPU booking holds the job’s compute for its whole run', async () => {
    const { result } = await check({ terms: job })
    expect(result).toEqual(passed([{ on: dependencyOn().on, block: PINNED }], job))
  })

  it('refuses a job whose terms say Avow checks, before reading anything', async () => {
    const avow = { ...job, dependencyCheck: 'avow' } as never
    const { result, calls } = await check({ terms: avow })
    expect(result).toEqual(refused('terms.template_invalid', null, null))
    expect(calls).toEqual([])
  })

  it('refuses compute that ends before the job’s deadline, and compute still freely cancellable', async () => {
    const tooLate = chainedJobTerms(testnetDemoJobTerms(START + 3500n, ARBITER), [dependencyOn()])
    expect((await check({ terms: tooLate })).result).toEqual(refused('dependency.does_not_fit'))
    const open = withRecord({ freeCancelBy: PINNED.timestamp + 5n })
    expect((await check({ terms: job, script: open })).result).toEqual(
      refused('dependency.cancellable'),
    )
  })
})

describe('a link to verify a job', () => {
  const JOB_COMMITMENT = id('the job')
  const jobTerms = chainedJobTerms(testnetDemoJobTerms(START, ARBITER), [dependencyOn()])
  const reference = {
    kind: 'commitment',
    chainId: CHAIN_ID,
    lock: LOCK,
    commitmentId: JOB_COMMITMENT,
    side: 'buyer',
    termsHash: termsHash(jobTerms, SALT),
  } as const
  const verification = jobVerificationOf(jobTerms, SALT, reference)

  /** The customer's lock, holding the job as the developer's business accepted it. */
  const customerLock = (record: Partial<DependencyRecord> | null = {}) => ({
    ...supplierLock(null),
    account: buyer.address,
    records: record
      ? {
          [recordKey(JOB_COMMITMENT, 'buyer')]: {
            state: 'accepted' as const,
            hasReport: false,
            termsHash: reference.termsHash,
            supplier: supplierAccount.address,
            freeCancelBy: START,
            ...record,
          },
        }
      : {},
  })

  async function read(
    change: {
      job?: Partial<DependencyRecord> | null
      compute?: Partial<DependencyRecord>
      v?: JobVerification
      head?: PinnedBlock
    } = {},
  ) {
    const locks = {
      [LOCK]: customerLock(change.job === undefined ? {} : change.job),
      [SUPPLIER_LOCK]: supplierLock(change.compute ?? {}),
    }
    const { reader, calls } = scriptedLocks({
      locks,
      ...(change.head ? { head: change.head } : {}),
    })
    const result = await verifyJobVerification(
      { verification: change.v ?? verification, now: NOW },
      { readers: [reader] },
    )
    return { result, calls }
  }

  /** A link's refusal, which carries no job, so nothing in it can be drawn as standing. */
  const linkRefused = (
    reason: ReasonCode,
    block: PinnedBlock | null = PINNED,
    index: number | null = 0,
  ) => ({ outcome: 'refused', reason, index, block })
  const standing = { booking: dependencyOn().on, readAt: PINNED, fit: 'unchecked', standing: true }
  const reserved = { state: 'reserved' as const }

  it('says an accepted job stands, reading the job and its compute at one block', async () => {
    const { result, calls } = await read()
    expect(result).toEqual({
      outcome: 'stands',
      job: { state: 'accepted', freeCancelBy: START, block: PINNED },
      supplier: supplierAccount.address,
      bookings: [standing],
    })
    for (const c of calls) expect(c.at, c.call).toBe(PINNED.number)
  })

  it('says a reserved job awaits acceptance, with every booking it relies on standing', async () => {
    const { result } = await read({ job: { ...reserved, freeCancelBy: START + 60n } })
    expect(result).toEqual({
      outcome: 'awaiting_acceptance',
      job: { state: 'reserved', freeCancelBy: START + 60n, block: PINNED },
      supplier: supplierAccount.address,
      bookings: [standing],
    })
  })

  it('says a job ended once a charge is pending or paused, or its reserve released, charged or resolved', async () => {
    for (const state of ['charge_pending', 'paused', 'released', 'charged', 'resolved'] as const) {
      const { result } = await read({ job: { state } })
      expect(result, state).toEqual({
        outcome: 'ended',
        job: { state, freeCancelBy: START, block: PINNED },
        supplier: supplierAccount.address,
        bookings: [standing],
      })
    }
  })

  it('counts an accepted job with a report filed as a charge pending, as the booking check does', async () => {
    const { result } = await read({ job: { hasReport: true } })
    expect(result).toMatchObject({ outcome: 'ended', job: { state: 'charge_pending' } })
    // The same rule refuses a booking relied on in the same state.
    const compute = await read({ ...{ job: reserved }, compute: { hasReport: true } })
    expect(compute.result).toEqual(linkRefused('dependency.charge_pending'))
  })

  it('leaves an accepted job standing when its compute was released after, and reports the booking as read', async () => {
    // The challenge: the developer's business cancels the compute after the customer accepted.
    const { result } = await read({ compute: { state: 'released' } })
    expect(result).toEqual({
      outcome: 'stands',
      job: { state: 'accepted', freeCancelBy: START, block: PINNED },
      supplier: supplierAccount.address,
      bookings: [{ ...standing, standing: false, reason: 'dependency.ended' }],
    })
    // An ended job reports its bookings the same way, and its outcome stays its own.
    const ended = await read({ job: { state: 'released' }, compute: { state: 'released' } })
    expect(ended.result).toMatchObject({
      outcome: 'ended',
      bookings: [{ standing: false, reason: 'dependency.ended', readAt: PINNED }],
    })
  })

  it('refuses a link whose parts don’t hash to its reference, reading nothing', async () => {
    const tampered = { ...verification, dependenciesSalt: id('another salt') }
    const { result, calls } = await read({ v: tampered })
    expect(result).toEqual(linkRefused('terms.hash_mismatch', null, null))
    expect(calls).toEqual([])
  })

  it('refuses a customer’s lock that holds no job under that terms hash, before any compute', async () => {
    for (const job of [null, { termsHash: id('other terms') }]) {
      const { result, calls } = await read({ job })
      expect(result).toEqual(linkRefused('reference.commitment_mismatch', PINNED, null))
      // Only the job was read, never the compute.
      expect(calls.filter((c) => c.call === 'commitment')).toHaveLength(1)
    }
  })

  it('refuses a customer’s lock no supported factory made, or one on a chain it has no reader for', async () => {
    const unlisted = scriptedLocks({
      locks: {
        [LOCK]: { ...customerLock(), listed: false },
        [SUPPLIER_LOCK]: supplierLock(),
      },
    })
    const unknown = await verifyJobVerification(
      { verification, now: NOW },
      { readers: [unlisted.reader] },
    )
    expect(unknown).toEqual(linkRefused('chain.lock_unknown', PINNED, null))
    // Nothing is read from a lock the factory doesn't list.
    expect(unlisted.calls.map((c) => c.call)).toEqual(['head', 'isLock', 'blockHash'])
    const elsewhere = scriptedLocks({ chainId: CHAIN_ID + 1 })
    const noReader = await verifyJobVerification(
      { verification, now: NOW },
      { readers: [elsewhere.reader] },
    )
    expect(noReader).toEqual(linkRefused('chain.lock_unknown', null, null))
    expect(elsewhere.calls).toEqual([])
  })

  it('names the job, never a booking relied on, when the read of the job fails', async () => {
    const locks = { [LOCK]: customerLock(), [SUPPLIER_LOCK]: supplierLock() }
    for (const call of ['commitment', 'head'] as const) {
      const { reader } = scriptedLocks({ locks, fails: call })
      const result = await verifyJobVerification({ verification, now: NOW }, { readers: [reader] })
      expect(result, call).toEqual(
        linkRefused('reference.unreadable', call === 'head' ? null : PINNED, null),
      )
    }
  })

  it('refuses a reference to the supplier side before reading anything', async () => {
    const seller = { ...verification, commitment: { ...reference, side: 'supplier' as const } }
    const { result, calls } = await read({ v: seller })
    expect(result).toEqual(linkRefused('reference.commitment_mismatch', null, null))
    expect(calls).toEqual([])
  })

  it('refuses a reserved job whose compute sits in a lock that isn’t the supplier’s the customer’s lock names', async () => {
    const { result } = await read({ job: { ...reserved, supplier: newKey().address } })
    expect(result).toEqual(linkRefused('dependency.not_owned'))
  })

  it('refuses a reserved job whose compute ended, is still freely cancellable, or was read at a stale block', async () => {
    expect((await read({ job: reserved, compute: { state: 'released' } })).result).toEqual(
      linkRefused('dependency.ended'),
    )
    const open = { freeCancelBy: PINNED.timestamp + 1n }
    expect((await read({ job: reserved, compute: open })).result).toEqual(
      linkRefused('dependency.cancellable'),
    )
    const old = { ...PINNED, timestamp: NOW - 31n }
    expect((await read({ job: reserved, head: old })).result).toEqual(
      linkRefused('dependency.stale', old, null),
    )
  })

  it('passes compute too small for the job, since fit needs the job’s subject', async () => {
    // Nine GPUs, where the booking relied on holds eight.
    const big = testnetDemoJobTerms(START, ARBITER)
    const nine = {
      ...big,
      subject: { ...big.subject, compute: { ...big.subject.compute, count: 9 } },
    }
    const terms = chainedJobTerms(nine, [dependencyOn()])
    const hash = termsHash(terms, SALT)
    const v = jobVerificationOf(terms, SALT, { ...reference, termsHash: hash })
    const { result } = await read({ v, job: { ...reserved, termsHash: hash } })
    expect(result).toMatchObject({ outcome: 'awaiting_acceptance', bookings: [standing] })
  })

  it('gives entries that can’t pass for the full check’s, which tested fit', async () => {
    const { result } = await read()
    if (result.outcome === 'refused') throw new Error('expected a job')
    // A CheckedDependency has `on` and `block`, which a booking the link names never carries.
    for (const b of result.bookings) {
      expect(b).not.toHaveProperty('on')
      expect(b).not.toHaveProperty('block')
    }
  })
})

describe('fresh reads', () => {
  it('refuses a finalized block older than the limit, naming it and reading no lock', async () => {
    const old = { ...PINNED, timestamp: NOW - 31n }
    const { result, calls } = await check({ script: { head: old } })
    expect(result).toEqual(refused('dependency.stale', old))
    expect(calls.map((c) => c.call)).toEqual(['head'])
  })

  it('passes a finalized block exactly at the limit, and one a skewed clock puts ahead', async () => {
    const atLimit = { ...PINNED, timestamp: NOW - 30n }
    expect((await check({ script: { head: atLimit } })).result.ok).toBe(true)
    const ahead = { ...PINNED, timestamp: NOW + 5n }
    expect((await check({ script: { head: ahead } })).result.ok).toBe(true)
  })

  it('holds the block to a limit the caller sets', async () => {
    const tenSecondsOld = { ...PINNED, timestamp: NOW - 10n }
    const script = { head: tenSecondsOld }
    expect((await check({ script, maxReadAge: 5n })).result).toEqual(
      refused('dependency.stale', tenSecondsOld),
    )
    expect((await check({ script, maxReadAge: 10n })).result.ok).toBe(true)
  })
})

describe('free cancellation', () => {
  it('refuses a booking its buyer could still cancel at no charge at the block read', async () => {
    // The lock takes a free cancellation in any block whose timestamp is before the deadline.
    const open = withRecord({ freeCancelBy: PINNED.timestamp + 1n })
    expect((await check({ script: open })).result).toEqual(refused('dependency.cancellable'))
  })

  it('passes once the block read is at the deadline, when the lock refuses a free cancellation', async () => {
    const closing = withRecord({ freeCancelBy: PINNED.timestamp })
    expect((await check({ script: closing })).result.ok).toBe(true)
  })

  it('names a reserved booking as not accepted, whatever its free cancellation', async () => {
    const reserved = withRecord({ state: 'reserved', freeCancelBy: PINNED.timestamp + 60n })
    expect((await check({ script: reserved })).result).toEqual(refused('dependency.not_accepted'))
  })
})

describe('state', () => {
  const expected: { readonly [S in RailState]: ReasonCode | null } = {
    none: 'dependency.not_found',
    reserved: 'dependency.not_accepted',
    accepted: null,
    charge_pending: 'dependency.charge_pending',
    paused: 'dependency.charge_pending',
    released: 'dependency.ended',
    charged: 'dependency.ended',
    resolved: 'dependency.ended',
  }

  for (const state of RAIL_STATES) {
    it(`gives ${expected[state] ?? 'a pass'} for a booking the lock holds as ${state}`, async () => {
      const { result } = await check({ script: withRecord({ state }) })
      const reason = expected[state]
      expect(result).toEqual(reason ? refused(reason) : expect.objectContaining({ ok: true }))
    })
  }

  it('passes only an accepted booking with no report filed', async () => {
    for (const state of RAIL_STATES) {
      const { result } = await check({ script: withRecord({ state, hasReport: true }) })
      expect(result.ok, state).toBe(false)
    }
  })

  it('refuses a booking released as kept after its job started', async () => {
    // The lock records a kept booking as released, whatever the job did.
    const { result } = await check({ script: withRecord({ state: 'released' }) })
    expect(result).toEqual(refused('dependency.ended'))
  })
})

describe('cycles', () => {
  it('refuses both bookings of a two-booking cycle, since each needs the other accepted first', async () => {
    // The supplier's sale X relies on Y, which it bought from a second seller, and that seller's
    // sale Y relies on X, which it bought from the supplier. Each lock holds the other's booking
    // as reserved until its seller accepts, and each seller checks before it accepts. Their terms
    // hashes can't name each other either, since each covers the other, so this names whatever
    // each lock holds.
    const secondSeller = newKey()
    const SECOND_LOCK: Address = '0x00000000000000000000000000000000000010c8'
    const x = id('x, which the supplier sells')
    const y = id('y, which the second seller sells')
    const reservedBy = (supplier: Address, termsHash: Hex) => ({
      state: 'reserved' as const,
      hasReport: false,
      termsHash,
      supplier,
      freeCancelBy: CLOSED_FREE_CANCEL,
    })
    const locks = {
      [SUPPLIER_LOCK]: {
        ...supplierLock(null),
        records: { [recordKey(y, 'buyer')]: reservedBy(secondSeller.address, id('y terms')) },
      },
      [SECOND_LOCK]: {
        ...supplierLock(null),
        account: secondSeller.address,
        records: { [recordKey(x, 'buyer')]: reservedBy(supplierAccount.address, id('x terms')) },
      },
    }
    const xTerms = chainedTerms(plain, [
      dependencyOn({ commitmentId: y, termsHash: id('y terms') }),
    ])
    const yTerms = chainedTerms(plain, [
      dependencyOn({ lock: SECOND_LOCK, commitmentId: x, termsHash: id('x terms') }),
    ])
    const forX = await check({ terms: xTerms, script: { locks } })
    const forY = await check({ terms: yTerms, supplier: secondSeller.address, script: { locks } })
    expect(forX.result).toEqual(refused('dependency.not_accepted'))
    expect(forY.result).toEqual(refused('dependency.not_accepted'))
  })
})

describe('self-supply', () => {
  it('refuses a booking the seller supplied from its own account, read at the same block', async () => {
    const script = withRecord({ supplier: supplierAccount.address })
    const { result, calls } = await check({ script })
    expect(result).toEqual(refused('dependency.self_supplied'))
    for (const c of calls) expect(c.at, c.call).toBe(PINNED.number)
  })

  it("can't tell a second business the same owner registered, which has its own account", async () => {
    const secondBusiness = newKey().address
    const { result } = await check({ script: withRecord({ supplier: secondBusiness }) })
    expect(result.ok).toBe(true)
  })
})

describe('terms and what the supplier shows', () => {
  it('refuses a shown section that is another section, changed or from other terms', async () => {
    const consideration = json(discloseSection(upstreamTerms, UPSTREAM_SALT, 'consideration'))
    const changed = {
      ...shownUpstream,
      content: {
        ...shownUpstream.content,
        resource: { ...shownUpstream.content.resource, count: 16 },
      },
    }
    const otherSalt = json(discloseSection(upstreamTerms, `0x${'78'.repeat(32)}`, 'subject'))
    for (const shown of [consideration, changed, otherSalt, { anything: 1 }, null]) {
      const { result } = await check({ disclosed: [shown] })
      expect(result).toEqual(refused('dependency.disclosure_invalid'))
    }
  })

  it('refuses more shown sections than the terms name', async () => {
    const { result } = await check({ disclosed: [shownUpstream, shownUpstream] })
    expect(result).toEqual(refused('message.invalid', null, null))
  })
})

describe('fit', () => {
  it('passes fewer GPUs, under another SKU, inside the window', async () => {
    const fewer = asking({ count: 2, sku: 'resold-h100x2' }, { windowStart: START + 600n })
    expect((await check({ terms: fewer })).result.ok).toBe(true)
  })

  it('refuses a subject its template refuses before reading anything, since nothing fits it', async () => {
    const refusedSubjects: [ReturnType<typeof asking>, ReasonCode][] = [
      [asking({ count: 0 }), 'terms.template_invalid'],
      [asking({ count: -3 }), 'terms.template_invalid'],
      [asking({}, { windowDuration: 0n }), 'terms.deadlines_out_of_order'],
      [asking({}, { windowDuration: -1800n }), 'terms.deadlines_out_of_order'],
    ]
    for (const [terms, reason] of refusedSubjects) {
      const { result, calls } = await check({ terms })
      expect(result).toEqual(refused(reason, null, null))
      expect(calls).toEqual([])
    }
  })

  it('refuses a subject of another shape before reading anything, and never throws', async () => {
    const shapes = [{}, { ...plain.subject, resource: null }, { ...plain.subject, windowStart: 1 }]
    for (const subject of shapes) {
      const terms = { ...downstream, subject } as unknown as ChainedTerms
      const { result, calls } = await check({ terms })
      expect(result).toEqual(refused('terms.template_invalid', null, null))
      expect(calls).toEqual([])
    }
  })

  it('refuses more GPUs, another GPU or region, or a window outside the upstream one', async () => {
    const misfits = [
      asking({ count: 9 }),
      asking({ gpu: 'A100' }),
      asking({ region: 'elsewhere' }),
      asking({}, { windowStart: START - 60n }),
      asking({}, { windowStart: START + 3600n - 1200n, windowDuration: 1800n }),
    ]
    for (const terms of misfits) {
      expect((await check({ terms })).result).toEqual(refused('dependency.does_not_fit'))
    }
  })
})

describe('reads pinned to one block', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  for (const call of ['head', 'isLock', 'lockFields', 'commitment', 'blockHash'] as const) {
    it(`gives dependency.unreadable when ${call} fails`, async () => {
      const { result } = await check({ script: { fails: call } })
      expect(result).toEqual(refused('dependency.unreadable', call === 'head' ? null : PINNED))
    })
  }

  it('gives dependency.unreadable, never not found, when the read of an empty lock fails', async () => {
    const { result } = await check({ script: { ...withRecord(null), fails: 'commitment' } })
    expect(result).toEqual(refused('dependency.unreadable'))
  })

  it('gives dependency.unreadable, never a pass, when a read times out', async () => {
    vi.useFakeTimers()
    const { reader } = scriptedLocks({ hangs: 'commitment' })
    const pending = verifyDependencies(
      {
        terms: downstream,
        approval: approvedFor(supplierAccount.address),
        disclosed: [shownUpstream],
        now: NOW,
      },
      { readers: [reader], timeoutMs: 5000 },
    )
    await vi.advanceTimersByTimeAsync(5000)
    expect(await pending).toEqual(refused('dependency.unreadable'))
  })

  it('waits ten seconds by default before it gives up', async () => {
    vi.useFakeTimers()
    const { reader } = scriptedLocks({ hangs: 'isLock' })
    let settled = false
    const pending = verifyDependencies(
      {
        terms: downstream,
        approval: approvedFor(supplierAccount.address),
        disclosed: [shownUpstream],
        now: NOW,
      },
      { readers: [reader] },
    ).finally(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(9999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toEqual(refused('dependency.unreadable'))
  })

  it('gives dependency.unreadable when the block at that height changed during the reads', async () => {
    const { result } = await check({ script: { rehash: id('another block') } })
    expect(result).toEqual(refused('dependency.unreadable'))
  })

  it('gives dependency.unreadable when the node no longer has the block', async () => {
    const { result } = await check({ script: { rehash: null } })
    expect(result).toEqual(refused('dependency.unreadable'))
  })

  it('reads every booking on one chain at one block, even through two readers there', async () => {
    // Two factories on one chain: the job sits in the first's lock, the compute in the second's.
    const JOB_COMMITMENT = id('the job')
    const job = chainedJobTerms(testnetDemoJobTerms(START, ARBITER), [dependencyOn()])
    const reference = {
      kind: 'commitment',
      chainId: CHAIN_ID,
      lock: LOCK,
      commitmentId: JOB_COMMITMENT,
      side: 'buyer',
      termsHash: termsHash(job, SALT),
    } as const
    const first = scriptedLocks({
      locks: {
        [LOCK]: {
          ...supplierLock(null),
          account: buyer.address,
          records: {
            [recordKey(JOB_COMMITMENT, 'buyer')]: {
              state: 'accepted',
              hasReport: false,
              termsHash: reference.termsHash,
              supplier: supplierAccount.address,
              freeCancelBy: START,
            },
          },
        },
      },
    })
    // The second reader's node is a few blocks ahead, so pinning on its own would pick 4326.
    const second = scriptedLocks({
      factory: OTHER_FACTORY,
      heads: [blockAt(4326n), PINNED],
      locks: { [SUPPLIER_LOCK]: { ...supplierLock(), factory: OTHER_FACTORY } },
    })
    const result = await verifyJobVerification(
      { verification: jobVerificationOf(job, SALT, reference), now: NOW },
      { readers: [first.reader, second.reader] },
    )
    expect(result).toMatchObject({
      outcome: 'stands',
      job: { block: PINNED },
      bookings: [{ readAt: PINNED, standing: true }],
    })
    for (const c of [...first.calls, ...second.calls]) expect(c.at, c.call).toBe(PINNED.number)
    expect(second.calls.map((c) => c.call)).not.toContain('head')
  })

  it('gives dependency.unreadable, never lock_unknown, when an unlisted lock’s block moved', async () => {
    const script = {
      locks: { [SUPPLIER_LOCK]: { ...supplierLock(), listed: false } },
      rehash: id('another block'),
    }
    expect((await check({ script })).result).toEqual(refused('dependency.unreadable'))
  })
})

describe('the terms it checks', () => {
  it('refuses terms that are not version 3, or whose dependencies break the rules', async () => {
    const v2 = { terms: plain as unknown as ChainedTerms }
    expect((await check(v2)).result).toEqual(refused('terms.version_unknown', null, null))
    const twice = chainedTerms(plain, [dependencyOn(), dependencyOn()] as unknown as Dependencies)
    expect((await check({ terms: twice })).result).toEqual(refused('terms.invalid', null, null))
    const { dependencies: _, ...none } = downstream
    expect((await check({ terms: none as ChainedTerms })).result).toEqual(
      refused('terms.incomplete', null, null),
    )
  })
})
