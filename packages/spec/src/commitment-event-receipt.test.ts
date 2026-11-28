import type { Hex } from 'viem'
import { describe, expect, it } from 'vitest'
import { commitmentEventProblem } from './commitment-event.js'
import { lockReceiptEvents } from './commitment-event-receipt.js'
import { dollars } from './demo.js'
import { LOCK_PARTIES, PAUSE_CAUSES, RELEASE_CAUSES, type ReceiptLog } from './lock-log.js'
import { CHAIN_ID, LOCK, lockReceiptLog, NOW, OTHER_LOCK } from './test-helpers.js'

const h = (byte: string): Hex => `0x${byte.repeat(32)}`
const ONE = h('c1')
const TWO = h('c2')
const termsHash = h('7e')
const place = {
  chainId: CHAIN_ID,
  lock: LOCK,
  blockNumber: 90n,
  at: NOW,
  transactionHash: h('ab'),
}
const released = (commitmentId: Hex, logIndex: number, address = LOCK) =>
  lockReceiptLog(
    'Released',
    {
      commitmentId,
      side: 0,
      termsHash,
      cause: RELEASE_CAUSES.not_accepted,
      reason: 0,
      evidenceHash: h('e6'),
      returned: dollars(500),
    },
    logIndex,
    address,
  )
const owed = (
  commitmentId: Hex,
  logIndex: number,
  party: number = LOCK_PARTIES.business,
  side = 0,
) => lockReceiptLog('PaymentOwed', { commitmentId, side, party, amount: dollars(500) }, logIndex)
const paused = (cause: number, logIndex: number) =>
  lockReceiptLog(
    'Paused',
    {
      commitmentId: ONE,
      side: 0,
      termsHash,
      cause,
      pausedAt: NOW,
      reasonCode: 0,
      evidenceHash: h('e5'),
      returned: 0n,
    },
    logIndex,
  )

describe("the events a lock's receipt states", () => {
  it("writes each of the lock's steps in the order of their logs, each with its own payments", () => {
    // Two releases in one transaction, where only the second one's transfer failed. The logs come
    // out of order, and a token's transfer from another contract sits between them.
    const logs: ReceiptLog[] = [
      owed(TWO, 3),
      released(TWO, 4),
      { address: h('77').slice(0, 42), logIndex: 1, topics: [h('99')], data: '0x' },
      released(ONE, 0),
    ]
    const { events, unread } = lockReceiptEvents(logs, place)
    expect(unread).toEqual([])
    expect(events.map((e) => [e.commitment.commitmentId, e.logIndex, e.code])).toEqual([
      [ONE, 0, 'reserve.released'],
      [TWO, 4, 'reserve.released'],
    ])
    expect(events.map((e) => (e.code === 'reserve.released' ? e.returned : null))).toEqual([
      { amount: dollars(500), state: 'paid' },
      { amount: dollars(500), state: 'owed' },
    ])
    for (const e of events) {
      expect(commitmentEventProblem(e)).toBeNull()
      expect(e).toMatchObject({
        source: 'block',
        at: NOW,
        blockNumber: 90n,
        transactionHash: h('ab'),
      })
      expect(e.commitment).toEqual({
        chainId: CHAIN_ID,
        lock: LOCK,
        commitmentId: e.commitment.commitmentId,
      })
    }
  })

  it('reads only the lock it names, whatever case its address is written in', () => {
    const logs = [released(ONE, 0, OTHER_LOCK), released(ONE, 1)]
    const upper = `0x${LOCK.slice(2).toUpperCase()}` as Hex
    const { events } = lockReceiptEvents(logs, { ...place, lock: upper })
    expect(events.map((e) => [e.commitment.lock, e.logIndex])).toEqual([[LOCK, 1]])
    expect(lockReceiptEvents(logs, { ...place, lock: OTHER_LOCK }).events).toHaveLength(1)
  })

  it('tells the three pause steps apart by their cause, and marks a cause it has no step for', () => {
    const logs = [
      paused(PAUSE_CAUSES.timeout, 0),
      paused(PAUSE_CAUSES.avowPause, 1),
      paused(PAUSE_CAUSES.referral, 2),
      paused(9, 3),
    ]
    const { events, unread } = lockReceiptEvents(logs, place)
    expect(events.map((e) => e.code)).toEqual(['charge.unanswered', 'charge.paused'])
    // A referral has its own log, so a pause that names one is no step this package can state.
    expect(unread).toEqual([2, 3])
  })

  it("marks a log it reads and can't state, such as one for the supplier's side", () => {
    const supplierSide = lockReceiptLog(
      'Accepted',
      {
        commitmentId: ONE,
        side: 1,
        termsHash,
        acceptanceHash: h('ac'),
      },
      0,
    )
    const nobody = lockReceiptLog(
      'EvidenceFiled',
      { commitmentId: ONE, side: 0, termsHash, filer: 7, number: 1, evidenceHash: h('e2') },
      1,
    )
    expect(lockReceiptEvents([supplierSide, nobody], place)).toEqual({ events: [], unread: [0, 1] })
  })

  it('makes no event from a log of another shape or an empty receipt', () => {
    const settings: ReceiptLog = { address: LOCK, logIndex: 1, topics: [h('51')], data: '0x' }
    expect(lockReceiptEvents([settings], place)).toEqual({ events: [], unread: [] })
    expect(lockReceiptEvents([], place)).toEqual({ events: [], unread: [] })
  })

  it('marks a payment owed that no step accounts for, whose step then reads as paid', () => {
    const cases: [string, ReceiptLog[]][] = [
      ['alone', [owed(ONE, 0)]],
      ['for another commitment', [owed(TWO, 0), released(ONE, 1)]],
      ['for the other side', [owed(ONE, 0, LOCK_PARTIES.business, 1), released(ONE, 1)]],
      ['for a party the lock has no word for', [owed(ONE, 0, 7), released(ONE, 1)]],
      [
        'for a party the step sends nothing to',
        [owed(ONE, 0, LOCK_PARTIES.supplier), released(ONE, 1)],
      ],
    ]
    for (const [what, logs] of cases) {
      const { events, unread } = lockReceiptEvents(logs, place)
      expect(unread, what).toEqual([0])
      for (const e of events) {
        expect(e.code === 'reserve.released' && e.returned, what).toEqual({
          amount: dollars(500),
          state: 'paid',
        })
      }
    }
    // The payment owed to the business for this release is the one it accounts for.
    expect(lockReceiptEvents([owed(ONE, 0), released(ONE, 1)], place).unread).toEqual([])
  })

  it("marks a log with one of the lock's signatures that doesn't decode", () => {
    const broken: ReceiptLog = { ...released(ONE, 0), data: '0x' }
    expect(lockReceiptEvents([broken, released(ONE, 1)], place)).toMatchObject({ unread: [0] })
  })

  it('marks a release with a cause the spec has no word for, since the event keeps no number for it', () => {
    const cause = lockReceiptLog(
      'Released',
      {
        commitmentId: ONE,
        side: 0,
        termsHash,
        cause: 9,
        reason: 0,
        evidenceHash: h('e6'),
        returned: 0n,
      },
      0,
    )
    expect(lockReceiptEvents([cause], place)).toEqual({ events: [], unread: [0] })
  })
})
