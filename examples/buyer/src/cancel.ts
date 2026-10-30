import {
  type AgentCalls,
  type AgentRecordCalls,
  AvowApiError,
  type Call,
  cancelFreeCall,
} from '@avow-finance/sdk'
import { describeReason } from '@avow-finance/spec'
import { formatTime } from '@avow-finance/verifier'
import type { Hex } from 'viem'
import { type BuyerStore, type Cancellation, neverFunded } from './store.js'

/** What cancelling a booking needs. */
export interface CancelDeps {
  store: BuyerStore
  /** The business's agent, which asks Avow to record a cancellation and reads the lock. */
  agent: Pick<AgentCalls, 'lock' | 'commitment'> & Pick<AgentRecordCalls, 'cancel'>
  /** The latest block's time, which the lock judges free cancellation by. */
  chainTime: () => Promise<bigint>
  /**
   * Sends a call from the business account's root key, which pays its own fee, and resolves once
   * it lands. It throws when the transaction fails or its outcome is unknown.
   */
  sendFromRoot: (call: Call) => Promise<{ transactionHash: Hex }>
  log: (line: string) => void
}

const COMMITMENT_ID = /^0x[0-9a-fA-F]{64}$/

/** What `cancel` takes, the commitment to cancel or none for the booking made last. */
export function cancelArgs(args: readonly string[]): { commitmentId: Hex | null } {
  const [id, ...rest] = args
  if (rest.length > 0) throw new Error('cancel takes one commitment id at most')
  if (id === undefined) return { commitmentId: null }
  if (!COMMITMENT_ID.test(id)) throw new Error(`${id} isn't a commitment id, 32 bytes of hex`)
  return { commitmentId: id.toLowerCase() as Hex }
}

const said = (c: Cancellation) =>
  c.by === 'avow'
    ? `Avow recorded it at ${formatTime(c.cancelledAt)}`
    : `on the lock in ${c.transactionHash}`

/**
 * Cancels a booking, the one named or the one the agent made last. The agent asks Avow to record
 * the cancellation, and Avow's timestamp on that request is what a late-cancellation charge rests
 * on. Before free cancellation ends Avow refuses with `commitment.cancel_on_lock`, and the
 * business cancels on the lock with its root key, which gives the whole reserve back. Once the
 * charge deadline has passed Avow refuses with `commitment.ended`, and nothing can cancel it.
 *
 * A booking the store already shows cancelled is never sent again. Avow answers a second
 * cancellation with the first one's record, which names another signed request, so the SDK can't
 * read it.
 */
export async function cancelBooking(
  deps: CancelDeps,
  commitmentId: Hex | null,
): Promise<Cancellation> {
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
  if (known) {
    log(`${id} is already cancelled, ${said(known)}, so Avow isn't asked again`)
    return known
  }

  log(`asking Avow to record the cancellation of ${id}`)
  let answer: Awaited<ReturnType<CancelDeps['agent']['cancel']>>
  try {
    answer = await agent.cancel(id)
  } catch (e) {
    if (e instanceof AvowApiError && e.reason === 'commitment.cancel_on_lock') {
      return cancelOnLock(deps, id)
    }
    if (e instanceof AvowApiError && e.reason === 'commitment.ended') {
      throw new Error(`${id} can no longer be cancelled, since its charge deadline has passed`)
    }
    if (e instanceof AvowApiError && !e.definite) {
      throw new Error(
        `Avow gave no definite answer, so it may have recorded the cancellation of ${id}. If it did, it answers another cancellation with the first one's record, which this quickstart can't read.`,
        { cause: e },
      )
    }
    throw e
  }
  if (!answer.ok) {
    const why = `${describeReason(answer.reason)} (${answer.reason})`
    throw new Error(
      answer.reason === 'mandate.action_not_permitted'
        ? `${why}. A business enrolled before cancel existed enrolls again with a new STATE_DIR.`
        : why,
    )
  }
  const cancellation: Cancellation = { by: 'avow', cancelledAt: answer.cancelledAt }
  store.saveCancellation(id, cancellation)
  log(`Avow recorded the cancellation of ${id} at ${formatTime(answer.cancelledAt)}`)
  return cancellation
}

/**
 * Cancels on the lock, before free cancellation ends, with the business account's root key. It
 * reads the lock first and sends nothing the lock would refuse. The lock has to hold the reserve
 * with no report open, and free cancellation has to be open by the chain's clock.
 */
async function cancelOnLock(deps: CancelDeps, id: Hex): Promise<Cancellation> {
  const { agent, log } = deps
  log(`free cancellation of ${id} hasn't ended, so the business cancels on the lock`)
  const held = await agent.commitment(id)
  if (!held) throw new Error(`The lock holds no reserve for ${id}, so it has nothing to cancel`)
  if (held.state === 'released') {
    throw new Error(`The lock has already given the reserve for ${id} back to the business`)
  }
  if (!(held.state === 'reserved' || (held.state === 'accepted' && !held.hasReport))) {
    const report = held.hasReport ? ' with a report open' : ''
    throw new Error(`The lock holds ${id} as ${held.state}${report}, so it can't cancel it`)
  }
  if ((await deps.chainTime()) >= held.freeCancelBy) {
    throw new Error(
      `Free cancellation of ${id} ended at ${formatTime(held.freeCancelBy)} by the chain's clock. Run cancel again to have Avow record a late cancellation.`,
    )
  }
  const { transactionHash } = await deps.sendFromRoot(cancelFreeCall(agent.lock, id))
  const cancellation: Cancellation = { by: 'lock', transactionHash }
  deps.store.saveCancellation(id, cancellation)
  log(`cancelled ${id} on the lock in ${transactionHash}, and the whole reserve went back`)
  return cancellation
}
