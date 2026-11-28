import type { Address } from 'viem'
import type { NegotiationMove } from './eip712.js'
import { checkMandate, type MandateCheck } from './mandate.js'
import { type NegotiationThread, proposalTerms, termsMovedFrom } from './negotiation.js'
import type { TermsProfile } from './profiles.js'
import type { RailToken } from './rail.js'
import { checkSellerMandate, type SellerMandateCheckInput } from './seller-mandate-check.js'
import {
  agreedVersion,
  SERVICE_CATEGORY,
  type ServiceOfferVersion,
  type ServiceTerms,
} from './service.js'

/**
 * Each side's authority over a move in a negotiation thread. A side's agent signs a proposal, a
 * counter-offer or an acceptance only when the terms it builds pass what that side's person
 * signed: the buyer's mandate for the buyer, and the seller's mandate for the supplier. Avow runs
 * the same check on each move it keeps and again when it approves the reserve, so a move that
 * passed its own side's agent can still be refused where the mandate Avow holds says otherwise.
 *
 * Each check reads only its own side's limits, and its reason goes back only to that side. A
 * supplier's counter-offer above the buyer's price limit is a move the supplier may make, and the
 * buyer then declines or counters it. Nothing about a seller's lowest price reaches the buyer
 * except as the seller's counter-offers and declines, and a decline goes through
 * `supplierDeclineReason`.
 */

/** The parts of a proposal its terms are built from, and the commitment they're for. */
export type ProposalFields = Pick<
  NegotiationMove,
  'unitPrice' | 'leadTime' | 'quantity' | 'builtAt' | 'commitmentId'
>

/** What the buyer's check of a move reads, beside the thread and the proposal. */
export interface BuyerMoveInput {
  thread: Pick<NegotiationThread, 'base' | 'settlement'>
  /** The buyer's own proposal or counter-offer, or the supplier's proposal the buyer accepts. */
  proposal: ProposalFields
  mandate: Parameters<typeof checkMandate>[0]['mandate']
  agentKey: Address
  /** The supplier's payout address on the rail, as the reserve request will name it. */
  payee: Address
  token: RailToken
  /** Micros already reserved and still open under the mandate, as the lock reports them. */
  openReserves: bigint
  revoked: boolean
  now: bigint
  profile: TermsProfile
}

const denied = (reason: 'terms.template_invalid'): MandateCheck => ({ result: 'denied', reason })

function termsOf(
  thread: Pick<NegotiationThread, 'base' | 'settlement'>,
  proposal: ProposalFields,
): ServiceTerms | null {
  try {
    return proposalTerms(thread.base, proposal, thread.settlement)
  } catch {
    return null
  }
}

/**
 * Whether the buyer's mandate lets its agent stand behind a proposal's terms: its own proposal or
 * counter-offer before it signs, and the supplier's proposal before it accepts. The terms are the
 * ones the thread would agree on, built by `proposalTerms`, checked by `checkMandate` as the
 * reserve request they become, so a limit on one commitment's price holds at every move as it
 * does at the reserve. It never throws.
 */
export function buyerMoveCheck(input: BuyerMoveInput): MandateCheck {
  const terms = termsOf(input.thread, input.proposal)
  if (!terms) return denied('terms.template_invalid')
  try {
    return checkMandate({
      mandate: input.mandate,
      request: {
        commitmentId: input.proposal.commitmentId,
        agentKey: input.agentKey,
        supplier: input.thread.base.supplier,
        payee: input.payee,
        category: SERVICE_CATEGORY,
        terms,
      },
      token: input.token,
      openReserves: input.openReserves,
      revoked: input.revoked,
      now: input.now,
      profile: input.profile,
    })
  } catch {
    return { result: 'denied', reason: 'message.invalid' }
  }
}

/** What the seller's check of a move reads, beside the thread and the proposal. */
export type SellerMoveInput = Omit<SellerMandateCheckInput, 'terms' | 'offer'> & {
  /** The thread so far, whose opening proposal states the quantity the buyer asked for. */
  thread: Pick<NegotiationThread, 'base' | 'settlement' | 'moves'>
  /** The supplier's own counter-offer, or the buyer's proposal the supplier accepts. */
  proposal: ProposalFields
}

/**
 * Whether the seller's mandate lets its agent stand behind a proposal's terms: its own
 * counter-offer before it signs, and the buyer's proposal before it accepts. The sale is read by
 * `checkSellerMandate` against the version `agreedVersion` builds from the base, so the price
 * floor, the order's value, the units, the delivery horizon, the ledger and the approval rule
 * hold at every move as they do at a fixed-price sale. A sale that passes them is then refused as
 * `seller_mandate.term_not_negotiable` when it moves a term the mandate doesn't let the agent move.
 *
 * The reason is the seller's own. When the supplier declines, its buyer hears only what
 * `supplierDeclineReason` lets through. It never throws.
 */
export function sellerMoveCheck(input: SellerMoveInput): MandateCheck {
  const { thread, proposal, ...rest } = input
  const terms = termsOf(thread, proposal)
  if (!terms) return denied('terms.template_invalid')
  let offer: ServiceOfferVersion
  try {
    offer = agreedVersion(thread.base, proposal)
  } catch {
    return denied('terms.template_invalid')
  }
  const sale = checkSellerMandate({ ...rest, terms, offer })
  if (sale.result === 'denied') return sale
  try {
    const asked = thread.moves[0]?.move ?? null
    // The buyer's opening proposal states what it asked for, so the quantity moves from that.
    const moved = termsMovedFrom(thread.base, asked, proposal)
    if (moved.some((term) => !input.mandate.negotiable.includes(term))) {
      return { result: 'denied', reason: 'seller_mandate.term_not_negotiable' }
    }
  } catch {
    return { result: 'denied', reason: 'message.invalid' }
  }
  return sale
}
