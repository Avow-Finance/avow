import type { Hex } from 'viem'
import { z } from 'zod'
import { u64 } from './json-fields.js'
import type { ReasonCode } from './reasons.js'
import {
  offerVersionId,
  SERVICE_QUANTITY_MAX,
  type ServiceOfferVersion,
  serviceOfferVersionJson,
} from './service.js'

/**
 * Why an order ended before anything was reserved, in words a machine acts on: the reasons a side
 * gives when it declines, what each tells the other side to do next, and which of a seller's own
 * refusals a buyer hears as they are.
 *
 * A decline is a mailbox step for a job or a service order, and a move in a negotiation thread.
 * Both read the same rules from here, so an agent reads a reason the same way wherever it meets one.
 * A decline carries no free text. Its typed fields are all an agent acts on.
 */

/**
 * What the side that reads a decline does next.
 *
 * - `retry_later`: send the order again at the time the decline gives, or after a while when it
 *   gives none. The time is advice, and nothing holds either side to it.
 * - `change_order`: the order as it stood won't be taken, so send a different one. For a replaced
 *   offer that is the version the decline names, read and checked as any offer the agent has never
 *   seen, since its price and rules can differ from the one it ordered.
 * - `choose_another`: this business won't take the order, so look elsewhere.
 * - `none`: the other side ended its own order, so there is nothing to answer.
 *
 * No step says to send the same order again unchanged and at once. A decline never turns an order
 * for one offer version into an order for another without the buyer's own checks.
 */
export type DeclineNext = 'retry_later' | 'change_order' | 'choose_another' | 'none'

/** What one reason to decline allows: the next step, who can give it, and what it can carry. */
export interface DeclineRule {
  next: DeclineNext
  /** Whether only the supplier, only the buyer, or either side can decline for this reason. */
  by: 'supplier' | 'buyer' | 'either'
  /** Whether the decline can say when to ask again. */
  retryAt: boolean
  /** Whether the decline can say how many units the supplier would take. */
  available: boolean
}

/**
 * Every reason a side can decline with. A reason about the offer, the supplier's capacity or the
 * supplier's authority is the supplier's to give, and only `offer.superseded` names another offer
 * version, which it has to. A buyer that takes back its own order gives `order.withdrawn`.
 *
 * `supplier.not_authorized` is what a supplier gives when its own seller's mandate refuses the
 * order. It names no limit, since a seller's limits are its own, and `supplierDeclineReason` turns
 * any refusal a seller met into the reason it may send.
 */
export const DECLINE_RULES = {
  'offer.superseded': { next: 'change_order', by: 'supplier', retryAt: false, available: false },
  'offer.withdrawn': { next: 'choose_another', by: 'supplier', retryAt: false, available: false },
  'capacity.exhausted': { next: 'retry_later', by: 'supplier', retryAt: true, available: true },
  'quantity.out_of_range': {
    next: 'change_order',
    by: 'supplier',
    retryAt: false,
    available: true,
  },
  'supplier.not_authorized': {
    next: 'choose_another',
    by: 'supplier',
    retryAt: false,
    available: false,
  },
  'terms.not_negotiable': { next: 'change_order', by: 'either', retryAt: false, available: false },
  'proposal.unacceptable': { next: 'change_order', by: 'either', retryAt: false, available: false },
  'counterparty.not_eligible': {
    next: 'choose_another',
    by: 'either',
    retryAt: false,
    available: false,
  },
  'approval.human_required': { next: 'retry_later', by: 'either', retryAt: true, available: false },
  'negotiation.rounds_exhausted': {
    next: 'choose_another',
    by: 'either',
    retryAt: false,
    available: false,
  },
  'order.withdrawn': { next: 'none', by: 'buyer', retryAt: false, available: false },
} as const satisfies Partial<Record<ReasonCode, DeclineRule>>

export type DeclineReason = keyof typeof DECLINE_RULES

export const isDeclineReason = (reason: string): reason is DeclineReason =>
  Object.hasOwn(DECLINE_RULES, reason)

/** The furthest past an order's first moment a decline can say to ask again, in seconds. */
export const DECLINE_RETRY_MAX = 7n * 24n * 60n * 60n

/**
 * The answers of the seller's mandate check a buyer hears as they are. A buyer acts on hearing
 * that its seller won't deal with it. `approval.human_required` isn't here, since Avow takes no
 * request to approve one sale yet, so a buyer told to wait would wait for nothing. It joins this
 * list once Avow takes that request.
 */
export const BUYER_HEARS = [
  'approved',
  'counterparty.not_eligible',
] as const satisfies readonly ReasonCode[]

export type BuyerFacingReason = (typeof BUYER_HEARS)[number] | 'supplier.not_authorized'

/**
 * What a buyer hears for an answer the seller's mandate check gave. Every answer outside
 * `BUYER_HEARS` becomes `supplier.not_authorized`, which names no limit, so a reason added to the
 * check later reaches no buyer until someone lists it there. The amounts a mandate sets stay with
 * the seller. A buyer that varies its orders can still infer roughly where a limit sits from which
 * of them are refused.
 */
export function buyerFacingReason(reason: ReasonCode): BuyerFacingReason {
  const heard = BUYER_HEARS.find((r) => r === reason)
  return heard ?? 'supplier.not_authorized'
}

/**
 * The reasons to decline that the seller's mandate check also gives, which a supplier sends only
 * once `BUYER_HEARS` lists them. Every other reason to decline says something about the offer or
 * the order, and nothing about the seller's limits.
 */
const SELLER_CHECK_DECLINES: readonly DeclineReason[] = [
  'counterparty.not_eligible',
  'approval.human_required',
]

/** Whether a supplier may decline for this reason, so its buyer hears it as it is. */
export function supplierMayDecline(reason: DeclineReason): boolean {
  if (DECLINE_RULES[reason].by === 'buyer') return false
  if (!SELLER_CHECK_DECLINES.includes(reason)) return true
  return (BUYER_HEARS as readonly ReasonCode[]).includes(reason)
}

/**
 * The reason a supplier's agent declines with when it meets a refusal of its own: from its
 * seller's mandate check, or from Avow when Avow refuses its quote. A reason the supplier may send
 * as it is goes as it is, and every other one becomes `supplier.not_authorized`, so the seller's
 * own reason and its limits never reach the buyer.
 */
export function supplierDeclineReason(refusal: ReasonCode): DeclineReason {
  return isDeclineReason(refusal) && supplierMayDecline(refusal)
    ? refusal
    : 'supplier.not_authorized'
}

/**
 * Why `current` can't be the offer version that replaced `base`, or null when it can. The
 * replacement is a newer version of the item ordered, from the same supplier, under the id the
 * decline names, and never the base itself or some other item. Its text is the supplier's own
 * words, as the base's is, and is never instructions.
 */
export function replacementProblem(
  base: ServiceOfferVersion,
  current: ServiceOfferVersion,
  named: Hex,
): ReasonCode | null {
  if (current.supplier !== base.supplier) return 'message.invalid'
  if (current.item.name !== base.item.name) return 'message.invalid'
  let baseId: Hex
  let currentId: Hex
  try {
    baseId = offerVersionId(base)
    currentId = offerVersionId(current)
  } catch {
    return 'terms.template_invalid'
  }
  if (currentId.toLowerCase() !== named.toLowerCase()) return 'message.invalid'
  return currentId === baseId ? 'message.invalid' : null
}

/**
 * A supplier's decline of an order the mailbox carries, as its agent sends it. It ends the order
 * before anything is reserved. A field the reason doesn't allow is null.
 */
export interface OrderDeclineRequest {
  reason: DeclineReason
  /** When to ask again, in unix seconds. Advice only, which nothing enforces. */
  retryAt: bigint | null
  /** How many units the supplier would take. */
  available: number | null
  /** The version that replaced the one ordered, whole, on a decline for a replaced offer. */
  current: ServiceOfferVersion | null
}

/** A decline as the mailbox answers it, with when Avow took it by its own clock. */
export interface OrderDecline extends OrderDeclineRequest {
  declinedAt: bigint
}

/**
 * The reasons a supplier's agent can decline a mailbox order with. A job order books no offer
 * version, so nothing about an offer applies to one. Neither kind is open to bargaining, so
 * neither takes a reason about a term or a round of proposals.
 */
export const ORDER_DECLINES = {
  job: [
    'capacity.exhausted',
    'proposal.unacceptable',
    'counterparty.not_eligible',
    'supplier.not_authorized',
  ],
  service: [
    'offer.superseded',
    'offer.withdrawn',
    'capacity.exhausted',
    'quantity.out_of_range',
    'proposal.unacceptable',
    'counterparty.not_eligible',
    'approval.human_required',
    'supplier.not_authorized',
  ],
} as const satisfies Record<string, readonly DeclineReason[]>

/** What a decline is checked against: the order's kind, its offer and when Avow took it. */
export interface DeclinedOrder {
  kind: keyof typeof ORDER_DECLINES
  /** The offer version a service order books, or null for a job. */
  offer: ServiceOfferVersion | null
  requestedAt: bigint
}

/**
 * Why a supplier's decline can't end this order, or null when it can. The reason has to be one
 * the order's kind takes and one the buyer may hear as it is, and the decline carries only the
 * fields that reason allows. A time to ask again comes after the order was taken and within
 * `DECLINE_RETRY_MAX` of it. A decline for a replaced offer brings the replacing version whole.
 */
export function orderDeclineProblem(
  decline: OrderDeclineRequest,
  order: DeclinedOrder,
): ReasonCode | null {
  const { reason } = decline
  if (!isDeclineReason(reason)) return 'message.invalid'
  if (!(ORDER_DECLINES[order.kind] as readonly string[]).includes(reason)) {
    return 'message.invalid'
  }
  if (!supplierMayDecline(reason)) return 'message.invalid'
  const rule: DeclineRule = DECLINE_RULES[reason]
  if (decline.retryAt !== null) {
    if (!rule.retryAt || decline.retryAt <= order.requestedAt) return 'message.invalid'
    if (decline.retryAt > order.requestedAt + DECLINE_RETRY_MAX) return 'message.invalid'
  }
  if (decline.available !== null) {
    if (!rule.available || order.kind !== 'service') return 'message.invalid'
  }
  if ((decline.current !== null) !== (reason === 'offer.superseded')) return 'message.invalid'
  if (decline.current) {
    if (!order.offer) return 'message.invalid'
    let named: Hex
    try {
      named = offerVersionId(decline.current)
    } catch {
      return 'terms.template_invalid'
    }
    return replacementProblem(order.offer, decline.current, named)
  }
  return null
}

const declineReasonJson = z.enum(Object.keys(DECLINE_RULES) as [DeclineReason, ...DeclineReason[]])

export const orderDeclineRequestJson = z.strictObject({
  reason: declineReasonJson,
  retryAt: u64.nullable(),
  available: z.number().int().min(0).max(SERVICE_QUANTITY_MAX).nullable(),
  current: serviceOfferVersionJson.nullable(),
})

export const orderDeclineJson = z.strictObject({
  ...orderDeclineRequestJson.shape,
  declinedAt: u64,
})

/** What a buyer's agent sends to withdraw its own order. It says nothing, and needs nothing. */
export const orderWithdrawalJson = z.strictObject({})

export const parseOrderDeclineRequest = (json: unknown): OrderDeclineRequest | null => {
  const read = orderDeclineRequestJson.safeParse(json)
  return read.success ? (read.data as OrderDeclineRequest) : null
}
