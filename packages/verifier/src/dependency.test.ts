import {
  type ChainedTerms,
  chainedTerms,
  type Dependencies,
  discloseSection,
  elideDependencies,
  RAIL_STATES,
  type RailState,
  type ReasonCode,
  testnetDemoTerms,
} from '@avow-finance/spec'
import type { Address, Hex } from 'viem'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type DependencyDeps,
  type DependencyInput,
  type PinnedBlock,
  type PinnedLockReader,
  verifyDependencies,
} from './dependency.js'
import {
  ARBITER,
  CHAIN_ID,
  dependencyOn,
  gpuCloud,
  id,
  json,
  type LockScript,
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

async function check(
  change: Partial<DependencyInput> & { script?: LockScript; readers?: PinnedLockReader[] } = {},
) {
  const { reader, calls } = scriptedLocks(change.script)
  const input: DependencyInput = {
    terms: change.terms ?? downstream,
    supplier: change.supplier ?? supplierAccount.address,
    disclosed: change.disclosed ?? [shownUpstream],
  }
  const deps: DependencyDeps = { readers: change.readers ?? [reader] }
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
    const { result } = await check(input)
    expect(result.ok).toBe(true)
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
    const supplier = supplierAccount.address
    const a = await verifyDependencies({ terms: four, supplier, disclosed: [shownUpstream] }, deps)
    const b = await verifyDependencies({ terms: eight, supplier, disclosed: [shownUpstream] }, deps)
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
    }
    const first = { number: 101n, hash: id('block 101') }
    const next = { number: 102n, hash: id('block 102') }
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
      head: { number: 9n, hash: id('block 9') },
    })
    const supported = scriptedLocks({ head: { number: 10n, hash: id('block 10') } })
    const { result } = await check({ readers: [other.reader, supported.reader] })
    expect(result).toEqual(
      passed([{ on: dependencyOn().on, block: { number: 10n, hash: id('block 10') } }]),
    )
    const elsewhere = scriptedLocks({ chainId: CHAIN_ID + 1 })
    expect((await check({ readers: [elsewhere.reader] })).result).toEqual(
      refused('dependency.lock_unknown', null),
    )
    expect(elsewhere.calls).toEqual([])
    expect((await check({ readers: [] })).result).toEqual(refused('dependency.lock_unknown', null))
  })

  it('stops at the first supported factory that lists the lock', async () => {
    const supported = scriptedLocks({ head: { number: 10n, hash: id('block 10') } })
    const other = scriptedLocks({ factory: OTHER_FACTORY, locks: {} })
    const { result } = await check({ readers: [supported.reader, other.reader] })
    expect(result).toEqual(
      passed([{ on: dependencyOn().on, block: { number: 10n, hash: id('block 10') } }]),
    )
    expect(other.calls).toEqual([])
  })

  it('records the block of the last factory read when none lists the lock', async () => {
    const first = scriptedLocks({ locks: {}, head: { number: 9n, hash: id('block 9') } })
    const second = scriptedLocks({ factory: OTHER_FACTORY, locks: {} })
    const { result } = await check({ readers: [first.reader, second.reader] })
    expect(result).toEqual(refused('dependency.lock_unknown'))
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
    }
    const script = { locks: { [SUPPLIER_LOCK]: lock } }
    const { result, calls } = await check({ terms, script })
    expect(result).toEqual(refused('terms.invalid', null, null))
    expect(calls).toEqual([])
  })

  it('refuses when the booking names another supplier than the lock’s account', async () => {
    const { result } = await check({ supplier: newKey().address })
    expect(result).toEqual(refused('dependency.not_owned'))
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
      { terms: downstream, supplier: supplierAccount.address, disclosed: [shownUpstream] },
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
      { terms: downstream, supplier: supplierAccount.address, disclosed: [shownUpstream] },
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
