import { formatUsd } from '@avow-finance/spec'
import { moderatoTransactionUrl } from '../moderato.js'
import {
  LOOP_RESERVE,
  type LoopHeld,
  type LoopOutcome,
  type LoopStep,
  LoopStopped,
  DEMO_SUPPLIER_NAME as SUPPLIER,
  sandboxLoop,
} from '../sandbox/loop.js'
import { micros } from '../sandbox/terms.js'
import { fileStore } from './platform.js'

const at = (unix: bigint) => new Date(Number(unix) * 1000).toISOString()

/** What `avow-sandbox loop` takes, read from its arguments, or why it can't run. */
export function readLoopArgs(args: readonly string[]): { reserve: number } | { error: string } {
  let reserve = LOOP_RESERVE
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    if (flag !== '--reserve') return { error: `loop doesn't take ${flag}` }
    const value = Number(args[++i])
    try {
      micros(value, 'reserve')
    } catch {
      return { error: '--reserve needs a number of dollars, such as 10 or 12.50' }
    }
    reserve = value
  }
  return { reserve }
}

/** What the run says before it books anything, so nobody is surprised by what it spends. */
export function introLines(reserve: number): string[] {
  const each = micros(reserve, 'reserve')
  return [
    `Your agent books one H100 for four minutes, twice, from ${SUPPLIER}, each backed by a ${formatUsd(each)} reserve in your business's lock. It keeps one and cancels the other late.`,
    `The late cancellation costs your business ${formatUsd(each / 2n)} of its test dollars, the charge its terms allow, and every other dollar comes back. It all runs on Tempo's Moderato testnet, within the limits your administrator signed, and takes about ten minutes.`,
  ]
}

/** The line a step prints. */
export function stepLine(step: LoopStep): string {
  const which = (role: 'kept' | 'cancelled') =>
    role === 'kept' ? 'the booking it keeps' : 'the booking it cancels'
  switch (step.type) {
    case 'booking':
      return `Booking ${which(step.role)}.`
    case 'booked':
      return `Reserved ${formatUsd(step.reserve)} for ${which(step.role)}, ${step.reference.commitmentId}. Free cancellation ends at ${at(step.freeCancelBy)} and the reserve releases at ${at(step.releaseDate)}. Anyone can check it at ${step.link}`
    case 'accepted':
      return `${SUPPLIER} accepted ${which(step.role)} on the lock.`
    case 'waiting':
      return step.for === 'free_cancellation'
        ? `Waiting until ${at(step.until)}, when free cancellation has ended, so the cancellation counts as late.`
        : `Waiting for Avow to confirm the charge, by ${at(step.until)}, and for the kept booking's release.`
    case 'cancelled':
      return `Avow recorded the cancellation at ${at(step.cancelledAt)}, after free cancellation ended.`
    case 'reported':
      return `${SUPPLIER} reported a late-cancellation charge of ${formatUsd(step.amount)}, the most its terms allow, in ${moderatoTransactionUrl(step.transaction)}`
  }
}

/** What the run prints once it stops following both bookings. */
export function outcomeLines(o: LoopOutcome): string[] {
  const kept =
    o.kept.state === 'released'
      ? `The lock gave the kept booking's whole reserve back to your business at its release date. ${o.kept.link}`
      : `The kept booking's release is due and hasn't landed yet. Avow's settlement service sends it, and anyone can, so check it again shortly. ${o.kept.link}`
  const c = o.cancelled.charge
  const charge = (() => {
    switch (c.outcome) {
      case 'confirmed':
        return `Avow confirmed the ${formatUsd(c.amount)} late-cancellation charge from its own record of the cancellation, and the rest of the reserve went back to your business.${c.paysAt ? ` The charge pays the supplier at ${at(c.paysAt)}, once the contest window closes, unless your business contests it first.` : ''}`
      case 'charged':
        return `The ${formatUsd(c.amount)} late-cancellation charge has paid the supplier, and the rest of the reserve went back to your business.`
      case 'ruling':
        return `Avow referred the ${formatUsd(c.amount)} late-cancellation charge to a ruling, so the lock holds it until someone rules.`
      case 'awaiting_avow':
        return `The lock holds the ${formatUsd(c.amount)} late-cancellation report, and Avow hadn't answered it when the run stopped waiting.`
      default:
        return `The late-cancellation report stands as ${c.outcome} on the lock.`
    }
  })()
  return [kept, `${charge} ${o.cancelled.link}`]
}

/**
 * What a run that stopped prints, its reason code and every reserve it left in the lock, with when
 * each comes back and the link to check it.
 */
export function stoppedLines(stop: LoopStopped): string[] {
  const held = (h: LoopHeld) => {
    const which = h.role === 'kept' ? 'the booking it was to keep' : 'the booking it was to cancel'
    const id = h.reference.commitmentId
    const holds =
      h.landed === 'unknown'
        ? `Your business's lock may hold ${formatUsd(h.reserve)} for ${which}, ${id}, since its reserve's transaction went out and the chain didn't show whether it landed. If it did, it comes back whole by its release date, ${at(h.releaseDate)}.`
        : `Your business's lock holds ${formatUsd(h.reserve)} for ${which}, ${id}. It comes back whole by its release date, ${at(h.releaseDate)}${h.chargeAsked ? ', less the late-cancellation charge the run asked the supplier for if Avow confirms it' : ''}.`
    const ruling = h.chargeAsked
      ? ' If Avow refers that charge to a ruling instead, the lock keeps it until someone rules, which can be after the release date.'
      : ''
    return `${holds}${ruling} Check it at ${h.link}`
  }
  return [
    stop.message,
    ...(stop.reason ? [`The reason code is ${stop.reason}.`] : []),
    ...(stop.held.length === 0
      ? ['The run booked nothing, so nothing is held.']
      : stop.held.map(held)),
  ]
}

/**
 * `avow-sandbox loop [--reserve <dollars>]`. The agent in this folder, once its business approved
 * it, books twice with Avow's demo GPU supplier, keeps one booking and cancels the other late, and
 * prints what the lock and Avow did with each. It acts with only the agent's key.
 */
export async function loopCommand(args: readonly string[]): Promise<void> {
  const read = readLoopArgs(args)
  if ('error' in read) {
    console.error(read.error)
    process.exit(1)
  }
  for (const line of introLines(read.reserve)) console.log(line)
  try {
    const outcome = await sandboxLoop({
      store: fileStore(),
      reserve: read.reserve,
      onStep: (step) => console.log(stepLine(step)),
    })
    for (const line of outcomeLines(outcome)) console.log(line)
  } catch (error) {
    const lines =
      error instanceof LoopStopped
        ? stoppedLines(error)
        : [error instanceof Error ? error.message : String(error)]
    for (const line of lines) console.error(line)
    process.exitCode = 1
  }
}
