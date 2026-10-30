import {
  type AgentCalls,
  type AgentRecordCalls,
  AvowApiError,
  type Call,
  cancelFreeCall,
  cancelsFree,
  type OnSent,
  SendError,
} from '@avow-finance/sdk'
import { describeReason, type ReasonCode, readCommitmentId } from '@avow-finance/spec'
import { formatTime, type LockedBacking } from '@avow-finance/verifier'
import type { Hex } from 'viem'
import {
  type BuyerStore,
  isSettled,
  neverFunded,
  type SentCancellation,
  type SettledCancellation,
} from './store.js'

/** What cancelling a booking needs. */
export interface CancelDeps {
  store: BuyerStore
  /** The business's agent, which asks Avow to record a cancellation and reads the lock. */
  agent: Pick<AgentCalls, 'lock' | 'commitment'> & Pick<AgentRecordCalls, 'cancel'>
  /** The latest block's time, which the lock judges free cancellation by. */
  chainTime: () => Promise<bigint>
  /** The latest finalized block's time, after which a transaction that expired can't land. */
  finalizedTime: () => Promise<bigint>
  /**
   * Sends a call from the business account's root key, which pays its own fee, and resolves once
   * it lands. It calls `onSent` with each transaction's hash before the bytes go out, and throws a
   * `SendError` when the transaction fails or its outcome is unknown.
   */
  sendFromRoot: (call: Call, onSent: OnSent) => Promise<{ transactionHash: Hex }>
  /** Whether a transaction's receipt shows it succeeded or reverted, or null when there's none. */
  receipt: (hash: Hex) => Promise<'success' | 'reverted' | null>
  log: (line: string) => void
}

/** What `cancel` takes, the commitment to cancel or none for the booking made last. */
export function cancelArgs(args: readonly string[]): { commitmentId: Hex | null } {
  const [id, ...rest] = args
  if (rest.length > 0) throw new Error('cancel takes one commitment id at most')
  if (id === undefined) return { commitmentId: null }
  const commitmentId = readCommitmentId(id)
  if (!commitmentId) throw new Error(`${id} isn't a commitment id, 32 bytes of hex`)
  return { commitmentId }
}

const said = (c: SettledCancellation) =>
  c.by === 'avow'
    ? `Avow recorded it at ${formatTime(c.cancelledAt)}`
    : `on the lock in ${c.transactionHash}`

/**
 * Cancels a booking, the one named or the one the agent made last, and reads the lock first. While
 * the lock takes a free cancellation by the chain's clock, the root key cancels there, whatever the
 * agent's mandate permits, and the whole reserve comes back. Once free cancellation has ended, the
 * agent asks Avow to record the cancellation, and Avow's timestamp on that request is what a
 * late-cancellation charge rests on. A commitment the lock has already ended is never sent to Avow.
 *
 * A cancellation sent to the lock is saved just before its bytes go out, and a later run settles it
 * from the transaction's receipt. A booking the store shows cancelled is never sent again, since
 * Avow answers a second cancellation with the first one's record, which the SDK can't read.
 */
export async function cancelBooking(
  deps: CancelDeps,
  commitmentId: Hex | null,
): Promise<SettledCancellation> {
  const { store, agent, log } = deps
  const booking = commitmentId ? store.booking(commitmentId) : store.latestBooking()
  if (!booking) {
    throw new Error(
      commitmentId
        ? `${store.dir} holds no booking for ${commitmentId}`
        : `${store.dir} holds no booking yet. Run book first.`,
    )
  }
  const id = booking.commitmentId
  if (neverFunded(booking)) {
    throw new Error(`The booking ${id} was never funded, so it has nothing to cancel`)
  }
  const known = store.cancellation(id)
  if (known && isSettled(known)) {
    log(`${id} is already cancelled, ${said(known)}, so Avow isn't asked again`)
    return known
  }
  if (known) {
    const landed = await settleSent(deps, id, known)
    if (landed) return landed
  }

  const held = await agent.commitment(id)
  if (!held) throw new Error(`The lock holds no reserve for ${id}, so it has nothing to cancel`)
  if (cancelsFree(held, await deps.chainTime())) return cancelOnLock(deps, id)
  const ended = endedOn(held)
  if (ended) throw new Error(`${ended}, so ${id} has nothing left to cancel`)
  return cancelWithAvow(deps, id)
}

/** What the lock has already done with a commitment that leaves nothing to cancel, or null. */
function endedOn(held: LockedBacking): string | null {
  switch (held.state) {
    case 'released':
      return 'The lock has already given the reserve back to the business'
    case 'charged':
      return 'The lock has already paid the charge'
    case 'resolved':
      return 'The lock has already settled the charge after a dispute'
    default:
      return null
  }
}

/**
 * Settles a cancellation an earlier run sent to the lock, from its transaction's receipt. One that
 * landed is recorded and returned. One that may still land stops the run, and one that never landed
 * is forgotten, so the run goes on to read the lock.
 *
 * The finalized time is read before the receipt. A transaction lands only before its
 * `validBefore`, so once the finalized time has passed that, a receipt read afterwards shows
 * whether it ever landed. Read the other way round, it could land between the two reads.
 */
async function settleSent(
  deps: CancelDeps,
  id: Hex,
  known: SentCancellation,
): Promise<SettledCancellation | null> {
  const { hash, validBefore } = known.sent
  const finalized = await deps.finalizedTime()
  const status = await deps.receipt(hash)
  if (status === 'success') {
    const cancellation: SettledCancellation = { by: 'lock', transactionHash: hash }
    deps.store.saveCancellation(id, cancellation)
    deps.log(`the cancellation of ${id} sent in ${hash} landed, and the whole reserve went back`)
    return cancellation
  }
  if (status === null && (validBefore === null || finalized <= validBefore)) {
    throw new Error(
      `The cancellation of ${id} sent in ${hash} may still land. Run cancel again in a minute.`,
    )
  }
  deps.store.forgetSentCancellation(id)
  deps.log(`the cancellation of ${id} sent in ${hash} never landed`)
  return null
}

/** Cancels on the lock with the business account's root key, which gives the whole reserve back. */
async function cancelOnLock(deps: CancelDeps, id: Hex): Promise<SettledCancellation> {
  const { store, log } = deps
  log(`free cancellation of ${id} is still open on the chain, so the root key cancels on the lock`)
  let landed: { transactionHash: Hex }
  try {
    landed = await deps.sendFromRoot(cancelFreeCall(deps.agent.lock, id), (hash, validBefore) => {
      store.saveCancellation(id, { by: 'lock', sent: { hash, validBefore } })
    })
  } catch (e) {
    if (e instanceof SendError && e.outcome === 'failed') {
      if (store.cancellation(id)) store.forgetSentCancellation(id)
      throw new Error(
        `The free cancellation of ${id} failed, so the lock still holds the reserve (${e.message}). Run cancel again, which reads the lock first.`,
        { cause: e },
      )
    }
    if (e instanceof SendError) {
      throw new Error(
        `Whether the free cancellation of ${id} landed is unknown. Run cancel again, which settles it from the transaction's receipt.`,
        { cause: e },
      )
    }
    throw e
  }
  const cancellation: SettledCancellation = { by: 'lock', transactionHash: landed.transactionHash }
  store.saveCancellation(id, cancellation)
  log(`cancelled ${id} on the lock in ${landed.transactionHash}, and the whole reserve went back`)
  return cancellation
}

/** Has Avow record a late cancellation, once free cancellation has ended on the chain. */
async function cancelWithAvow(deps: CancelDeps, id: Hex): Promise<SettledCancellation> {
  const { store, log } = deps
  log(`free cancellation of ${id} has ended, so the agent asks Avow to record the cancellation`)
  let answer: Awaited<ReturnType<CancelDeps['agent']['cancel']>>
  try {
    answer = await deps.agent.cancel(id)
  } catch (e) {
    throw avowRefusal(e, id)
  }
  if (!answer.ok) throw refused(answer.reason, id)
  const cancellation: SettledCancellation = { by: 'avow', cancelledAt: answer.cancelledAt }
  store.saveCancellation(id, cancellation)
  log(`Avow recorded the cancellation of ${id} at ${formatTime(answer.cancelledAt)}`)
  return cancellation
}

/** The reasons for not recording a cancellation that this command explains. */
const EXPLAINED: readonly ReasonCode[] = [
  'commitment.ended',
  'commitment.cancel_on_lock',
  'mandate.action_not_permitted',
]

/** Says what an error from Avow's API means for this cancellation, or passes it on as it is. */
function avowRefusal(e: unknown, id: Hex): unknown {
  if (!(e instanceof AvowApiError)) return e
  if (!e.definite) {
    return new Error(
      `Avow gave no definite answer, so it may have recorded the cancellation of ${id}. If it did, it answers another cancellation with the first one's record, which this quickstart can't read.`,
      { cause: e },
    )
  }
  // Only an answer that came with a 2xx is a cancellation Avow recorded. A refusal with the same
  // reason, such as for a value in the body Avow can't store, recorded nothing.
  if (e.reason === 'message.invalid' && e.status >= 200 && e.status < 300) {
    return new Error(
      `Avow answered the cancellation of ${id} with one this run didn't ask for. Avow keeps one cancellation per commitment and answers every later request with it, so an earlier run most likely got Avow's answer and stopped before saving it, and the booking is already cancelled at Avow. This quickstart can't read the time Avow recorded from an answer to another request.`,
      { cause: e },
    )
  }
  if (e.reason && EXPLAINED.includes(e.reason)) return refused(e.reason, id, e)
  return e
}

/** An error for a reason Avow or the agent gave for not recording the cancellation. */
function refused(reason: ReasonCode, id: Hex, cause?: unknown): Error {
  const options = cause === undefined ? undefined : { cause }
  switch (reason) {
    case 'commitment.ended':
      return new Error(
        `${id} can no longer be cancelled, since its charge deadline has passed`,
        options,
      )
    case 'commitment.cancel_on_lock':
      return new Error(
        `Avow says free cancellation of ${id} hasn't ended, and the lock won't take a free cancellation now, so nothing can cancel it this moment. Run cancel again in a minute.`,
        options,
      )
    case 'mandate.action_not_permitted':
      return new Error(
        `The agent's mandate doesn't permit cancelling through Avow, and free cancellation of ${id} has ended, so the lock won't take it either. Enrolling again keeps this mandate. A mandate that permits cancel and start comes from running init with a new STATE_DIR, having Avow register the new account and lock, and then running enroll.`,
        options,
      )
    default:
      return new Error(`${describeReason(reason)} (${reason})`, options)
  }
}
