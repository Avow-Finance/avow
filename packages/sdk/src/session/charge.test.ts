import type { LockedBacking } from '@avow-finance/verifier'
import { describe, expect, it } from 'vitest'
import { chargeStanding } from './charge.js'

const CONFIRM_WINDOW = 600n
const report = { reportNumber: 1, reportedAt: 1_000n }
/** What a lock holds for a commitment with one report on it, changed as a test needs. */
const held = (changes: Partial<LockedBacking>): LockedBacking =>
  ({
    state: 'accepted',
    reportCount: 1,
    hasReport: true,
    contested: false,
    chargeStart: 0n,
    pausedAt: 0n,
    contestWindow: 600n,
    ...changes,
  }) as LockedBacking

describe('where a reported charge stands', () => {
  it("waits while the lock hasn't shown the report or Avow hasn't answered it", () => {
    expect(chargeStanding(null, report, CONFIRM_WINDOW)).toEqual({ state: 'waiting' })
    expect(
      chargeStanding(held({ reportCount: 0, hasReport: false }), report, CONFIRM_WINDOW),
    ).toEqual({ state: 'waiting' })
    expect(chargeStanding(held({}), report, CONFIRM_WINDOW)).toEqual({ state: 'waiting' })
  })

  it('is confirmed and open to a contest until the window the lock holds closes', () => {
    expect(
      chargeStanding(
        held({ state: 'charge_pending', chargeStart: 1_030n }),
        report,
        CONFIRM_WINDOW,
      ),
    ).toEqual({ state: 'confirmed', contestableUntil: 1_630n })
  })

  it('is paid only once the lock shows it charged', () => {
    expect(chargeStanding(held({ state: 'charged' }), report, CONFIRM_WINDOW)).toEqual({
      state: 'paid',
    })
  })

  it("says why a paused charge waits for a ruling, from the lock's own record", () => {
    const paused = (changes: Partial<LockedBacking>) =>
      chargeStanding(held({ state: 'paused', ...changes }), report, CONFIRM_WINDOW)
    expect(paused({ contested: true, chargeStart: 1_030n, pausedAt: 1_100n })).toEqual({
      state: 'paused',
      cause: 'contested',
    })
    // A pause before Avow's deadline to answer is its referral, and one at the deadline is a
    // report it let pass.
    expect(paused({ pausedAt: 1_599n })).toEqual({ state: 'paused', cause: 'referred' })
    expect(paused({ pausedAt: 1_600n })).toEqual({ state: 'paused', cause: 'unanswered' })
  })

  it('has ended when the report was withdrawn, replaced or the commitment ended another way', () => {
    expect(chargeStanding(held({ hasReport: false }), report, CONFIRM_WINDOW)).toEqual({
      state: 'ended',
    })
    expect(chargeStanding(held({ reportCount: 2 }), report, CONFIRM_WINDOW)).toEqual({
      state: 'ended',
    })
    expect(chargeStanding(held({ state: 'released' }), report, CONFIRM_WINDOW)).toEqual({
      state: 'ended',
    })
  })
})
