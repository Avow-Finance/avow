import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Hex } from 'viem'
import { describe, expect, it } from 'vitest'
import {
  COMMITMENT_EVENT_CODES,
  COMMITMENT_EVENT_KEYS,
  COMMITMENT_EVENT_SOURCES,
  COMMITMENT_EVENT_STATED_BY,
  type CommitmentEvent,
  type CommitmentEventCode,
  type CommitmentEventFact,
  commitmentEvent,
  commitmentEventFields,
  commitmentEventHash,
  commitmentEventId,
  commitmentEventProblem,
  type LockPlace,
  lockOrder,
  type ObservedBy,
  parseCommitmentEvent,
} from './commitment-event.js'
import { dollars } from './demo.js'
import type { CommitmentReference } from './references.js'
import { CHAIN_ID, id, LOCK, NOW, OTHER_LOCK } from './test-helpers.js'
import { COMMITMENT_EVENT_VERSION } from './version.js'
import { toWire } from './wire.js'

const h = (byte: string): Hex => `0x${byte.repeat(32)}`
const commitment: CommitmentReference = {
  kind: 'commitment',
  chainId: CHAIN_ID,
  lock: LOCK,
  commitmentId: h('c1'),
  side: 'buyer',
  termsHash: h('7e'),
}
const who = {
  commitment,
  buyerBusinessId: 'biz_buyer',
  supplierBusinessId: 'biz_supplier',
  reserve: dollars(500),
}
const block = (blockNumber: bigint, logIndex = 0): ObservedBy<'block'> => ({
  source: 'block',
  at: NOW + blockNumber,
  blockNumber,
  transactionHash: h('ab'),
  logIndex,
})
const avow: ObservedBy<'avow'> = { source: 'avow', at: NOW }
const supplier: ObservedBy<'supplier'> = { source: 'supplier', at: NOW + 1n }
const agreementExpiry = NOW + 600n

/** One event for every code and every source that can state it, in the order of a life. */
const facts: CommitmentEventFact[] = [
  { ...who, code: 'booking.agreed', ...avow, agreementExpiry },
  { ...who, code: 'booking.agreed', ...supplier, agreementExpiry },
  {
    ...who,
    code: 'reserve.approved',
    ...avow,
    approvalHash: h('a9'),
    approvalExpiry: NOW + 120n,
  },
  {
    ...who,
    code: 'reserve.locked',
    ...block(10n),
    approvalHash: h('a9'),
    mandateHash: h('3a'),
  },
  { ...who, code: 'reserve.held', ...supplier, agreementExpiry },
  { ...who, code: 'reserve.accepted', ...block(11n) },
  { ...who, code: 'reserve.accepted', ...supplier, agreementExpiry, acceptedIn: h('ab') },
  { ...who, code: 'booking.lapsed', ...avow, agreementExpiry },
  { ...who, code: 'booking.lapsed', ...supplier, agreementExpiry },
  { ...who, code: 'booking.start_requested', ...avow, requestHash: h('51') },
  { ...who, code: 'booking.started', ...avow, requestHash: h('51'), startedAt: NOW + 5n },
  { ...who, code: 'booking.cancelled_late', ...avow, requestHash: h('ca') },
  {
    ...who,
    code: 'charge.reported',
    ...block(12n),
    reportNumber: 1,
    kind: 'lateCancellation',
    amount: dollars(250),
    evidenceHash: h('e1'),
    answerBy: NOW + 900n,
    contested: false,
  },
  { ...who, code: 'charge.withdrawn', ...block(13n), reportNumber: 1 },
  {
    ...who,
    code: 'charge.confirmed',
    ...block(14n),
    reportNumber: 2,
    amount: dollars(250),
    returned: dollars(250),
    contestableUntil: NOW + 1500n,
  },
  { ...who, code: 'charge.referred', ...block(14n), reportNumber: 2, returned: 0n },
  {
    ...who,
    code: 'charge.unanswered',
    ...block(15n),
    reportNumber: 2,
    pausedAt: NOW + 900n,
    returned: dollars(250),
  },
  { ...who, code: 'charge.paused', ...block(15n, 1), reportNumber: 2 },
  {
    ...who,
    code: 'charge.contested',
    ...block(16n),
    reportNumber: 2,
    reason: 'never_cancelled',
    statementHash: h('5e'),
    pausedAt: NOW + 16n,
    returned: 0n,
  },
  {
    ...who,
    code: 'charge.evidence_filed',
    ...block(17n),
    filer: 'supplier',
    number: 1,
    evidenceHash: h('e2'),
  },
  {
    ...who,
    code: 'charge.ruled',
    ...block(18n),
    ruledBy: 'avow',
    toSupplier: dollars(100),
    evidenceHash: h('e3'),
  },
  {
    ...who,
    code: 'charge.paid',
    ...block(19n),
    reportNumber: 2,
    kind: 'lateCancellation',
    amount: dollars(250),
  },
  {
    ...who,
    code: 'charge.resolved',
    ...block(19n),
    outcome: 'ruled',
    toSupplier: dollars(100),
    toBusiness: dollars(150),
  },
  {
    ...who,
    code: 'reserve.released',
    ...block(20n),
    outcome: 'kept',
    returned: dollars(500),
  },
]
const events = facts.map(commitmentEvent)
const named = (e: CommitmentEvent) => `${e.code} by ${e.source}`
const of = <C extends CommitmentEventCode>(code: C, source = 'block') => {
  const found = events.find((e) => e.code === code && e.source === source)
  if (!found) throw new Error(`no ${code} event by ${source}`)
  return found as CommitmentEvent<C>
}
const wire = (value: unknown) => JSON.parse(JSON.stringify(toWire(value)))
const reason = (json: unknown) => {
  const read = parseCommitmentEvent(json)
  return read.ok ? null : read.reason
}
const invalid = 'message.invalid'
const unknown = 'message.schema_unknown'
/** An event with fields changed and the id they then derive, so only the change is at fault. */
const changed = (e: CommitmentEvent, change: object) => {
  const next = { ...e, ...change } as CommitmentEvent
  try {
    return { ...next, id: commitmentEventId(next) }
  } catch {
    // Fields that derive no id, such as a code nobody knows, leave the event the id it had.
    return next
  }
}
const thrower = (e: object) =>
  new Proxy(e, {
    get() {
      throw new Error('read')
    },
  })

describe('the codes of a commitment event', () => {
  it('has a sample here for every code and every source that can state it', () => {
    const seen = new Map<string, string[]>()
    for (const e of events) seen.set(e.code, [...(seen.get(e.code) ?? []), e.source])
    expect(Object.fromEntries(seen)).toEqual(
      Object.fromEntries(COMMITMENT_EVENT_CODES.map((c) => [c, COMMITMENT_EVENT_STATED_BY[c]])),
    )
  })

  it('names each code as a subject and what happened to it', () => {
    for (const code of COMMITMENT_EVENT_CODES) {
      expect(code).toMatch(/^(booking|reserve|charge)\.[a-z]+(_[a-z]+)*$/)
    }
  })

  it('states what a lock logged from a block, and what only a party saw from its clock', () => {
    const by = COMMITMENT_EVENT_STATED_BY
    for (const code of COMMITMENT_EVENT_CODES) {
      expect(by[code].length, code).toBeGreaterThan(0)
      for (const source of by[code]) expect(COMMITMENT_EVENT_SOURCES).toContain(source)
      if (code.startsWith('charge.')) expect(by[code], code).toEqual(['block'])
    }
    expect(by['reserve.locked']).toEqual(['block'])
    expect(by['reserve.released']).toEqual(['block'])
    expect(by['reserve.approved']).toEqual(['avow'])
    expect(by['reserve.held']).toEqual(['supplier'])
    expect(by['reserve.accepted']).toEqual(['block', 'supplier'])
  })

  it('derives every id from fields each source that states the code carries', () => {
    for (const code of COMMITMENT_EVENT_CODES) {
      for (const source of COMMITMENT_EVENT_SOURCES) {
        const fields = commitmentEventFields(code, source)
        expect(fields !== null, `${code} by ${source}`).toBe(
          COMMITMENT_EVENT_STATED_BY[code].includes(source),
        )
        if (fields) expect(fields).toEqual(expect.arrayContaining([...COMMITMENT_EVENT_KEYS[code]]))
      }
    }
  })

  it("gives no code a field with the name of a common field or of a source's", () => {
    const common = ['schemaVersion', 'id', 'code', 'commitment', 'buyerBusinessId']
    common.push('supplierBusinessId', 'reserve', 'source', 'at')
    const located = ['blockNumber', 'transactionHash', 'logIndex']
    for (const e of events) {
      const own = commitmentEventFields(e.code, e.source) ?? []
      const shared = e.source === 'block' ? [...common, ...located] : common
      expect(
        own.filter((name) => [...common, ...located].includes(name)),
        named(e),
      ).toEqual([])
      expect(Object.keys(e).sort(), named(e)).toEqual([...shared, ...own].sort())
    }
  })

  it('carries no text, only hex, business ids and words from fixed lists', () => {
    const strings = (v: unknown): string[] =>
      typeof v === 'string'
        ? [v]
        : typeof v === 'object' && v !== null
          ? Object.values(v).flatMap(strings)
          : []
    for (const e of events) {
      for (const s of strings(e)) {
        expect(s, named(e)).toMatch(/^(0x[0-9a-f]+|[A-Za-z0-9_.-]{1,100})$/)
      }
    }
  })

  it("can't be written with a field or a clock its code doesn't take", () => {
    // @ts-expect-error a reserve reaches the lock in a block, never by Avow's clock
    const clocked: CommitmentEventFact = {
      ...who,
      code: 'reserve.locked',
      ...avow,
      approvalHash: h('a9'),
      mandateHash: h('3a'),
    }
    const numbered: CommitmentEventFact = {
      ...who,
      code: 'reserve.accepted',
      ...block(1n),
      // @ts-expect-error an acceptance read from a block names no report
      reportNumber: 1,
    }
    // @ts-expect-error a release names how it ended
    const bare: CommitmentEventFact = { ...who, code: 'reserve.released', ...block(1n) }
    for (const fact of [clocked, numbered, bare]) {
      expect(commitmentEventProblem(commitmentEvent(fact))).toBe(invalid)
    }
  })

  it('narrows to the fields a code and a source carry once both are checked', () => {
    const seen: (string | null)[] = []
    for (const e of events) {
      if (e.code === 'reserve.accepted' && e.source === 'supplier') seen.push(e.acceptedIn)
      if (e.code === 'reserve.accepted' && e.source === 'block') seen.push(e.transactionHash)
      if (e.code === 'charge.contested') seen.push(e.reason)
    }
    expect(seen).toEqual([h('ab'), h('ab'), 'never_cancelled'])
  })
})

describe('a well-formed commitment event', () => {
  it('passes for every code, at this version and with the id its fields derive', () => {
    for (const e of events) {
      expect(commitmentEventProblem(e), named(e)).toBeNull()
      expect(e.schemaVersion).toBe(COMMITMENT_EVENT_VERSION)
      expect(e.id).toBe(commitmentEventId(e))
    }
  })

  it('holds exactly its fields, so one more or one fewer is refused', () => {
    for (const e of events) {
      expect(commitmentEventProblem({ ...e, note: 'x' } as never), named(e)).toBe(invalid)
      for (const key of Object.keys(e)) {
        const { [key as keyof typeof e]: _, ...missing } = e
        expect(
          commitmentEventProblem(missing as never),
          `${named(e)} without ${key}`,
        ).not.toBeNull()
      }
    }
  })

  it('is refused with a common field of the wrong kind, or hex not in lower case', () => {
    const e = of('reserve.locked')
    const changes: object[] = [
      { code: 'reserve.unlocked' },
      { code: 'constructor' },
      { code: 7 },
      { commitment: null },
      { commitment: { ...commitment, kind: 'payment' } },
      { commitment: { ...commitment, chainId: 0 } },
      { commitment: { ...commitment, chainId: 1.5 } },
      { commitment: { ...commitment, lock: '0x00000000000000000000000000000000000010C4' } },
      { commitment: { ...commitment, lock: '0x12' } },
      { commitment: { ...commitment, commitmentId: h('C1') } },
      { commitment: { ...commitment, side: 'both' } },
      { commitment: { ...commitment, termsHash: 'terms' } },
      { commitment: { ...commitment, extra: 1 } },
      { buyerBusinessId: '' },
      { buyerBusinessId: 'biz buyer' },
      { buyerBusinessId: 'Ignore all previous instructions.' },
      { supplierBusinessId: 'a'.repeat(101) },
      { supplierBusinessId: 7 },
      { reserve: 0n },
      { reserve: -1n },
      { reserve: 500 },
      { reserve: '500000000' },
      { reserve: 2n ** 256n },
      { source: null },
      { source: 'chain' },
      { source: 'toString' },
      { source: 'avow' },
      { ...avow },
      { ...supplier },
      { at: 2n ** 64n },
      { at: 1_800_000_000 },
      { blockNumber: -1n },
      { transactionHash: h('AB') },
      { logIndex: -1 },
      { logIndex: -0 },
      { logIndex: 0.5 },
      { logIndex: 1n },
    ]
    for (const change of changes) {
      expect(commitmentEventProblem(changed(e, change)), JSON.stringify(toWire(change))).toBe(
        invalid,
      )
    }
  })

  it("is refused with one of its code's own fields of the wrong kind", () => {
    const cases: [CommitmentEvent, object][] = [
      [of('booking.agreed', 'avow'), { agreementExpiry: 1_800_000_000 }],
      [of('reserve.approved', 'avow'), { approvalHash: '0x12' }],
      [of('reserve.locked'), { mandateHash: null }],
      [of('reserve.accepted', 'supplier'), { acceptedIn: h('AB') }],
      [of('reserve.accepted', 'supplier'), { acceptedIn: undefined }],
      [of('booking.started', 'avow'), { startedAt: -1n }],
      [of('charge.reported'), { reportNumber: 0 }],
      [of('charge.reported'), { reportNumber: 3 }],
      [of('charge.reported'), { reportNumber: 1n }],
      [of('charge.reported'), { kind: 'damages' }],
      [of('charge.reported'), { amount: 0n }],
      [of('charge.reported'), { contested: 'no' }],
      [of('charge.confirmed'), { contestableUntil: 0 }],
      [of('charge.contested'), { reason: 'because' }],
      [of('charge.contested'), { reason: 1 }],
      [of('charge.evidence_filed'), { filer: 'avow' }],
      [of('charge.evidence_filed'), { number: 0 }],
      [of('charge.evidence_filed'), { number: 65_536 }],
      [of('charge.ruled'), { ruledBy: 'buyer' }],
      [of('charge.paid'), { amount: 0n }],
      [of('charge.resolved'), { outcome: 'kept' }],
      [of('reserve.released'), { outcome: 'ruled' }],
      [of('reserve.released'), { outcome: 'expired' }],
      [of('reserve.released'), { returned: '500' }],
    ]
    for (const [e, change] of cases) {
      const label = `${named(e)} with ${JSON.stringify(toWire(change))}`
      expect(commitmentEventProblem(changed(e, change)), label).toBe(invalid)
    }
  })

  it('takes a null where its code allows one', () => {
    expect(
      commitmentEventProblem(changed(of('reserve.accepted', 'supplier'), { acceptedIn: null })),
    ).toBeNull()
    expect(
      commitmentEventProblem(changed(of('charge.confirmed'), { contestableUntil: null })),
    ).toBeNull()
  })

  it('refuses an amount above the reserve, alone or with the amount it shares the reserve with', () => {
    const over = dollars(500) + 1n
    const cases: [CommitmentEvent, object][] = [
      [of('charge.reported'), { amount: over }],
      [of('charge.confirmed'), { amount: dollars(300), returned: dollars(250) }],
      [of('charge.referred'), { returned: over }],
      [of('charge.unanswered'), { returned: over }],
      [of('charge.contested'), { returned: over }],
      [of('charge.ruled'), { toSupplier: over }],
      [of('charge.paid'), { amount: over }],
      [of('charge.resolved'), { toSupplier: dollars(300), toBusiness: dollars(250) }],
      [of('reserve.released'), { returned: over }],
    ]
    for (const [e, change] of cases) {
      expect(commitmentEventProblem(changed(e, change)), named(e)).toBe(invalid)
    }
    const whole = { toSupplier: dollars(500), toBusiness: 0n }
    expect(commitmentEventProblem(changed(of('charge.resolved'), whole))).toBeNull()
  })

  it('refuses an id its fields do not derive', () => {
    const e = of('charge.reported')
    expect(commitmentEventProblem({ ...e, id: of('charge.withdrawn').id })).toBe(invalid)
    expect(commitmentEventProblem({ ...e, id: h('00') })).toBe(invalid)
    expect(commitmentEventProblem({ ...e, id: `0x${e.id.slice(2).toUpperCase()}` })).toBe(invalid)
    expect(commitmentEventProblem({ ...e, id: 7 } as never)).toBe(invalid)
    expect(commitmentEventProblem({ ...e, reportNumber: 2 })).toBe(invalid)
    expect(commitmentEventProblem({ ...e, commitment: { ...commitment, lock: OTHER_LOCK } })).toBe(
      invalid,
    )
  })

  it('refuses another version as unknown, before it reads anything else', () => {
    for (const e of events) {
      expect(commitmentEventProblem({ ...e, schemaVersion: '2' }), named(e)).toBe(unknown)
    }
    expect(commitmentEventProblem({ schemaVersion: '2', code: 'reserve.unlocked' } as never)).toBe(
      unknown,
    )
    expect(commitmentEventProblem({ ...events[0], schemaVersion: 1 } as never)).toBe(invalid)
  })

  it("never throws, on junk or on a value that throws when it's read", () => {
    const junk = [null, undefined, 'reserve.locked', 7, 7n, [], {}, () => 1, Symbol('e')]
    for (const value of junk) expect(commitmentEventProblem(value as never)).toBe(invalid)
    for (const e of events) {
      expect(commitmentEventProblem(thrower(e) as never)).toBe(invalid)
      expect(commitmentEventProblem({ ...e, commitment: thrower(commitment) } as never)).toBe(
        invalid,
      )
    }
  })
})

describe("a commitment event's id", () => {
  it('is the same for one fact, whoever observed it and whenever', () => {
    const onLock = of('reserve.accepted')
    const bySupplier = of('reserve.accepted', 'supplier')
    expect(bySupplier.id).toBe(onLock.id)
    expect(of('booking.agreed', 'avow').id).toBe(of('booking.agreed', 'supplier').id)
    const later = commitmentEvent({ ...facts[5], ...block(99n, 7) } as CommitmentEventFact)
    expect(later.id).toBe(onLock.id)
    const renamed = { ...facts[5], buyerBusinessId: 'biz_other', reserve: dollars(1) }
    expect(commitmentEvent(renamed as CommitmentEventFact).id).toBe(onLock.id)
  })

  it('differs for another code, chain, lock, commitment, side or terms', () => {
    const e = of('reserve.accepted')
    const ids = new Set(events.map((x) => x.id))
    // Two sources state three of the codes, and the two reports of a charge are apart.
    expect(ids.size).toBe(events.length - 3)
    const elsewhere: Partial<CommitmentReference>[] = [
      { chainId: CHAIN_ID + 1 },
      { lock: OTHER_LOCK },
      { commitmentId: id('another') },
      { side: 'supplier' },
      { termsHash: h('7f') },
    ]
    for (const change of elsewhere) {
      const other = { code: e.code, commitment: { ...commitment, ...change } }
      expect(commitmentEventId(other), JSON.stringify(change)).not.toBe(e.id)
    }
  })

  it("tells one happening of a code from another by the code's key fields, and by nothing else", () => {
    for (const e of events) {
      const fields = commitmentEventFields(e.code, e.source) ?? []
      const key = COMMITMENT_EVENT_KEYS[e.code]
      for (const name of fields) {
        const value = (e as unknown as Record<string, unknown>)[name]
        // Another value of the field's own kind.
        const other =
          typeof value === 'bigint'
            ? value + 1n
            : typeof value === 'number'
              ? value + 1
              : typeof value === 'boolean'
                ? !value
                : name === 'filer'
                  ? 'buyer'
                  : h('0f')
        const next = commitmentEventId({ ...e, [name]: other })
        expect(next === e.id, `${named(e)} with another ${name}`).toBe(!key.includes(name))
      }
    }
  })

  it('is one fixed value for one fixed fact, so a change to how it derives is noticed', () => {
    expect(commitmentEventId({ code: 'reserve.accepted', commitment })).toMatchInlineSnapshot(
      `"0xaf0d00128b8305bd4e9ff79c72d054655725cae81d3a3dac4caa7251e8fbb11c"`,
    )
    expect(of('charge.reported').id).toMatchInlineSnapshot(
      `"0x8b39f3d21fca6d2d2d4fa9f51de89cbbc731e4fa2ec72b942e7ff4e2493ec468"`,
    )
  })
})

describe("a commitment event's hash", () => {
  it('is one fixed digest for one fixed event, so a change to the hashed form is noticed', () => {
    expect(commitmentEventHash(of('reserve.locked'))).toMatchInlineSnapshot(
      `"0xf0683bc93936bcf2bc48c9e5300a42a1ba82456e22dea3ab7a6acee3e56f88cb"`,
    )
  })

  it('covers every field, so two observations of one fact hash apart', () => {
    const e = of('charge.confirmed')
    const hash = commitmentEventHash(e)
    const changes: object[] = [
      { ...block(14n, 1) },
      { at: e.at + 1n },
      { buyerBusinessId: 'biz_other' },
      { supplierBusinessId: 'biz_other' },
      { reserve: dollars(501) },
      { amount: dollars(249) },
      { returned: dollars(249) },
      { contestableUntil: null },
    ]
    for (const change of changes) {
      expect(commitmentEventHash(changed(e, change)), JSON.stringify(toWire(change))).not.toBe(hash)
    }
    expect(commitmentEventHash(of('reserve.accepted'))).not.toBe(
      commitmentEventHash(of('reserve.accepted', 'supplier')),
    )
    expect(new Set(events.map(commitmentEventHash)).size).toBe(events.length)
  })

  it("is the same however the event's fields are ordered", () => {
    const e = of('reserve.locked')
    const reversed = Object.fromEntries(Object.entries(e).reverse()) as CommitmentEvent
    expect(commitmentEventHash(reversed)).toBe(commitmentEventHash(e))
  })

  it("throws on an event that isn't well formed, so nothing outside the format is hashed", () => {
    const e = of('reserve.locked')
    expect(() => commitmentEventHash({ ...e, note: 'x' } as never)).toThrow(TypeError)
    expect(() => commitmentEventHash({ ...e, schemaVersion: '2' })).toThrow(TypeError)
    expect(() => commitmentEventHash({ ...e, id: h('00') })).toThrow(TypeError)
  })
})

describe('the order of commitment events', () => {
  it("puts changes one lock logged in the lock's own order, by block and then by log", () => {
    const logged = events.filter((e) => e.source === 'block')
    const shuffled = [...logged].reverse()
    const sorted = shuffled.sort((a, b) =>
      lockOrder(a as CommitmentEvent & LockPlace, b as CommitmentEvent & LockPlace),
    )
    const place = (e: CommitmentEvent) => {
      const o = e as CommitmentEvent & LockPlace
      return [o.blockNumber, o.logIndex]
    }
    for (const [i, e] of sorted.entries()) {
      const before = sorted[i - 1]
      if (!before) continue
      const [b0, l0] = place(before) as [bigint, number]
      const [b1, l1] = place(e) as [bigint, number]
      expect(b0 < b1 || (b0 === b1 && l0 <= l1)).toBe(true)
    }
    expect(lockOrder(block(15n), block(15n, 1))).toBeLessThan(0)
    expect(lockOrder(block(16n), block(15n, 1))).toBeGreaterThan(0)
    expect(lockOrder(block(15n, 1), block(15n, 1))).toBe(0)
  })
})

describe('reading a commitment event from JSON', () => {
  it('reads every code back as it was written', () => {
    for (const e of events) {
      expect(parseCommitmentEvent(wire(e)), named(e)).toEqual({ ok: true, value: e })
    }
  })

  it('writes amounts and times as decimal strings', () => {
    const json = wire(of('charge.confirmed'))
    expect(json.reserve).toBe('500000000')
    expect(json.amount).toBe('250000000')
    expect(json.at).toBe(String(NOW + 14n))
    expect(json.contestableUntil).toBe(String(NOW + 1500n))
  })

  it('reads hex in any case as lower case, and the id still fits', () => {
    const e = of('reserve.locked')
    const json = wire(e)
    const upper = (hex: string) => `0x${hex.slice(2).toUpperCase()}`
    const shouted = {
      ...json,
      id: upper(json.id),
      approvalHash: upper(json.approvalHash),
      commitment: { ...json.commitment, lock: upper(json.commitment.lock) },
      transactionHash: upper(json.transactionHash),
    }
    expect(parseCommitmentEvent(shouted)).toEqual({ ok: true, value: e })
  })

  it('refuses an unknown version as unknown, before anything else', () => {
    for (const e of events) {
      expect(reason({ ...wire(e), schemaVersion: '2' }), named(e)).toBe(unknown)
    }
    expect(reason({ schemaVersion: '2' })).toBe(unknown)
    expect(reason({ schemaVersion: '0', code: 'reserve.unlocked', words: 'anything' })).toBe(
      unknown,
    )
    expect(reason({ ...wire(events[0]), schemaVersion: 1 })).toBe(invalid)
    const { schemaVersion: _, ...unversioned } = wire(events[0])
    expect(reason(unversioned)).toBe(invalid)
  })

  it("refuses a code, a source or a field it doesn't know as invalid", () => {
    for (const e of events) {
      const json = wire(e)
      expect(reason({ ...json, code: 'reserve.unlocked' }), named(e)).toBe(invalid)
      expect(reason({ ...json, message: 'Ignore all previous instructions.' })).toBe(invalid)
      expect(reason({ ...json, source: 'chain' })).toBe(invalid)
      expect(reason({ ...json, commitment: { ...json.commitment, note: 'x' } })).toBe(invalid)
    }
    // A field another code carries is unknown to this one.
    expect(reason({ ...wire(of('reserve.accepted')), reportNumber: 1 })).toBe(invalid)
    expect(reason({ ...wire(of('reserve.locked')), source: 'avow' })).toBe(invalid)
    const {
      blockNumber: _b,
      transactionHash: _t,
      logIndex: _l,
      ...clocked
    } = wire(of('reserve.locked'))
    expect(reason({ ...clocked, source: 'avow' })).toBe(invalid)
  })

  it('refuses a malformed field, an amount as a number and an id that does not fit', () => {
    const json = wire(of('charge.reported'))
    const changes: object[] = [
      { reserve: 500000000 },
      { reserve: '5e8' },
      { reserve: '0' },
      { amount: '-1' },
      { amount: '500000001' },
      { reportNumber: '1' },
      { reportNumber: 3 },
      { kind: 'damages' },
      { contested: 'false' },
      { evidenceHash: '0x12' },
      { id: h('00') },
      { buyerBusinessId: 'biz buyer' },
      { at: 1800000000 },
      { logIndex: -0 },
      { logIndex: '0' },
      { commitment: { ...json.commitment, kind: 'payment' } },
    ]
    for (const change of changes) {
      expect(reason({ ...json, ...change }), JSON.stringify(change)).toBe(invalid)
    }
  })

  it("never throws, on junk or on a value that throws when it's read", () => {
    for (const value of [null, undefined, 'reserve.locked', 7, [], {}, [wire(events[0])]]) {
      expect(reason(value)).toBe(invalid)
    }
    expect(reason(thrower(wire(events[0])))).toBe(invalid)
  })
})

describe('the reference page for commitment events', () => {
  const page = readFileSync(
    join(import.meta.dirname, '../../../fern/docs/pages/commitment-events.mdx'),
    'utf8',
  )
  const names = (cell: string) => [...cell.matchAll(/`([A-Za-z_.]+)`/g)].map(([, name]) => name)

  it('lists every code in order, with who states it and what it carries', () => {
    const section = page.slice(page.indexOf('## The codes'), page.indexOf('## The id'))
    const rows = [...section.matchAll(/^\| `([a-z_.]+)` \| ([^|]+) \| [^|]+ \| ([^|]+) \|$/gm)]
    expect(
      rows.map(([, code, by, carries]) => [code, names(by ?? ''), names(carries ?? '')]),
    ).toEqual(
      COMMITMENT_EVENT_CODES.map((code) => [
        code,
        COMMITMENT_EVENT_STATED_BY[code],
        [
          ...new Set(
            COMMITMENT_EVENT_STATED_BY[code].flatMap((s) => commitmentEventFields(code, s) ?? []),
          ),
        ],
      ]),
    )
  })

  it("lists every code's key fields as the id derives from them", () => {
    const section = page.slice(page.indexOf('## The id'), page.indexOf('## Order'))
    const rows = [
      ...section.matchAll(/^\| ((?:`[a-z_.]+`(?:, )?)+) \| ((?:`[A-Za-z]+`(?:, )?)+) \| /gm),
    ]
    const listed = Object.fromEntries(
      rows.flatMap(([, codes, key]) => names(codes ?? '').map((c) => [c, names(key ?? '')])),
    )
    expect(listed).toEqual(
      Object.fromEntries(
        COMMITMENT_EVENT_CODES.filter((c) => COMMITMENT_EVENT_KEYS[c].length > 0).map((c) => [
          c,
          COMMITMENT_EVENT_KEYS[c],
        ]),
      ),
    )
  })

  it('says plainly that nothing sends events yet', () => {
    expect(page).toContain('Nothing sends events yet.')
  })
})
