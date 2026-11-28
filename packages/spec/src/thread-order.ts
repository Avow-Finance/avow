import { type Hex, zeroHash } from 'viem'
import { z } from 'zod'
import type { DeclineReason } from './decline.js'
import type { AvowDomain, NegotiationMove } from './eip712.js'
import { bytes32, sameHex, u64 } from './json-fields.js'
import { type JobBuyer, jobBuyerJson, MAILBOX_INBOX_MAX } from './mailbox.js'
import {
  moveDigest,
  type NegotiationThread,
  negotiationThreadJson,
  proposalTerms,
  type SignedMove,
  signedMoveJson,
  threadStateAt,
} from './negotiation.js'
import { type MailboxReserve, mailboxReserveJson, readOrNull } from './order-wire.js'
import { offerVersionId, type ServiceOfferVersion, serviceOfferVersionJson } from './service.js'
import type { ServiceQuote } from './service-order.js'
import { orderIdJson } from './test-customer.js'

/**
 * A service order carried as a negotiation thread through Avow's sandbox mailbox. The buyer's
 * agent opens it with a signed proposal against a supplier's offer, and every later move, an
 * acceptance or a decline, is signed by the side that makes it. Avow keeps the moves in order,
 * replays them with `threadProblem` before it keeps one, and reads the lock as it does for any
 * order. A fixed-price order is the shortest thread, a proposal the supplier accepts.
 *
 * 1. The buyer's agent sends the base offer whole and its proposal. Nothing is reserved.
 * 2. The supplier's agent reads the thread from its inbox, checks the offer is one it published,
 *    and accepts with its signed agreement to the terms' hash, or declines with a reason.
 * 3. The buyer's agent builds the terms itself, compares their hash with the supplier's, funds
 *    the commitment under its mandate, and tells the mailbox, which reads the reserve on chain.
 * 4. The supplier's agent accepts on chain and tells the mailbox, which reads the acceptance.
 *
 * Either side can decline until the buyer funds, and a buyer that takes back its own proposal
 * declines with `order.withdrawn`. A thread has paths of its own, so a reader that knows only job
 * and service orders never meets one.
 */

/** What a buyer's agent sends to open a thread: its order id, the base offer and its proposal. */
export interface ThreadOrderRequest {
  orderId: string
  /** The offer version the thread is about, whole, which names the supplier it's for. */
  base: ServiceOfferVersion
  /** The buyer's signed proposal, the thread's first move. */
  proposal: SignedMove
}

/**
 * Where a thread order stands. `open`, `agreed` and `closed` are the thread's own states as
 * `threadStateAt` reads them by Avow's clock, before anything is on the lock. From `reserved` on,
 * the lock's deadlines govern.
 */
export type ThreadStage =
  | { status: 'open' }
  | { status: 'agreed' }
  | { status: 'closed' }
  | { status: 'reserved'; reserve: MailboxReserve }
  | {
      status: 'accepted'
      reserve: MailboxReserve
      /** The acceptance's transaction when the supplier's agent saw it land, or null. */
      acceptedIn: Hex | null
    }

/** A thread order as the mailbox answers it, to either side. */
export type ThreadOrder = {
  orderId: string
  /** The thread whole, with every move, which a reader replays with `threadProblem`. */
  thread: NegotiationThread
  buyer: JobBuyer
  requestedAt: bigint
} & ThreadStage

/**
 * Why a thread can't be opened with this request, or null when it can, before Avow knows the
 * buyer. The proposal has to be about the base it travels with. The rest of what makes the
 * proposal valid is `threadProblem`'s, once the buyer and the settlement are added.
 */
export function threadOrderProblem(request: ThreadOrderRequest): 'message.invalid' | null {
  const { move } = request.proposal
  if (move.seq !== 0 || move.kind !== 'propose' || move.side !== 'buyer') return 'message.invalid'
  try {
    return offerVersionId(request.base).toLowerCase() === move.baseOffer.toLowerCase()
      ? null
      : 'message.invalid'
  } catch {
    return 'message.invalid'
  }
}

/**
 * The supplier's quote an agreed thread carries, as a service quote: the terms the accepted
 * proposal builds, with the supplier's salt, agreement and signature. Null for a thread that isn't
 * agreed at `now`. The buyer still compares the terms' hash with the agreement's before it funds,
 * which `threadProblem` has done for a thread it replayed.
 */
export function agreedQuote(thread: NegotiationThread, now: bigint): ServiceQuote | null {
  const state = threadStateAt(thread, now)
  if (state.status !== 'agreed') return null
  const quote = thread.moves.find(
    (signed) => signed.quote && sameHex(signed.quote.agreement.termsHash, state.termsHash),
  )?.quote
  if (!quote) return null
  return {
    terms: proposalTerms(thread.base, state.proposal, thread.settlement),
    salt: quote.salt,
    agreement: quote.agreement,
    supplierSignature: quote.supplierSignature,
  }
}

const quiet = { termsHash: zeroHash, reason: '', retryAt: 0n, available: 0, currentOffer: zeroHash }

/**
 * The buyer's opening proposal for units of an offer at its own price and lead time, as a
 * fixed-price order is. The caller signs it with the buyer's agent key under `domain`.
 */
export function openingProposal(p: {
  thread: Hex
  commitmentId: Hex
  base: ServiceOfferVersion
  quantity: number
  builtAt: bigint
  expiry: bigint
}): NegotiationMove {
  return {
    ...quiet,
    thread: p.thread,
    commitmentId: p.commitmentId,
    seq: 0,
    previous: zeroHash,
    side: 'buyer',
    kind: 'propose',
    baseOffer: offerVersionId(p.base),
    quantity: p.quantity,
    unitPrice: p.base.unitPrice,
    leadTime: p.base.rules.leadTime,
    builtAt: p.builtAt,
    expiry: p.expiry,
  }
}

/** The fields every later move takes from the thread: its ids, its base and its place. */
function following(thread: Pick<NegotiationThread, 'moves'>, domain: AvowDomain) {
  const first = thread.moves[0]?.move
  const last = thread.moves.at(-1)?.move
  if (!first || !last) throw new RangeError('A thread opens with a proposal')
  return {
    thread: first.thread,
    commitmentId: first.commitmentId,
    baseOffer: first.baseOffer,
    seq: thread.moves.length,
    previous: moveDigest(last, domain),
  }
}

/**
 * An acceptance of the thread's newest proposal by `side`, restating it, with the hash of its terms
 * and how long it stands. The supplier's travels with its quote, whose agreement signs that hash.
 */
export function acceptanceOf(
  thread: Pick<NegotiationThread, 'moves'>,
  domain: AvowDomain,
  p: { side: NegotiationMove['side']; termsHash: Hex; expiry: bigint },
): NegotiationMove {
  const head = thread.moves.findLast((signed) => signed.move.kind !== 'decline')?.move
  if (!head) throw new RangeError('A thread opens with a proposal')
  return {
    ...quiet,
    ...following(thread, domain),
    side: p.side,
    kind: 'accept',
    quantity: head.quantity,
    unitPrice: head.unitPrice,
    leadTime: head.leadTime,
    builtAt: head.builtAt,
    termsHash: p.termsHash,
    expiry: p.expiry,
  }
}

/**
 * A decline by `side` with a reason and only what that reason carries. A buyer withdraws its own
 * order with `order.withdrawn`.
 */
export function declineOf(
  thread: Pick<NegotiationThread, 'moves'>,
  domain: AvowDomain,
  p: {
    side: NegotiationMove['side']
    reason: DeclineReason
    retryAt?: bigint
    available?: number
    currentOffer?: Hex
  },
): NegotiationMove {
  return {
    ...quiet,
    ...following(thread, domain),
    side: p.side,
    kind: 'decline',
    quantity: 0,
    unitPrice: 0n,
    leadTime: 0n,
    builtAt: 0n,
    reason: p.reason,
    retryAt: p.retryAt ?? 0n,
    available: p.available ?? 0,
    currentOffer: p.currentOffer ?? zeroHash,
    expiry: 0n,
  }
}

export const threadOrderRequestJson = z.strictObject({
  orderId: orderIdJson,
  base: serviceOfferVersionJson,
  proposal: signedMoveJson,
})

const held = {
  orderId: orderIdJson,
  thread: negotiationThreadJson,
  buyer: jobBuyerJson,
  requestedAt: u64,
}

export const threadOrderJson = z.discriminatedUnion('status', [
  z.strictObject({ ...held, status: z.literal('open') }),
  z.strictObject({ ...held, status: z.literal('agreed') }),
  z.strictObject({ ...held, status: z.literal('closed') }),
  z.strictObject({ ...held, status: z.literal('reserved'), reserve: mailboxReserveJson }),
  z.strictObject({
    ...held,
    status: z.literal('accepted'),
    reserve: mailboxReserveJson,
    acceptedIn: bytes32.nullable(),
  }),
])

export const parseThreadOrderRequest = readOrNull(
  threadOrderRequestJson as unknown as z.ZodType<ThreadOrderRequest>,
)
export const parseThreadOrder = readOrNull(threadOrderJson as unknown as z.ZodType<ThreadOrder>)
export const parseThreadInbox = readOrNull(
  z.strictObject({
    orders: z.array(threadOrderJson).max(MAILBOX_INBOX_MAX),
  }) as unknown as z.ZodType<{ orders: ThreadOrder[] }>,
)
