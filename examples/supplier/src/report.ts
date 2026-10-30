import { type Call, type OnSent, SendError } from '@avow-finance/sdk'
import {
  type ChargeKind,
  describeReason,
  type HashSigner,
  readCommitmentId,
} from '@avow-finance/spec'
import {
  CHARGE_NAMES,
  type ChainReader,
  formatDuration,
  formatLockAmount,
  formatTime,
  type LockedBacking,
  listedToken,
  prepareReport,
  type ReportConfig,
  reportCall,
  signReport,
} from '@avow-finance/verifier'
import { type Hex, keccak256, stringToHex } from 'viem'
import { showDisclosure } from './disclosure.js'
import type { Booking, FiledReport, SupplierStore } from './store.js'

export interface ReportChargeDeps {
  store: SupplierStore
  /** The verifier's settings for a report, with the supplier's signing key. */
  config: ReportConfig
  chain: ChainReader
  signingKey: HashSigner
  /** Sends a call the signing key pays the fee for, and resolves with its receipt once it lands. */
  send: (call: Call, onSent: OnSent) => Promise<{ status: 'success' | 'reverted' }>
  /** The latest block's time, which the lock judges a report's timing by. */
  chainTime: () => Promise<bigint>
  /** The latest finalized block's time. */
  finalizedTime: () => Promise<bigint>
  /** Waits between reads of the lock while Avow decides. */
  wait: () => Promise<void>
  log: (line: string) => void
}

/**
 * What the lock shows became of a report. `confirmed` while the confirmed charge waits for its
 * contest window to close, `charged` once it has paid, `ruling` once it's paused for a ruling,
 * `unanswered` when Avow let the report's deadline pass, `withdrawn` when the supplier account took
 * it back, and `ended` when the commitment ended another way.
 */
export type ReportOutcome =
  | 'confirmed'
  | 'charged'
  | 'ruling'
  | 'unanswered'
  | 'withdrawn'
  | 'ended'

/**
 * What `report` takes, the booking or none for the latest accepted one, and whether it reports a
 * no-show.
 */
export function reportArgs(args: readonly string[]): {
  commitmentId: Hex | null
  kind: ChargeKind
} {
  const flags = args.filter((a) => a.startsWith('--'))
  const ids = args.filter((a) => !a.startsWith('--'))
  const unknown = flags.filter((f) => f !== '--no-show')
  if (unknown.length > 0) throw new Error(`report takes no ${unknown.join(' or ')}`)
  const [id, ...rest] = ids
  if (rest.length > 0) throw new Error('report takes one commitment id at most')
  const commitmentId = id === undefined ? null : readCommitmentId(id)
  if (id !== undefined && !commitmentId) {
    throw new Error(`${id} isn't a commitment id, 32 bytes of hex`)
  }
  return { commitmentId, kind: flags.includes('--no-show') ? 'noShow' : 'lateCancellation' }
}

/**
 * The note a report's evidence hash covers, which says what booking and kind it reports and when.
 */
export function evidenceNote(booking: Booking, kind: ChargeKind, at: bigint): string {
  return `${CHARGE_NAMES[kind]} on booking ${booking.commitmentId}, lock ${booking.lock} on chain ${booking.chainId}, reported at ${formatTime(at)}.`
}

/**
 * What report `reportNumber` has come to on the lock, or null while the read doesn't show it yet or
 * Avow hasn't answered it before its deadline. A node behind the report's block shows fewer reports
 * than its number, and a later report shows the supplier account withdrew it, since the lock takes
 * one at a time. A confirmed charge waits in `charge_pending`, and a referred or contested one in
 * `paused`.
 */
export function reportOutcome(
  held: LockedBacking | null,
  reportNumber: number,
  pastDeadline: boolean,
): ReportOutcome | null {
  if (!held || held.reportCount < reportNumber) return null
  if (held.reportCount > reportNumber) return 'withdrawn'
  switch (held.state) {
    case 'accepted':
      if (!held.hasReport) return 'withdrawn'
      return pastDeadline ? 'unanswered' : null
    case 'charge_pending':
      return 'confirmed'
    case 'charged':
      return 'charged'
    case 'paused':
      return 'ruling'
    default:
      return 'ended'
  }
}

/**
 * Reports a charge on a booking the supplier accepted, the one named or the latest. It writes the
 * note the report's evidence hash covers to the store, has the verifier build the report from the
 * lock, signs it once its disclosure is shown, and sends it from the signing key, which pays its
 * own fee. The transaction's hash is recorded before its bytes go out. Then it follows the lock
 * until Avow confirms the charge or refers it to a ruling, or the report's deadline passes.
 *
 * A report the store shows sent is never sent twice. Once the lock's report count reaches the
 * report's number, it landed, and this follows it whatever became of it, a withdrawal included.
 * While it may still land, this stops and says so, and only a report that can no longer land gives
 * way to a new one.
 */
export async function reportCharge(
  deps: ReportChargeDeps,
  args: { commitmentId: Hex | null; kind: ChargeKind },
): Promise<ReportOutcome> {
  const { store, chain, log } = deps
  const booking = args.commitmentId ? store.booking(args.commitmentId) : store.latestAccepted()
  if (!booking) {
    throw new Error(
      args.commitmentId
        ? `${store.dir} holds no booking for ${args.commitmentId}`
        : `${store.dir} holds no accepted booking yet`,
    )
  }
  const id = booking.commitmentId
  if (booking.status !== 'accepted') {
    throw new Error(
      `The booking ${id} is ${booking.status}, and only an accepted one takes a report`,
    )
  }

  const filed = store.report(id)
  if (filed?.sent) {
    // Read before the lock, since a report lands only before its validBefore. Once the finalized
    // time has passed that, a lock read afterwards shows whether it ever landed.
    const finalized = await deps.finalizedTime()
    const held = await chain.backing(booking.lock, id, 'buyer')
    if (held && held.reportCount >= filed.reportNumber) {
      log(`the report sent in ${filed.sent.hash} landed on the lock, so no other is sent`)
      return follow(deps, booking, filed.reportNumber)
    }
    const { validBefore } = filed.sent
    if (validBefore === null || finalized <= validBefore) {
      throw new Error(
        `The report sent in ${filed.sent.hash} may still land. Run report again in a minute.`,
      )
    }
    log(`the report sent in ${filed.sent.hash} never landed, so a new one goes`)
  }

  const now = await deps.chainTime()
  const note = evidenceNote(booking, args.kind, now)
  const evidenceHash = keccak256(stringToHex(note))
  const prepared = await prepareReport(
    { lock: booking.lock, commitmentId: id, kind: args.kind, evidenceHash, now },
    { config: deps.config, chain },
  )
  if (!prepared.ok) {
    throw new Error(
      `The verifier built no report for ${id}: ${describeReason(prepared.reason)} (${prepared.reason})`,
    )
  }
  showDisclosure(prepared.disclosure, log)
  const signed = await signReport(prepared, deps.signingKey, {
    disclosureId: prepared.disclosure.id,
  })
  const report: FiledReport = {
    commitmentId: id,
    reportNumber: prepared.reportNumber,
    kind: args.kind,
    amount: prepared.report.amount,
    note,
    evidenceHash,
  }
  store.putReport(report)
  let receipt: { status: 'success' | 'reverted' }
  try {
    receipt = await deps.send(reportCall(signed), (hash, validBefore) => {
      store.putReport({ ...report, sent: { hash, validBefore } })
    })
  } catch (e) {
    if (e instanceof SendError && e.outcome === 'failed') {
      throw new Error(`Sending the report for ${id} failed, so the lock took none: ${e.message}`, {
        cause: e,
      })
    }
    throw e
  }
  if (receipt.status !== 'success') {
    throw new Error(`The report for ${id} reverted, so the lock didn't take it`)
  }
  log(`the lock took the report of ${CHARGE_NAMES[args.kind].toLowerCase()} on ${id}`)
  return follow(deps, booking, prepared.reportNumber)
}

/**
 * Follows the lock after report `reportNumber` lands, until Avow answers it or the report's
 * deadline passes, and says what became of it. Avow has the confirmation window from the first
 * report of a kind, so a report that landed by now has its deadline no later than a window from
 * now. A read that doesn't show the report yet comes from a node behind its block, so this waits
 * on it, and stops once the deadline passes without the report showing.
 */
async function follow(
  deps: ReportChargeDeps,
  booking: Booking,
  reportNumber: number,
): Promise<ReportOutcome> {
  const { chain, log } = deps
  const id = booking.commitmentId
  const lockInfo = await chain.lock(booking.lock)
  if (!lockInfo) throw new Error(`The lock ${booking.lock} isn't one Avow's factory made`)
  const deadline = (await deps.chainTime()) + lockInfo.timing.confirmWindow
  log(`waiting for Avow to confirm or refer the report on ${id}`)
  for (;;) {
    const held = await chain.backing(booking.lock, id, 'buyer')
    const pastDeadline = (await deps.chainTime()) >= deadline
    const outcome = reportOutcome(held, reportNumber, pastDeadline)
    if (held && outcome) {
      log(say(outcome, id, held, deps.config))
      return outcome
    }
    if (pastDeadline) {
      throw new Error(
        `The report on ${id} landed, but the node still shows the lock without it. Run report again to follow it.`,
      )
    }
    await deps.wait()
  }
}

/** What to tell the supplier a report has come to. */
function say(outcome: ReportOutcome, id: Hex, held: LockedBacking, config: ReportConfig): string {
  const token = listedToken(config.acceptedTokens, config.chainId, held.token)
  switch (outcome) {
    case 'confirmed':
      return `Avow confirmed the charge on ${id}. It pays ${formatLockAmount(held.held, token)} once the contest window of ${formatDuration(held.contestWindow)} closes, unless the business contests it first, and the rest of the reserve went back to the business.`
    case 'charged':
      return `The charge on ${id} has paid out.`
    case 'ruling':
      return `The report on ${id} went to a ruling. Avow referred it, the business contested it, or Avow didn't answer it in time.`
    case 'unanswered':
      return `Avow didn't confirm or refer the report on ${id} before its deadline, so it goes to a ruling.`
    case 'withdrawn':
      return `The supplier account withdrew the report on ${id}, so nothing comes of it.`
    case 'ended':
      return `The lock shows ${id} as ${held.state}.`
  }
}
