import { type Call, SendError } from '@avow-finance/sdk'
import {
  formatTime,
  type LockedBacking,
  type MemoryChain,
  REPORT_ABI,
} from '@avow-finance/verifier'
import { decodeFunctionData, type Hex, keccak256, stringToHex } from 'viem'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  evidenceNote,
  type ReportChargeDeps,
  reportArgs,
  reportCharge,
  reportOutcome,
} from './report.js'
import type { Booking, SupplierStore } from './store.js'
import {
  agreedBooking,
  CHAIN_ID,
  COMMITMENT,
  LOCK,
  reservedChain,
  START,
  supplierKey,
  TOKEN,
  tempStore,
  terms,
} from './test/fixtures.js'

const HASH: Hex = keccak256(stringToHex('the report transaction'))
/** Five minutes after free cancellation ended, when a late cancellation can be reported. */
const REPORT_AT = terms.remedies.freeCancelBy + 300n
const NO_SHOW_AT = START + 120n
const CONFIRM_WINDOW = 300n

let store: SupplierStore
let remove: () => void
let chain: MemoryChain
let base: LockedBacking
let deps: ReportChargeDeps
let logged: string[]
let sent: Call[]
let clock: { now: bigint; finalized: bigint }
/** What happens on the lock each time the command waits, in order. */
let steps: (() => void)[]
let sendDoes: 'land' | 'fail'

const setLock = (change: Partial<LockedBacking>, commitmentId: Hex = COMMITMENT) =>
  chain.setBacking(LOCK, commitmentId, 'buyer', { ...base, state: 'accepted', ...change })
/** A booking the supplier signed, accepted unless a test says otherwise. */
const accepted = (change: Partial<Booking> = {}) =>
  ({ ...agreedBooking(), status: 'accepted', ...change }) as Booking

beforeEach(async () => {
  ;({ store, remove } = tempStore())
  chain = reservedChain()
  base = (await chain.backing(LOCK, COMMITMENT, 'buyer')) as LockedBacking
  setLock({})
  store.put(accepted())
  logged = []
  sent = []
  clock = { now: REPORT_AT, finalized: REPORT_AT }
  steps = []
  sendDoes = 'land'
  deps = {
    store,
    config: { chainId: CHAIN_ID, signingKey: supplierKey.address, acceptedTokens: [TOKEN] },
    chain,
    signingKey: supplierKey,
    send: async (call, onSent) => {
      sent.push(call)
      const { commitmentId } = decodeFunctionData({ abi: REPORT_ABI, data: call.data }).args[0]
      // The record has to name the hash before the bytes go anywhere.
      await onSent(HASH, clock.now + 25n)
      expect(store.report(commitmentId)?.sent?.hash).toBe(HASH)
      if (sendDoes === 'fail') {
        throw new SendError('it reverted', 'failed', { hashes: [HASH], signings: 1 })
      }
      // The lock takes the report, which stays open until Avow answers it.
      setLock({ hasReport: true, reportCount: 1 }, commitmentId)
      return { status: 'success' }
    },
    chainTime: async () => clock.now,
    finalizedTime: async () => clock.finalized,
    wait: async () => {
      steps.shift()?.()
    },
    log: (line) => logged.push(line),
  }
})
afterEach(() => remove())

/** Avow confirms the report, so only the charge stays held and its contest window starts. */
const confirm = () =>
  setLock({ state: 'charge_pending', hasReport: true, reportCount: 1, held: 250_000_000n })

describe('reporting a late cancellation', () => {
  it('writes the note to the store, reports the charge and says Avow confirmed it', async () => {
    steps = [confirm]
    expect(await reportCharge(deps, reportArgs([]))).toBe('confirmed')
    const filed = store.report(COMMITMENT)
    const note = `A late cancellation on booking ${COMMITMENT}, lock ${LOCK} on chain ${CHAIN_ID}, reported at ${formatTime(REPORT_AT)}.`
    expect(filed).toEqual({
      commitmentId: COMMITMENT,
      kind: 'lateCancellation',
      amount: 250_000_000n,
      note,
      evidenceHash: keccak256(stringToHex(note)),
      sent: { hash: HASH, validBefore: REPORT_AT + 25n },
    })
    expect(sent).toHaveLength(1)
    const [call] = sent as [Call]
    expect(call.to.toLowerCase()).toBe(LOCK)
    const { args } = decodeFunctionData({ abi: REPORT_ABI, data: call.data })
    expect(args[0]).toMatchObject({
      commitmentId: COMMITMENT,
      kind: 0,
      amount: 250_000_000n,
      evidenceHash: keccak256(stringToHex(note)),
    })
    // The disclosure is shown before the report is signed.
    expect(logged.some((l) => l.startsWith('Report a charge (disclosure '))).toBe(true)
    expect(logged.at(-1)).toBe(
      `Avow confirmed the charge on ${COMMITMENT}. It pays USD 250 (250000000 base units of 0x20C0000000000000000000000000000000000001) once the contest window of 10 minutes closes, unless the business contests it first, and the rest of the reserve went back to the business.`,
    )
  })

  it('reports a no-show with the flag, for the most its terms let a no-show take', async () => {
    clock.now = NO_SHOW_AT
    steps = [confirm]
    await reportCharge(deps, reportArgs(['--no-show']))
    const { args } = decodeFunctionData({ abi: REPORT_ABI, data: (sent[0] as Call).data })
    expect(args[0]).toMatchObject({ kind: 1, amount: 500_000_000n })
    expect(store.report(COMMITMENT)?.note).toContain('A no-show on booking')
  })

  it('says when the report went to a ruling, and when Avow let its deadline pass', async () => {
    steps = [() => {}, () => setLock({ state: 'paused', hasReport: true, reportCount: 1 })]
    expect(await reportCharge(deps, reportArgs([]))).toBe('ruling')
    expect(logged.at(-1)).toBe(
      `The report on ${COMMITMENT} went to a ruling. Avow referred it, the business contested it, or Avow didn't answer it in time.`,
    )

    // A booking of its own, so its report is the first on its commitment.
    const other: Hex = `0x${'0d'.repeat(32)}`
    store.put(
      accepted({
        commitmentId: other,
        agreement: { ...agreedBooking().agreement, commitmentId: other },
      }),
    )
    setLock({}, other)
    steps = [() => (clock.now += CONFIRM_WINDOW)]
    expect(await reportCharge(deps, { commitmentId: other, kind: 'lateCancellation' })).toBe(
      'unanswered',
    )
    expect(logged.at(-1)).toBe(
      `Avow didn't confirm or refer the report on ${other} before its deadline, so it goes to a ruling.`,
    )
  })

  it("stops at the verifier's refusal, and writes and sends nothing", async () => {
    clock.now = terms.remedies.freeCancelBy - 1n
    await expect(reportCharge(deps, reportArgs([]))).rejects.toThrow(
      `The verifier built no report for ${COMMITMENT}: The terms don't let this kind of charge be reported yet (report.too_early)`,
    )
    expect(sent).toEqual([])
    expect(store.report(COMMITMENT)).toBeNull()
  })

  it('says a failed send left the lock without a report', async () => {
    sendDoes = 'fail'
    await expect(reportCharge(deps, reportArgs([]))).rejects.toThrow(
      `Sending the report for ${COMMITMENT} failed, so the lock took none`,
    )
  })
})

describe('a report the store shows sent', () => {
  it('follows the report the lock holds, and sends no other', async () => {
    steps = [confirm]
    await reportCharge(deps, reportArgs([]))
    sent = []
    expect(await reportCharge(deps, reportArgs([COMMITMENT]))).toBe('confirmed')
    expect(sent).toEqual([])
    expect(logged).toContain(`the report sent in ${HASH} stands on the lock, so no other is sent`)
  })

  it('waits while the last one may still land, and sends a new one once it no longer can', async () => {
    const note = evidenceNote(accepted(), 'lateCancellation', REPORT_AT - 60n)
    store.putReport({
      commitmentId: COMMITMENT,
      kind: 'lateCancellation',
      amount: 250_000_000n,
      note,
      evidenceHash: keccak256(stringToHex(note)),
      sent: { hash: HASH, validBefore: REPORT_AT },
    })
    await expect(reportCharge(deps, reportArgs([]))).rejects.toThrow('may still land')
    expect(sent).toEqual([])
    clock.finalized = REPORT_AT + 1n
    steps = [confirm]
    expect(await reportCharge(deps, reportArgs([]))).toBe('confirmed')
    expect(sent).toHaveLength(1)
    expect(store.report(COMMITMENT)?.note).toContain(formatTime(REPORT_AT))
  })
})

describe('which booking it reports on', () => {
  it('reports on the booking named, or the accepted one agreed last', async () => {
    const later: Hex = `0x${'1a'.repeat(32)}`
    const agreement = { ...agreedBooking().agreement, commitmentId: later }
    store.put(
      accepted({
        commitmentId: later,
        agreement: { ...agreement, expiry: agreement.expiry + 60n },
      }),
    )
    // A booking agreed later still, which isn't accepted.
    const held: Hex = `0x${'2b'.repeat(32)}`
    store.put(
      accepted({
        commitmentId: held,
        agreement: { ...agreement, commitmentId: held, expiry: agreement.expiry + 120n },
        status: 'held',
      }),
    )
    setLock({}, later)
    steps = [() => setLock({ state: 'charge_pending', hasReport: true, reportCount: 1 }, later)]
    await reportCharge(deps, reportArgs([]))
    const ids = () =>
      sent.map((c) => decodeFunctionData({ abi: REPORT_ABI, data: c.data }).args[0].commitmentId)
    expect(ids()).toEqual([later])
    steps = [confirm]
    await reportCharge(deps, reportArgs([COMMITMENT]))
    expect(ids()).toEqual([later, COMMITMENT])
    await expect(reportCharge(deps, reportArgs([held]))).rejects.toThrow(
      `The booking ${held} is held, and only an accepted one takes a report`,
    )
  })

  it('says when it holds no such booking, or none accepted', async () => {
    const missing: Hex = `0x${'3c'.repeat(32)}`
    await expect(reportCharge(deps, reportArgs([missing]))).rejects.toThrow(
      `holds no booking for ${missing}`,
    )
    store.put(accepted({ status: 'held' }))
    await expect(reportCharge(deps, reportArgs([]))).rejects.toThrow(
      'holds no accepted booking yet',
    )
  })
})

describe('what the lock shows became of a report', () => {
  it('reads each state the lock can show after a report lands', () => {
    const at = (change: Partial<LockedBacking>, pastDeadline = false) =>
      reportOutcome({ ...base, state: 'accepted', hasReport: true, ...change }, pastDeadline)
    expect(at({})).toBeNull()
    expect(at({}, true)).toBe('unanswered')
    expect(at({ hasReport: false })).toBe('withdrawn')
    expect(at({ state: 'charge_pending' })).toBe('confirmed')
    expect(at({ state: 'charged' })).toBe('charged')
    expect(at({ state: 'paused' })).toBe('ruling')
    expect(at({ state: 'released' })).toBe('ended')
    expect(at({ state: 'resolved' })).toBe('ended')
    expect(reportOutcome(null, false)).toBe('ended')
  })
})

describe("the command's arguments", () => {
  it('takes one commitment id at most and the no-show flag, in any order', () => {
    const upper = `0x${'AB'.repeat(32)}`
    expect(reportArgs([])).toEqual({ commitmentId: null, kind: 'lateCancellation' })
    expect(reportArgs(['--no-show', upper])).toEqual({
      commitmentId: upper.toLowerCase(),
      kind: 'noShow',
    })
    expect(reportArgs([upper, '--no-show'])).toEqual(reportArgs(['--no-show', upper]))
    expect(() => reportArgs(['--late'])).toThrow('report takes no --late')
    expect(() => reportArgs(['0x1234'])).toThrow("isn't a commitment id")
    expect(() => reportArgs([upper, upper])).toThrow('one commitment id at most')
  })
})
