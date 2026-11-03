import {
  AvowApiError,
  type ContestRequest,
  type ContestResult,
  type LandedContest,
  SendError,
} from '@avow-finance/sdk'
import {
  CONTEST_REASON_NAMES,
  CONTEST_REASONS,
  CONTEST_TEXT_MAX_BYTES,
  type ContestReason,
  type ContestStatement,
  describeReason,
  type ReasonCode,
  readCommitmentId,
} from '@avow-finance/spec'
import { CHARGE_NAMES, formatTime } from '@avow-finance/verifier'
import { formatUnits, type Hex } from 'viem'
import {
  type BuyerStore,
  hasLanded,
  type LandedContestRecord,
  neverFunded,
  type SentContest,
} from './store.js'

/** What contesting a charge needs. */
export interface ContestDeps {
  store: BuyerStore
  /** Contests the charge with the root key and gives Avow the statement, as the SDK's `contest` does. */
  contest: (request: ContestRequest) => Promise<ContestResult>
  /** Gives Avow a landed contest's statement again, as the SDK's `postContestStatement` does. */
  post: (contest: LandedContest) => Promise<{ recordedAt: bigint }>
  /** Reads a contest from the transaction that carried it, as the SDK's `readLandedContest` does. */
  landed: (statement: ContestStatement, hash: Hex) => Promise<LandedContest | null>
  /** Whether a transaction's receipt shows it succeeded or reverted, or null when there's none. */
  receipt: (hash: Hex) => Promise<'success' | 'reverted' | null>
  /** The latest finalized block's time, after which a transaction that expired can't land. */
  finalizedTime: () => Promise<bigint>
  log: (line: string) => void
}

/** What `contest` takes: the booking, or none for the latest, the reason and the statement's text. */
export interface ContestArgs {
  commitmentId: Hex | null
  reason: ContestReason
  text: string
}

const USAGE = 'contest [commitmentId] --reason <reason> --statement "<text>"'

/** Reads `contest`'s arguments, refusing a reason that isn't one of the six by name. */
export function contestArgs(args: readonly string[]): ContestArgs {
  let id: string | undefined
  let reason: string | undefined
  let text: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === '--reason' || arg === '--statement') {
      const value = args[i + 1]
      const given = arg === '--reason' ? reason : text
      if (value === undefined || given !== undefined) throw new Error(`Usage: ${USAGE}`)
      if (arg === '--reason') reason = value
      else text = value
      i++
    } else if (id === undefined && !arg.startsWith('--')) {
      id = arg
    } else {
      throw new Error(`Usage: ${USAGE}`)
    }
  }
  if (reason === undefined || text === undefined) throw new Error(`Usage: ${USAGE}`)
  if (!(CONTEST_REASON_NAMES as readonly string[]).includes(reason)) {
    throw new Error(`${reason} isn't a reason. Use one of ${CONTEST_REASON_NAMES.join(', ')}.`)
  }
  const commitmentId = id === undefined ? null : readCommitmentId(id)
  if (id !== undefined && !commitmentId)
    throw new Error(`${id} isn't a commitment id, 32 bytes of hex`)
  return { commitmentId, reason: reason as ContestReason, text }
}

/** A charge as a person reads it, such as "a no-show charge of USD 500". */
const chargeOf = (c: LandedContest['charge']) =>
  `${CHARGE_NAMES[c.kind].toLowerCase()} charge of USD ${formatUnits(c.amount, 6)}`

/** Says what was contested, when the lock paused it, when Avow has to rule by, and the statement. */
function report(log: ContestDeps['log'], c: LandedContestRecord) {
  const { statement: s } = c
  log(
    `contested ${chargeOf(c.charge)} on ${s.commitmentId}, report ${s.reportNumber}, saying ${CONTEST_REASONS[s.reason].says.toLowerCase()} (${s.reason})`,
  )
  log(`the lock paused the charge at ${formatTime(c.pausedAt)}, in ${c.transactionHash}`)
  log(`Avow must rule by ${formatTime(c.ruleBy)}, and after that the arbiter rules`)
  if (c.recordedAt !== null) log(`Avow recorded the statement at ${formatTime(c.recordedAt)}`)
}

/**
 * Contests the charge on a booking, the one named or the one the agent made last, with the
 * business account's root key, and gives Avow the statement. The SDK reads the lock first and
 * refuses a charge that can't be contested, and a refusal is explained here.
 *
 * The contest is saved just before its bytes go out and again once it lands, so a run that stops
 * loses nothing. A later run settles a sent contest from its transaction's receipt. A contest that
 * landed is never sent again, and a later run gives Avow its statement until Avow records it, which
 * is safe to repeat. The lock holds one contest per commitment, so once one is in the store, a later
 * run finishes that one whatever reason and text it's given.
 */
export async function contestBooking(
  deps: ContestDeps,
  args: ContestArgs,
): Promise<LandedContestRecord> {
  const { store, log } = deps
  const booking = args.commitmentId ? store.booking(args.commitmentId) : store.latestBooking()
  if (!booking) {
    throw new Error(
      args.commitmentId
        ? `${store.dir} holds no booking for ${args.commitmentId}`
        : `${store.dir} holds no booking yet. Run book first.`,
    )
  }
  const id = booking.commitmentId
  if (neverFunded(booking)) {
    throw new Error(`The booking ${id} was never funded, so it has nothing to contest`)
  }
  let known = store.contest(id)
  if (known && !hasLanded(known)) known = await settleSent(deps, id, known)
  if (known) {
    const { reason, text } = known.statement
    if (reason !== args.reason || text !== args.text) {
      log(
        `${id} already has a contest with its own reason and statement, which can't change, so the ones given aren't used`,
      )
    }
    return finish(deps, known)
  }

  log(`contesting the charge on ${id} with the business account's root key`)
  let result: ContestResult
  try {
    result = await deps.contest({
      commitmentId: id,
      reason: args.reason,
      text: args.text,
      onSent: ({ statement, hash, validBefore }) =>
        store.saveContest(id, { statement, sent: { hash, validBefore } }),
    })
  } catch (e) {
    throw sendFailure(e, deps, id)
  }
  if (!result.ok) throw refused(result.reason, id)
  const contest: LandedContestRecord = {
    ...result.contest,
    recordedAt: result.posted.ok ? result.posted.recordedAt : null,
  }
  store.saveContest(id, contest)
  report(log, contest)
  if (!result.posted.ok) throw unrecorded(id, result.posted.error)
  return contest
}

/**
 * Finishes a contest the store shows landed. One whose statement Avow recorded is reported as it
 * stands, and Avow is given the statement of one it hasn't recorded yet.
 */
async function finish(deps: ContestDeps, known: LandedContestRecord): Promise<LandedContestRecord> {
  const { store, log } = deps
  const id = known.statement.commitmentId
  if (known.recordedAt !== null) {
    log(`${id} is already contested, so the lock isn't asked again`)
    report(log, known)
    return known
  }
  log(`${id} is contested, so Avow is given the statement again`)
  let recordedAt: bigint
  try {
    recordedAt = (await deps.post(known)).recordedAt
  } catch (e) {
    report(log, known)
    throw unrecorded(id, e)
  }
  const contest: LandedContestRecord = { ...known, recordedAt }
  store.saveContest(id, contest)
  report(log, contest)
  return contest
}

/**
 * Settles a contest an earlier run sent, from its transaction's receipt. One that landed is saved
 * and returned. One that may still land stops the run, and one that never landed is forgotten, so
 * the run goes on to read the lock. The finalized time is read before the receipt, as for a
 * cancellation, so the transaction can't land between the two reads.
 */
async function settleSent(
  deps: ContestDeps,
  id: Hex,
  known: SentContest,
): Promise<LandedContestRecord | null> {
  const { hash, validBefore } = known.sent
  const finalized = await deps.finalizedTime()
  const status = await deps.receipt(hash)
  if (status === 'success') {
    const landed = await deps.landed(known.statement, hash)
    if (!landed) throw new Error(`${hash} landed, but the chain shows no contest of ${id} in it`)
    const contest: LandedContestRecord = { ...landed, recordedAt: null }
    deps.store.saveContest(id, contest)
    deps.log(`the contest of ${id} sent in ${hash} landed`)
    return contest
  }
  if (status === null && (validBefore === null || finalized <= validBefore)) {
    throw new Error(
      `The contest of ${id} sent in ${hash} may still land. Run contest again in a minute.`,
    )
  }
  deps.store.forgetSentContest(id)
  deps.log(`the contest of ${id} sent in ${hash} never landed`)
  return null
}

/** An error saying Avow hasn't recorded the statement, though the contest stands. */
function unrecorded(id: Hex, error: unknown): Error {
  const why = error instanceof Error ? error.message : String(error)
  const unclear = error instanceof AvowApiError && !error.definite
  return new Error(
    `Avow ${unclear ? 'gave no definite answer about' : "didn't record"} the statement (${why}). The contest of ${id} stands and the charge stays paused. Run contest again to give Avow the statement, which is safe to repeat.`,
    { cause: error },
  )
}

/** What a failed send means for the contest, with what to run next. */
function sendFailure(e: unknown, deps: ContestDeps, id: Hex): unknown {
  if (!(e instanceof SendError)) return e
  if (e.outcome === 'failed') {
    const known = deps.store.contest(id)
    if (known && !hasLanded(known)) deps.store.forgetSentContest(id)
    return new Error(
      `The contest of ${id} failed, so the charge isn't paused (${e.message}). Run contest again, which reads the lock first.`,
      { cause: e },
    )
  }
  return new Error(
    `Whether the contest of ${id} landed is unknown. Run contest again, which settles it from the transaction's receipt.`,
    { cause: e },
  )
}

/** An error for a reason the SDK gave for not contesting. */
function refused(reason: ReasonCode, id: Hex): Error {
  switch (reason) {
    case 'chain.reserve_missing':
      return new Error(`The lock holds no reserve for ${id}, so it has nothing to contest`)
    case 'contest.already_contested':
      return new Error(
        `The business has already contested a charge on ${id}. The contest stays on record, so a later report pauses at once, and the lock takes no second contest.`,
      )
    case 'contest.not_contestable':
      return new Error(
        `The lock holds no pending charge and no standing report on ${id}, so there's nothing to contest. A charge Avow already paused goes to a ruling without a contest.`,
      )
    case 'contest.window_closed':
      return new Error(
        `The contest window of the charge on ${id} has closed by the chain's clock, or closes within the 25 seconds a contest sent now could take to land, so the charge can no longer be contested`,
      )
    case 'contest.reason_not_for_charge':
      return new Error(
        `That reason doesn't answer the charge the supplier reported on ${id}. never_cancelled and cancelled_in_time answer a late cancellation, job_started and supplier_did_not_provide answer a no-show, and wrong_charge and other answer either.`,
      )
    case 'contest.statement_invalid':
      return new Error(
        `The statement needs some text, at most ${CONTEST_TEXT_MAX_BYTES} bytes of UTF-8, and no control character but tabs and line breaks`,
      )
    default:
      return new Error(`${describeReason(reason)} (${reason})`)
  }
}
