import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeEventLog, type Hex, parseAbiItem, toEventSelector } from 'viem'
import { describe, expect, it } from 'vitest'
import { CHARGE_KINDS, RELEASE_REASONS } from './eip712.js'
import {
  chargeKindOf,
  LOCK_LOG_ABI,
  LOCK_LOGS,
  LOCK_PARTIES,
  type LockLogName,
  type LockParty,
  lockLogSignature,
  lockPartyOf,
  PAUSE_CAUSES,
  pauseCauseOf,
  RELEASE_CAUSES,
  type ReceiptLog,
  releaseCauseOf,
  releaseReasonOf,
  sentStates,
} from './lock-log.js'
import { LOCK, lockReceiptLog, OTHER_LOCK } from './test-helpers.js'

const logs = Object.keys(LOCK_LOGS) as LockLogName[]

describe("the lock's logs", () => {
  it('names the commitment first in every log, then its side', () => {
    for (const log of logs) {
      expect(Object.keys(LOCK_LOGS[log]).slice(0, 2), log).toEqual(['commitmentId', 'side'])
    }
  })

  it('names the terms in every log but the two about an owed payment', () => {
    expect(logs.filter((log) => !('termsHash' in LOCK_LOGS[log]))).toEqual([
      'PaymentOwed',
      'OwedWithdrawn',
    ])
  })

  it('writes each log as a signature a chain client parses, with the commitment indexed', () => {
    for (const log of logs) {
      const item = parseAbiItem(lockLogSignature(log))
      if (item.type !== 'event') throw new Error(`${log} is no event`)
      expect(item.name).toBe(log)
      expect(item.inputs.map((input) => [input.name, input.type])).toEqual(
        Object.entries(LOCK_LOGS[log]),
      )
      expect(item.inputs.filter((input) => input.indexed).map((input) => input.name)).toEqual([
        'commitmentId',
      ])
    }
  })

  it('has one fixed topic for one fixed log, so a change to an argument is noticed', () => {
    expect(toEventSelector(lockLogSignature('Paused'))).toMatchInlineSnapshot(
      `"0x2ad610aa4c58db8cdc9bde7148a208ef6d1de94e9da015e80df5c597edfaaed6"`,
    )
    expect(toEventSelector(lockLogSignature('OwedWithdrawn'))).toMatchInlineSnapshot(
      `"0x1e44a58e5042b25c3f154d1fe9f796a85736066a029c4677f187ef6a387d6f9d"`,
    )
  })
})

describe("the words for a lock's numbers", () => {
  const tables = [
    [RELEASE_CAUSES, releaseCauseOf],
    [RELEASE_REASONS, releaseReasonOf],
    [PAUSE_CAUSES, pauseCauseOf],
    [LOCK_PARTIES, lockPartyOf],
    [CHARGE_KINDS, chargeKindOf],
  ] as const

  it('gives every listed number its word, and no two words one number', () => {
    for (const [table, wordOf] of tables) {
      const codes = Object.values(table)
      expect(new Set(codes).size).toBe(codes.length)
      for (const [word, code] of Object.entries(table)) expect(wordOf(code)).toBe(word)
    }
  })

  it('gives null for a number its table does not list', () => {
    for (const [table, wordOf] of tables) {
      const codes: number[] = Object.values(table)
      for (const code of [0, 1, 2, 3, 4, 5, 7, 255, 65_535, -1, 1.5, Number.NaN]) {
        if (!codes.includes(code)) expect(wordOf(code)).toBeNull()
      }
    }
    expect(releaseReasonOf(0)).toBeNull()
    expect(pauseCauseOf(0)).toBeNull()
    expect(chargeKindOf(2)).toBeNull()
  })

  it("numbers the causes of a release as the lock's five steps", () => {
    expect(RELEASE_CAUSES).toEqual({
      returned_by_avow: 0,
      cancelled_in_time: 1,
      supplier_consent: 2,
      not_accepted: 3,
      reached_release_date: 4,
    })
    expect(LOCK_PARTIES).toEqual({ business: 0, supplier: 1 })
  })
})

describe('what a step sent each party, read from its receipt', () => {
  const h = (byte: string): Hex => `0x${byte.repeat(32)}`
  const ID = h('c1')
  const base = { commitmentId: ID, side: 0, termsHash: h('7e') }
  const TOKEN = '0x20c0000000000000000000000000000000000001'
  /** A log from the token, such as the transfer a payment that went through writes. */
  const tokenLog = (logIndex: number): ReceiptLog => ({
    address: TOKEN,
    logIndex,
    topics: [h('dd'), h('01'), h('02')],
    data: h('00'),
  })
  const owedTo = (party: LockParty, logIndex: number, commitmentId = ID, address = LOCK) =>
    lockReceiptLog(
      'PaymentOwed',
      { commitmentId, side: 0, party: LOCK_PARTIES[party], amount: 1n },
      logIndex,
      address,
    )
  /** Every step of the lock that sends money, the log it ends with and who it pays. */
  const STEPS: { name: LockLogName; args: Record<string, unknown>; pays: LockParty[] }[] = [
    {
      name: 'ChargeConfirmed',
      args: { ...base, reportNumber: 1, amount: 2n, evidenceHash: h('e1'), returned: 3n },
      pays: ['business'],
    },
    {
      name: 'Referred',
      args: { ...base, reportNumber: 1, evidenceHash: h('e4'), returned: 3n },
      pays: ['business'],
    },
    {
      name: 'Paused',
      args: {
        ...base,
        cause: PAUSE_CAUSES.timeout,
        pausedAt: 9n,
        reasonCode: 0,
        evidenceHash: h('e1'),
        returned: 3n,
      },
      pays: ['business'],
    },
    {
      name: 'Paused',
      args: {
        ...base,
        cause: PAUSE_CAUSES.contest,
        pausedAt: 9n,
        reasonCode: 1,
        evidenceHash: h('5e'),
        returned: 3n,
      },
      pays: ['business'],
    },
    { name: 'Charged', args: { ...base, amount: 2n, evidenceHash: h('e1') }, pays: ['supplier'] },
    {
      name: 'Resolved',
      args: { ...base, byRuling: true, toSupplier: 2n, toBusiness: 3n, evidenceHash: h('e1') },
      pays: ['supplier', 'business'],
    },
    {
      name: 'Released',
      args: { ...base, cause: 3, reason: 0, evidenceHash: h('00'), returned: 5n },
      pays: ['business'],
    },
  ]
  const both = (business: string, supplier: string) => ({ business, supplier })

  it("reads both shares of a resolution as owed when both of the lock's transfers fail", () => {
    // The lock pays the supplier, then the business, then logs the resolution.
    const resolved = STEPS.find((step) => step.name === 'Resolved')
    if (!resolved) throw new Error('a resolution')
    const receipt = [
      owedTo('supplier', 0),
      owedTo('business', 1),
      lockReceiptLog('Resolved', resolved.args, 2),
    ]
    expect(sentStates(receipt, 2)).toEqual(both('owed', 'owed'))
    const supplierOnly = [
      owedTo('supplier', 0),
      tokenLog(1),
      lockReceiptLog('Resolved', resolved.args, 2),
    ]
    expect(sentStates(supplierOnly, 2)).toEqual(both('paid', 'owed'))
    const businessOnly = [
      tokenLog(0),
      owedTo('business', 1),
      lockReceiptLog('Resolved', resolved.args, 2),
    ]
    expect(sentStates(businessOnly, 2)).toEqual(both('owed', 'paid'))
  })

  it('reads every step that sends money as paid with no PaymentOwed, and owed with one', () => {
    for (const step of STEPS) {
      const label = `${step.name} ${String(step.args.cause ?? '')}`
      const paid = [tokenLog(0), lockReceiptLog(step.name, step.args, 1)]
      expect(sentStates(paid, 1), label).toEqual(both('paid', 'paid'))
      for (const party of step.pays) {
        const owed = [owedTo(party, 0), tokenLog(1), lockReceiptLog(step.name, step.args, 2)]
        const read = sentStates(owed, 2)
        expect(read?.[party], `${label} to ${party}`).toBe('owed')
      }
      const all = [
        ...step.pays.map((p, i) => owedTo(p, i)),
        lockReceiptLog(step.name, step.args, 9),
      ]
      const read = sentStates(all, 9)
      for (const party of step.pays) expect(read?.[party], label).toBe('owed')
    }
  })

  it("stops at the lock's log before the step, so another step in the same transaction counts for nothing", () => {
    const released = STEPS.find((step) => step.name === 'Released')?.args ?? {}
    const other = { ...released, commitmentId: h('c2') }
    const receipt = [
      owedTo('business', 0, h('c2')),
      lockReceiptLog('Released', other, 1),
      lockReceiptLog('Released', released, 2),
    ]
    expect(sentStates(receipt, 2)).toEqual(both('paid', 'paid'))
    expect(sentStates(receipt, 1)).toEqual(both('owed', 'paid'))
    // The same steps the other way round, with the second step's own PaymentOwed after the first.
    const turned = [
      lockReceiptLog('Released', other, 0),
      owedTo('business', 1),
      lockReceiptLog('Released', released, 2),
    ]
    expect(sentStates(turned, 2)).toEqual(both('owed', 'paid'))
    expect(sentStates(turned, 0)).toEqual(both('paid', 'paid'))
  })

  it('counts only a PaymentOwed from the same lock, for the same commitment and side', () => {
    const released = STEPS.find((step) => step.name === 'Released')?.args ?? {}
    const step = lockReceiptLog('Released', released, 3)
    const elsewhere = [owedTo('business', 0, ID, OTHER_LOCK), step]
    expect(sentStates(elsewhere, 3)).toEqual(both('paid', 'paid'))
    const another = [owedTo('business', 0, h('c3')), step]
    expect(sentStates(another, 3)).toEqual(both('paid', 'paid'))
    const supplierSide = [
      lockReceiptLog('PaymentOwed', { commitmentId: ID, side: 1, party: 0, amount: 1n }, 0),
      step,
    ]
    expect(sentStates(supplierSide, 3)).toEqual(both('paid', 'paid'))
    // A lock's address in another letter case is the same lock.
    const shouted = [
      owedTo('business', 0),
      { ...step, address: LOCK.toUpperCase().replace('0X', '0x') },
    ]
    expect(sentStates(shouted, 3)).toEqual(both('owed', 'paid'))
  })

  it("reads a receipt in any order, by the logs' own indexes", () => {
    const resolved = STEPS.find((step) => step.name === 'Resolved')?.args ?? {}
    const receipt = [
      lockReceiptLog('Resolved', resolved, 7),
      owedTo('business', 6),
      owedTo('supplier', 5),
    ]
    expect(sentStates(receipt, 7)).toEqual(both('owed', 'owed'))
  })

  it("gives null for a log that isn't one of the lock's steps on a commitment", () => {
    const released = STEPS.find((step) => step.name === 'Released')?.args ?? {}
    const receipt = [owedTo('business', 0), tokenLog(1), lockReceiptLog('Released', released, 2)]
    expect(sentStates(receipt, 0)).toBeNull()
    expect(sentStates(receipt, 1)).toBeNull()
    expect(sentStates(receipt, 3)).toBeNull()
    expect(sentStates([], 0)).toBeNull()
  })

  it('pays a party the step sends nothing to as paid, and the event carries null for it', () => {
    const charged = STEPS.find((step) => step.name === 'Charged')
    if (!charged) throw new Error('a charge')
    expect(sentStates([lockReceiptLog('Charged', charged.args, 0)], 0)).toEqual(
      both('paid', 'paid'),
    )
  })
})

describe("the lock's logs as a chain client decodes them", () => {
  it('decodes every log this package lists, with the arguments it lists', () => {
    for (const name of logs) {
      const args = Object.fromEntries(
        Object.entries(LOCK_LOGS[name]).map(([arg, type]) => [
          arg,
          type === 'bytes32'
            ? `0x${'ab'.repeat(32)}`
            : type === 'address'
              ? LOCK
              : type === 'bool'
                ? true
                : type.startsWith('uint') && Number(type.slice(4)) > 16
                  ? 7n
                  : 7,
        ]),
      )
      const log = lockReceiptLog(name, args, 0)
      const read = decodeEventLog({
        abi: LOCK_LOG_ABI,
        topics: log.topics as [Hex],
        data: log.data,
      })
      expect(read.eventName).toBe(name)
      expect(Object.keys(read.args as object)).toEqual(Object.keys(LOCK_LOGS[name]))
    }
  })
})

describe('what this package says about kinds of charge', () => {
  it('claims no limit on how many kinds a lock holds', () => {
    const files = [
      './lock-log.ts',
      './commitment-event.ts',
      '../../../fern/docs/pages/commitment-events.mdx',
    ].map((f) => readFileSync(join(import.meta.dirname, f), 'utf8'))
    for (const text of files) expect(text).not.toMatch(/up to four kinds|four kinds of charge/)
  })
})
