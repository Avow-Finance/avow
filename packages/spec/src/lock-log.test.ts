import { parseAbiItem, toEventSelector } from 'viem'
import { describe, expect, it } from 'vitest'
import { CHARGE_KINDS, RELEASE_REASONS } from './eip712.js'
import {
  chargeKindOf,
  LOCK_LOGS,
  LOCK_PARTIES,
  type LockLogName,
  lockLogSignature,
  lockPartyOf,
  PAUSE_CAUSES,
  pauseCauseOf,
  RELEASE_CAUSES,
  releaseCauseOf,
  releaseReasonOf,
} from './lock-log.js'

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
