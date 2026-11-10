import type { LockedBacking } from '@avow-finance/verifier'
import type { ChargeStanding, ReportedCharge } from './world.js'

/**
 * Where a reported charge stands, read from what the lock holds for its commitment. The live world
 * and the fixture world both read a charge through this, so a state means the same in each.
 *
 * A lock that shows fewer reports than the report's number hasn't shown it yet, and one that shows
 * more replaced it after a withdrawal. A paused charge says why from the lock's own record: the
 * business's contest, or a pause at or after Avow's deadline to answer, which is a report Avow let
 * pass, or an earlier one, which is Avow's referral.
 */
export function chargeStanding(
  held: LockedBacking | null,
  report: Pick<ReportedCharge, 'reportNumber' | 'reportedAt'>,
  confirmWindow: bigint,
): ChargeStanding {
  if (!held || held.reportCount < report.reportNumber) return { state: 'waiting' }
  if (held.reportCount > report.reportNumber) return { state: 'ended' }
  switch (held.state) {
    case 'accepted':
      return held.hasReport ? { state: 'waiting' } : { state: 'ended' }
    case 'charge_pending':
      return { state: 'confirmed', contestableUntil: held.chargeStart + held.contestWindow }
    case 'charged':
      return { state: 'paid' }
    case 'paused': {
      const late = held.pausedAt >= report.reportedAt + confirmWindow
      return {
        state: 'paused',
        cause: held.contested ? 'contested' : late ? 'unanswered' : 'referred',
      }
    }
    default:
      return { state: 'ended' }
  }
}
