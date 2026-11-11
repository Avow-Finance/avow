import type { ToolCall, ToolResult } from './agent-session.js'
import type { ComputeOffers } from './compute-offers.js'
import type { ChargeKind } from './eip712.js'
import type { ChargePauseCause, JobCharge } from './job-session.js'
import type { RailState } from './rail.js'
import type { CommitmentReference } from './references.js'
import { formatUsd, type SessionEvent } from './sandbox.js'
import { TEST_CUSTOMER_LABEL } from './test-customer.js'

/**
 * A commitment as one card, which the terminal and the screen both draw, so a commitment reads
 * the same in each. A card says who promises whom, what the promise is, what breaking it costs,
 * what money stands behind it and which other commitment it rests on. It keeps the promise's
 * status apart from the money's, since a promise can be broken while the charge for breaking it is
 * still open to a contest. Every row comes from the events a job recorded, so a card claims nothing
 * the session didn't record. A screen that reads the lock hands its reading over, and the card
 * then says where the money stands from the chain, which goes on after the session ends.
 */

/** A card's rows, in the order every card keeps them. */
export const CARD_LABELS = [
  'Promise',
  'If broken',
  'Backed by',
  'Not backed',
  'Depends on',
  'Money now',
] as const
export type CardLabel = (typeof CARD_LABELS)[number]

export interface CommitmentCard {
  /** `compute` is the business's booking of compute, and `job` the customer's commitment. */
  role: 'job' | 'compute'
  /** The commitment on its lock, which a screen reads and anyone can check. */
  reference: CommitmentReference
  /** Who made the promise and reserved the money behind it. */
  from: string
  /** Who the money is reserved for. */
  to: string
  /**
   * Where the promise stands. `accepted` is in force, `kept` is a job delivered and paid, `broken`
   * is a job its customer cancelled after the start, and `ended` is over with neither.
   */
  promise: 'accepted' | 'kept' | 'broken' | 'ended'
  /** Where the money behind it stands, which the `Money now` row says in words. */
  money: CardMoney
  /** The promise in a few words, such as "$40 on delivery" or "1 H100, 20:54 to 21:09". */
  brief: string
  /** The money reserved behind the promise, in micros. */
  reserved: bigint
  /**
   * What the reserve leaves unbacked, which the `Not backed` row says, or null where the card names
   * nothing. A job's reserve pays its listed charges and none of the price.
   */
  unbacked: string | null
  /** The charge on it, where there is one, with when its contest window closes once confirmed. */
  charge: { amount: bigint; contestableUntil: bigint | null } | null
  rows: { label: CardLabel; text: string }[]
}

/**
 * The money behind a commitment. A charge goes from reported, to confirmed by Avow and open to a
 * contest, to paid. A contest or a report Avow doesn't confirm pauses it for a ruling instead.
 */
export type CardMoney =
  | 'reserved'
  | 'released'
  | 'charge_reported'
  | 'charge_confirmed'
  | 'charge_paused'
  | 'charged'
  | 'resolved'

/**
 * What a lock holds for a commitment, as far as a card reads it. The verifier's `LockedBacking`
 * carries every field, so a screen hands its reading straight over.
 */
export interface CardLockRead {
  state: RailState
  hasReport: boolean
  reportAmount: bigint
  contested: boolean
  chargeStart: bigint
  contestWindow: bigint
}

/** The lock's reading for each of an order's commitments, where a screen has one. */
export type CardChain = Partial<Record<CommitmentCard['role'], CardLockRead | null>>

/** Where a card's money stands, before it's put in words. */
type MoneyFacts =
  | { state: 'reserved' | 'released' | 'resolved' }
  | { state: 'charge_reported' | 'charged'; amount: bigint }
  | { state: 'charge_confirmed'; amount: bigint; contestableUntil: bigint }
  | { state: 'charge_paused'; cause: ChargePauseCause | null }

/** Where the money stands from the lock's own reading, or null for a lock that holds nothing. */
function moneyOnLock(read: CardLockRead, cause: ChargePauseCause | null): MoneyFacts | null {
  switch (read.state) {
    case 'reserved':
    case 'accepted':
      return read.hasReport
        ? { state: 'charge_reported', amount: read.reportAmount }
        : { state: 'reserved' }
    case 'charge_pending':
      return {
        state: 'charge_confirmed',
        amount: read.reportAmount,
        contestableUntil: read.chargeStart + read.contestWindow,
      }
    case 'paused':
      return { state: 'charge_paused', cause: cause ?? (read.contested ? 'contested' : null) }
    case 'charged':
      return { state: 'charged', amount: read.reportAmount }
    case 'released':
      return { state: 'released' }
    case 'resolved':
      return { state: 'resolved' }
    case 'none':
      return null
  }
}

/** Who stands where around one card's money: whose lock holds it and whom a charge pays. */
interface MoneySides {
  /** Who made the promise, as a sentence names them. */
  owner: string
  /** Whose lock holds the reserve. */
  lock: string
  /** Who reports a charge and is paid by one. */
  payee: string
}

/** The money row in words, for whichever side of the commitment holds it. */
function moneyWords(facts: MoneyFacts, sides: MoneySides, clock: CardClock): string {
  const contester = sides.owner.charAt(0).toUpperCase() + sides.owner.slice(1)
  switch (facts.state) {
    case 'reserved':
      return `Held in ${sides.lock}`
    case 'released':
      return `Back with ${sides.owner}`
    case 'resolved':
      return 'Settled by a ruling'
    case 'charge_reported':
      return `${formatUsd(facts.amount)} charge reported by ${sides.payee}, waiting for Avow's answer`
    case 'charge_confirmed':
      return `${formatUsd(facts.amount)} charge confirmed by Avow. ${contester} can contest it until ${clock(facts.contestableUntil)}, and it's payable then if it hasn't`
    case 'charge_paused':
      return `Held in ${sides.lock}, ${facts.cause ? PAUSED[facts.cause](sides.owner) : 'paused for a ruling'}`
    case 'charged':
      return `${formatUsd(facts.amount)} paid to ${sides.payee}`
  }
}

/** The charge a card's money carries, for a screen that says it in fewer words. */
function chargeOf(facts: MoneyFacts): CommitmentCard['charge'] {
  switch (facts.state) {
    case 'charge_reported':
    case 'charged':
      return { amount: facts.amount, contestableUntil: null }
    case 'charge_confirmed':
      return { amount: facts.amount, contestableUntil: facts.contestableUntil }
    default:
      return null
  }
}

/** Whether the lock shows a charge on a commitment, which only a broken promise brings. */
const chargedOnLock = (read: CardLockRead | null | undefined) =>
  !!read && (read.hasReport || ['charge_pending', 'paused', 'charged'].includes(read.state))

/** A moment as a card says it. The default is UTC, and a screen or a terminal passes its own. */
export type CardClock = (unixSeconds: bigint) => string

const utcClock: CardClock = (seconds) =>
  `${new Date(Number(seconds) * 1000).toISOString().slice(11, 16)} UTC`

/** What a business can charge when the other side breaks a job, for each kind its terms name. */
const JOB_BREACH: Record<ChargeKind, (cap: string) => string> = {
  lateCancellation: (cap) => `cancels after work starts, you charge up to ${cap}`,
  noShow: (cap) => `never hands over the inputs, you charge up to ${cap}`,
}

function jobBreach(charges: readonly JobCharge[]): string {
  const ways = charges.map((c) => JOB_BREACH[c.kind](formatUsd(c.amount)))
  return `If the customer ${ways.join('. If it ')}.`
}

const PAUSED: Record<ChargePauseCause, (owner: string) => string> = {
  contested: (owner) => `paused for a ruling since ${owner} contested the charge`,
  referred: () => 'paused for a ruling since Avow referred the report',
  unanswered: () => "paused for a ruling since Avow didn't answer the report in time",
}

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? '' : 's'}`

/**
 * The cards for one order's commitments, the compute booking first since the job rests on it.
 * A card appears once its commitment was accepted: the compute booking when the supplier accepted
 * it, and the job when the business's own code checked the customer's reserve and accepted.
 */
export function commitmentCards(
  events: readonly SessionEvent[],
  orderId: string,
  clock: CardClock = utcClock,
  onChain: CardChain = {},
): CommitmentCard[] {
  const mine = events.filter((e) => 'orderId' in e && e.orderId === orderId)
  const last = <T extends SessionEvent['type']>(type: T) =>
    mine.findLast((e): e is Extract<SessionEvent, { type: T }> => e.type === type)
  const released = (role: CommitmentCard['role']) =>
    mine.some((e) => e.type === 'job_reserve_released' && e.role === role)
  const row = (label: CardLabel, text: string) => ({ label, text })
  const cards: CommitmentCard[] = []

  const secured = last('job_compute_secured')
  if (secured) {
    // The offer the agent booked, from the listing it saw and the booking call it made.
    const call = mine.findLast(
      (e): e is Extract<ToolCall, { offer: string }> =>
        e.type === 'tool_call' && e.tool === 'book_compute' && e.offer !== null,
    )
    const listing = mine.findLast(
      (e): e is ToolResult & { listing: ComputeOffers } =>
        e.type === 'tool_result' && e.tool === 'compute_offers' && e.listing !== null,
    )
    const offer = call && listing?.listing.offers.find((o) => o.id === call.offer)
    const window =
      offer && call
        ? `${plural(call.quantity, offer.gpu)}, ${clock(offer.startsAt)} to ${clock(offer.startsAt + BigInt(offer.minutes) * 60n)}`
        : null
    const promise =
      offer && call
        ? `Use ${plural(call.quantity, offer.gpu)} from ${clock(offer.startsAt)} to ${clock(offer.startsAt + BigInt(offer.minutes) * 60n)}, at ${formatUsd(offer.pricePerGpuHour)} a GPU-hour paid as used`
        : `Use the compute booked with ${secured.supplier}`
    const read = onChain.compute
    const facts: MoneyFacts = (read && moneyOnLock(read, null)) ?? {
      state: released('compute') ? 'released' : 'reserved',
    }
    const sides = { owner: 'your business', lock: 'your lock', payee: secured.supplier }
    cards.push({
      role: 'compute',
      reference: secured.reference,
      from: 'Your business',
      to: secured.supplier,
      promise: chargedOnLock(read)
        ? 'broken'
        : facts.state === 'released' || facts.state === 'resolved'
          ? 'ended'
          : 'accepted',
      money: facts.state,
      brief: window ?? `Compute with ${secured.supplier}`,
      reserved: secured.amount,
      unbacked: null,
      charge: chargeOf(facts),
      rows: [
        { label: 'Promise', text: promise },
        {
          label: 'If broken',
          text: `If your business cancels late or never shows, ${secured.supplier} charges up to ${formatUsd(secured.amount)}.`,
        },
        {
          label: 'Backed by',
          text: `${formatUsd(secured.amount)} reserved in your lock, for ${secured.supplier}`,
        },
        row('Money now', moneyWords(facts, sides, clock)),
      ],
    })
  }

  const order = last('job_order_received')
  const checked = last('job_commitment_checked')
  if (order && checked) {
    // The customer's own check of the booking is its claim, so the card says the customer says so.
    const verified = last('job_customer_verified')
    const blocksOf = (checks: readonly { block: { number: bigint } }[]) =>
      [...new Set(checks.map((c) => c.block.number))].join(' and ')
    const dependsOn =
      verified && verified.checks.length > 0
        ? `Your compute commitment, which the customer says it checked at block ${blocksOf(verified.checks)}`
        : checked.checks.length > 0
          ? `Your compute commitment, which your code checked at block ${blocksOf(checked.checks)}`
          : null
    // The charge's own steps, the latest of which says where the money stands, unless the lock's
    // own reading is at hand, which goes on after the session ends.
    const reported = last('job_charge_reported')
    const confirmed = last('job_charge_confirmed')
    const paused = last('job_charge_paused')
    const charged = last('job_charge_paid')
    const read = onChain.job
    const fromEvents: MoneyFacts = charged
      ? { state: 'charged', amount: charged.amount }
      : paused
        ? { state: 'charge_paused', cause: paused.cause }
        : confirmed
          ? {
              state: 'charge_confirmed',
              amount: confirmed.amount,
              contestableUntil: confirmed.contestableUntil,
            }
          : reported
            ? { state: 'charge_reported', amount: reported.amount }
            : { state: released('job') ? 'released' : 'reserved' }
    const facts = (read && moneyOnLock(read, paused?.cause ?? null)) ?? fromEvents
    const sides = { owner: 'the customer', lock: "the customer's lock", payee: 'your business' }
    // The reserve pays the charges the terms list. The price rests on the agreement alone.
    const unbacked = `The ${formatUsd(order.price)} itself. If the customer takes delivery and doesn't pay, the reserve pays you nothing.`
    cards.push({
      role: 'job',
      reference: checked.reference,
      from: TEST_CUSTOMER_LABEL,
      to: 'your business',
      promise:
        last('job_customer_cancelled') || chargedOnLock(read)
          ? 'broken'
          : last('job_paid')
            ? 'kept'
            : facts.state === 'released' || facts.state === 'resolved'
              ? 'ended'
              : 'accepted',
      money: facts.state,
      brief: `${formatUsd(order.price)} on delivery`,
      reserved: checked.amount,
      unbacked,
      charge: chargeOf(facts),
      rows: [
        {
          label: 'Promise',
          text: `Pay ${formatUsd(order.price)} on delivery, with nothing prepaid, for ${order.work.kind} due by ${clock(order.deliverBy)}`,
        },
        { label: 'If broken', text: jobBreach(checked.charges) },
        {
          label: 'Backed by',
          text: `${formatUsd(checked.amount)} reserved in the customer's lock, for your business`,
        },
        row('Not backed', unbacked),
        ...(dependsOn ? [row('Depends on', dependsOn)] : []),
        row('Money now', moneyWords(facts, sides, clock)),
      ],
    })
  }
  return cards
}
