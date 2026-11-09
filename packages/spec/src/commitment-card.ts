import type { ToolCall, ToolResult } from './agent-session.js'
import type { ComputeOffers } from './compute-offers.js'
import type { ChargeKind } from './eip712.js'
import type { JobCharge } from './job-session.js'
import { formatUsd, type SessionEvent } from './sandbox.js'
import { TEST_CUSTOMER_LABEL } from './test-customer.js'

/**
 * A commitment as one card, which the terminal and the screen both draw, so a commitment reads
 * the same in each. A card says who promises whom, what the promise is, what breaking it costs,
 * what money stands behind it and which other commitment it rests on. Every row comes from the
 * events a job recorded, so a card claims nothing the session didn't record.
 */

/** A card's rows, in the order every card keeps them. */
export const CARD_LABELS = ['Promise', 'If broken', 'Backed by', 'Depends on'] as const
export type CardLabel = (typeof CARD_LABELS)[number]

export interface CommitmentCard {
  /** `compute` is the business's booking of compute, and `job` the customer's commitment. */
  role: 'job' | 'compute'
  /** Who made the promise and reserved the money behind it. */
  from: string
  /** Who the money is reserved for. */
  to: string
  /** Accepted by the other side, or ended with its reserve back with whoever made it. */
  state: 'accepted' | 'released'
  rows: { label: CardLabel; text: string }[]
}

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
): CommitmentCard[] {
  const mine = events.filter((e) => 'orderId' in e && e.orderId === orderId)
  const last = <T extends SessionEvent['type']>(type: T) =>
    mine.findLast((e): e is Extract<SessionEvent, { type: T }> => e.type === type)
  const released = (role: CommitmentCard['role']) =>
    mine.some((e) => e.type === 'job_reserve_released' && e.role === role)
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
    const promise =
      offer && call
        ? `Use ${plural(call.quantity, offer.gpu)} from ${clock(offer.startsAt)} to ${clock(offer.startsAt + BigInt(offer.minutes) * 60n)}, at ${formatUsd(offer.pricePerGpuHour)} a GPU-hour paid as used`
        : `Use the compute booked with ${secured.supplier}`
    cards.push({
      role: 'compute',
      from: 'Your business',
      to: secured.supplier,
      state: released('compute') ? 'released' : 'accepted',
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
    cards.push({
      role: 'job',
      from: TEST_CUSTOMER_LABEL,
      to: 'your business',
      state: released('job') ? 'released' : 'accepted',
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
        ...(dependsOn ? [{ label: 'Depends on' as const, text: dependsOn }] : []),
      ],
    })
  }
  return cards
}
