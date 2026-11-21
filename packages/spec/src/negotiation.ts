import type { Hex } from 'viem'
import { z } from 'zod'
import {
  type AvowDomain,
  digestOf,
  MOVE_KINDS,
  type MoveKind,
  type NegotiationMove,
  negotiationMoveTypedData,
  type TermsAgreement,
} from './eip712.js'
import { bytes32, hexBytes, side, u64, u256 } from './json-fields.js'
import type { JobBuyer } from './mailbox.js'
import { readOrNull } from './order-wire.js'
import type { ReasonCode } from './reasons.js'
import {
  offerVersionId,
  SERVICE_ACCEPT_WITHIN,
  SERVICE_QUANTITY_MAX,
  type ServiceOfferVersion,
  type ServiceTerms,
  serviceOfferProblem,
  serviceOfferQuote,
  serviceOfferTerms,
  serviceOfferVersionJson,
} from './service.js'
import {
  SERVICE_ORDER_ACCEPT_MARGIN,
  SERVICE_ORDER_CLOCK_SKEW,
  type ServiceSettlement,
  serviceQuoteProblem,
} from './service-order.js'
import type { Side } from './types.js'
import { termsAgreementJson } from './wire.js'

/**
 * A negotiation thread: the signed moves two businesses' agents make about one prospective
 * commitment, from the buyer's first proposal to an agreement or a decline. A fixed-price order is
 * the shortest thread, a proposal the supplier accepts.
 *
 * A thread is about one base offer version, which never changes. A proposal states a quantity, a
 * unit price and a lead time against that base, and the terms are the ones `serviceOfferTerms`
 * builds from the base with those three in place. Everything else in the terms comes from the
 * base, so no move can change the item, what counts as delivery, a charge's share or how the
 * price is paid.
 *
 * Either side accepts the other's open proposal. A supplier's proposal or acceptance carries its
 * signed agreement to the terms, so once a proposal is accepted both sides have signed one terms
 * hash. That is an agreed thread, and it is no commitment yet. Nothing is reserved until the
 * buyer's lock takes the reserve, and the commitment exists only once the supplier's acceptance
 * is on that lock. Until then either side can walk away, and the thread shows who did.
 *
 * This module holds the moves and what makes each one valid where it stands. It reads no lock and
 * checks no signature, so a caller establishes who signed a move before it asks whether the move
 * fits. Nothing here says a move is within either side's authority, which is the mandates' part.
 */

/** The most proposals and counter-offers one thread takes. Accepting and declining don't count. */
export const THREAD_PROPOSALS_MAX = 6

/** The longest one move stands, in seconds. */
export const THREAD_MOVE_SECONDS = 5n * 60n

/** The longest a thread runs from the moment its first proposal is built, in seconds. */
export const THREAD_SECONDS = 30n * 60n

/** The most moves a thread holds: every proposal and counter, an acceptance, and a decline. */
export const THREAD_MOVES_MAX = THREAD_PROPOSALS_MAX + 2

const ZERO: Hex = `0x${'00'.repeat(32)}`
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const other = (s: Side): Side => (s === 'buyer' ? 'supplier' : 'buyer')

/** What the side that reads a decline does next. */
export type DeclineNext = 'retry' | 'retry_later' | 'change_order' | 'choose_another'

/**
 * Every reason a move can decline with, and what the other side does next. An agent acts on the
 * step and never on words from the other side, since a decline carries no free text.
 *
 * - `retry`: send the same order again, from the offer version the decline names.
 * - `retry_later`: send it again at the time the decline gives, or after a while when it gives none.
 * - `change_order`: the order as it stood won't be taken, so propose something else.
 * - `choose_another`: this business won't take the order, so look elsewhere.
 */
export const DECLINE_NEXT = {
  'offer.superseded': 'retry',
  'offer.withdrawn': 'choose_another',
  'capacity.exhausted': 'retry_later',
  'quantity.out_of_range': 'change_order',
  'terms.not_negotiable': 'change_order',
  'proposal.unacceptable': 'change_order',
  'counterparty.not_eligible': 'choose_another',
  'approval.human_required': 'retry_later',
  'negotiation.rounds_exhausted': 'choose_another',
} as const satisfies Partial<Record<ReasonCode, DeclineNext>>

export type DeclineReason = keyof typeof DECLINE_NEXT

export const isDeclineReason = (reason: string): reason is DeclineReason =>
  Object.hasOwn(DECLINE_NEXT, reason)

/** The terms a proposal may set against its base offer. */
export type OpenTerm = 'unitPrice' | 'quantity' | 'leadTime'

/** What a thread about an offer allows: which terms can move, and how many proposals it takes. */
export interface NegotiationRules {
  open: readonly OpenTerm[]
  proposalsMax: number
}

/**
 * The rules a thread about this offer runs under. No offer opens a term to bargaining yet, since
 * an offer version has no field to say so. So today a thread's one proposal carries the offer's
 * own price and lead time, and a counter-offer is refused. A later version of the offer format
 * names its open terms, and this reads them.
 */
export function negotiationRules(_base: ServiceOfferVersion): NegotiationRules {
  return { open: [], proposalsMax: THREAD_PROPOSALS_MAX }
}

/**
 * A supplier's signed agreement to a proposal's terms: the salt the terms hash under, and its
 * signing key's agreement to that hash for the thread's commitment. The terms themselves aren't
 * carried, since anyone holding the thread builds them with `proposalTerms`.
 */
export interface ThreadQuote {
  salt: Hex
  agreement: TermsAgreement
  supplierSignature: Hex
}

/** A move as it travels: signed, with what the move's kind brings along. */
export interface SignedMove {
  move: NegotiationMove
  /** The signature of the key that made the move, the buyer's agent key or the supplier's signing key. */
  signature: Hex
  /** The supplier's agreement to the terms, on a move where it proposes or accepts. Null otherwise. */
  quote: ThreadQuote | null
  /** The offer version that replaced the base, whole, on a decline for a replaced offer. Null otherwise. */
  current: ServiceOfferVersion | null
}

/** A thread: the base offer, whole, and every move in order. */
export interface NegotiationThread {
  base: ServiceOfferVersion
  moves: readonly SignedMove[]
}

/**
 * Where a thread stands from its moves and the clock alone, before any lock is read.
 *
 * - `open`: a proposal waits for the other side, whose turn it is.
 * - `agreed`: both sides signed the proposal's terms, and the buyer has until `until` to reserve.
 * - `closed`: a side declined, the open proposal or the thread's time ran out with no answer, or
 *   an agreement lapsed with nothing reserved.
 *
 * A caller that has seen the reserve on the buyer's lock no longer asks this, since the lock's
 * own deadlines govern from then on.
 */
export type ThreadState =
  | { status: 'open'; head: NegotiationMove; turn: Side; proposals: number }
  | { status: 'agreed'; proposal: NegotiationMove; termsHash: Hex; until: bigint }
  | { status: 'closed'; why: 'declined'; reason: string; by: Side }
  | { status: 'closed'; why: 'expired' | 'lapsed' }

/** The digest a move is signed over, which the move after it names as `previous`. */
export const moveDigest = (move: NegotiationMove, domain: AvowDomain): Hex =>
  digestOf(negotiationMoveTypedData(move, domain))

const proposes = (kind: MoveKind) => kind === 'propose' || kind === 'counter'

/**
 * Where a thread whose moves each passed `moveProblem` stands at `now`. It throws for a thread
 * with no moves, which is no thread.
 */
export function threadStateAt(thread: NegotiationThread, now: bigint): ThreadState {
  const moves = thread.moves.map((signed) => signed.move)
  const first = moves[0]
  const last = moves.at(-1)
  if (!first || !last) throw new RangeError('A thread has at least its first proposal')
  if (last.kind === 'decline') {
    return { status: 'closed', why: 'declined', reason: last.reason, by: last.side }
  }
  const proposals = moves.filter((m) => proposes(m.kind))
  // An acceptance always follows the proposal it accepts, so the newest proposal is the one.
  const head = proposals.at(-1) as NegotiationMove
  if (last.kind === 'accept') {
    if (now >= last.expiry) return { status: 'closed', why: 'lapsed' }
    return { status: 'agreed', proposal: head, termsHash: last.termsHash, until: last.expiry }
  }
  if (now >= head.expiry || now >= first.builtAt + THREAD_SECONDS) {
    return { status: 'closed', why: 'expired' }
  }
  return { status: 'open', head, turn: other(head.side), proposals: proposals.length }
}

/** The offer version a proposal asks for: the base with the proposal's price and lead time. */
export function proposedVersion(
  base: ServiceOfferVersion,
  proposal: Pick<NegotiationMove, 'unitPrice' | 'leadTime'>,
): ServiceOfferVersion {
  return {
    ...base,
    unitPrice: proposal.unitPrice,
    rules: { ...base.rules, leadTime: proposal.leadTime },
  }
}

/**
 * The terms a proposal builds, which both sides sign the hash of. Throws for a proposal the
 * template refuses, which `moveProblem` never lets into a thread.
 */
export function proposalTerms(
  base: ServiceOfferVersion,
  proposal: Pick<NegotiationMove, 'unitPrice' | 'leadTime' | 'quantity' | 'builtAt'>,
  settlement: ServiceSettlement,
): ServiceTerms {
  return serviceOfferTerms(
    proposedVersion(base, proposal),
    proposal.quantity,
    proposal.builtAt,
    settlement,
  )
}

/** The terms a proposal sets differently from the offer, or from the proposal it answers. */
function moved(
  base: ServiceOfferVersion,
  proposal: NegotiationMove,
  answered: NegotiationMove | null,
): OpenTerm[] {
  const terms: OpenTerm[] = []
  if (proposal.unitPrice !== base.unitPrice) terms.push('unitPrice')
  if (proposal.leadTime !== base.rules.leadTime) terms.push('leadTime')
  // The buyer's first proposal sets the quantity, and only a counter can move it.
  if (answered && proposal.quantity !== answered.quantity) terms.push('quantity')
  return terms
}

/** Why a proposing move can't stand, or null. */
function proposalProblem(
  base: ServiceOfferVersion,
  next: NegotiationMove,
  answered: NegotiationMove | null,
  rules: NegotiationRules,
  now: bigint,
): ReasonCode | null {
  if (next.builtAt > now + SERVICE_ORDER_CLOCK_SKEW) return 'message.invalid'
  if (next.expiry <= next.builtAt) return 'message.invalid'
  // A proposal accepted at its last moment still leaves the supplier time to accept on the lock.
  if (next.expiry + SERVICE_ORDER_ACCEPT_MARGIN > next.builtAt + SERVICE_ACCEPT_WITHIN) {
    return 'message.validity_too_long'
  }
  // A supplier's proposal carries its agreement's terms hash, and a buyer's has none to carry.
  if ((next.side === 'supplier') === same(next.termsHash, ZERO)) return 'message.invalid'
  if (
    answered &&
    next.quantity === answered.quantity &&
    next.unitPrice === answered.unitPrice &&
    next.leadTime === answered.leadTime
  ) {
    // A counter that repeats the proposal it answers is an acceptance written as a counter.
    return 'message.invalid'
  }
  if (moved(base, next, answered).some((term) => !rules.open.includes(term))) {
    return 'terms.not_negotiable'
  }
  try {
    serviceOfferQuote(proposedVersion(base, next), next.quantity)
  } catch {
    return 'terms.template_invalid'
  }
  return null
}

/**
 * Why `next` can't be the thread's next move at `now`, or null when it can. `moves` are the
 * thread's moves so far, each of which passed this check, and none for a first proposal.
 *
 * A move takes the next number and names the digest of the move before it, so a thread can't be
 * reordered, and two different moves can't both follow the same one. The buyer opens with a
 * proposal. After that the side a proposal waits on counters or accepts, and either side declines
 * at any point before the thread closes. A move stands for `THREAD_MOVE_SECONDS` at most, and no
 * proposal or acceptance outlasts `THREAD_SECONDS` from the first proposal.
 *
 * The caller checks the signature and that its signer is the side the move names. This checks
 * neither, and it doesn't read a supplier's quote, which `threadQuoteProblem` does.
 */
export function moveProblem(
  thread: { base: ServiceOfferVersion; moves: readonly SignedMove[] },
  next: NegotiationMove,
  domain: AvowDomain,
  now: bigint,
  rules: NegotiationRules = negotiationRules(thread.base),
): ReasonCode | null {
  const { base } = thread
  const moves = thread.moves.map((signed) => signed.move)
  const first = moves[0] ?? null
  const last = moves.at(-1) ?? null

  if (next.expiry <= now) return 'message.expired'
  if (next.expiry > now + THREAD_MOVE_SECONDS + SERVICE_ORDER_CLOCK_SKEW) {
    return 'message.validity_too_long'
  }
  let baseId: Hex
  try {
    baseId = offerVersionId(base)
  } catch {
    return 'terms.template_invalid'
  }
  if (!same(next.baseOffer, baseId)) return 'message.invalid'
  if (same(next.thread, ZERO) || same(next.commitmentId, ZERO)) return 'message.invalid'
  if (next.kind !== 'decline') {
    // Only a decline says why, when to ask again, how many units or which version.
    if (next.reason !== '' || next.retryAt !== 0n || next.available !== 0) return 'message.invalid'
    if (!same(next.currentOffer, ZERO)) return 'message.invalid'
  }

  // The move takes the next place in the chain, after the move this thread ends with.
  if (next.seq !== moves.length) return 'order.out_of_step'
  if (!same(next.previous, last ? moveDigest(last, domain) : ZERO)) return 'order.out_of_step'

  if (!first) {
    if (next.kind !== 'propose' || next.side !== 'buyer') return 'order.out_of_step'
    return proposalProblem(base, next, null, rules, now)
  }
  if (!same(next.thread, first.thread) || !same(next.commitmentId, first.commitmentId)) {
    return 'message.invalid'
  }
  if (next.kind === 'propose') return 'order.out_of_step'

  const state = threadStateAt(thread, now)
  if (state.status === 'closed') {
    return state.why === 'declined' ? 'order.out_of_step' : 'message.expired'
  }

  if (next.kind === 'decline') {
    if (!isDeclineReason(next.reason)) return 'message.invalid'
    if (next.quantity !== 0 || next.unitPrice !== 0n || next.leadTime !== 0n) {
      return 'message.invalid'
    }
    if (next.builtAt !== 0n || !same(next.termsHash, ZERO)) return 'message.invalid'
    if (next.retryAt !== 0n && next.retryAt <= now) return 'message.invalid'
    if (next.available < 0 || next.available > SERVICE_QUANTITY_MAX) return 'message.invalid'
    // Only the supplier's decline for a replaced offer names another version, never the base.
    const names = !same(next.currentOffer, ZERO)
    const replaced = next.side === 'supplier' && next.reason === 'offer.superseded'
    if (names && (!replaced || same(next.currentOffer, baseId))) return 'message.invalid'
    return null
  }

  // A counter or an acceptance answers the open proposal, and only the side it waits on answers.
  if (state.status !== 'open' || next.side !== state.turn) return 'order.out_of_step'
  if (next.expiry > first.builtAt + THREAD_SECONDS) return 'message.validity_too_long'

  if (next.kind === 'counter') {
    if (state.proposals >= rules.proposalsMax) return 'negotiation.rounds_exhausted'
    return proposalProblem(base, next, state.head, rules, now)
  }

  // An acceptance restates the proposal it accepts, so its signature covers what was agreed.
  const { head } = state
  if (
    next.quantity !== head.quantity ||
    next.unitPrice !== head.unitPrice ||
    next.leadTime !== head.leadTime ||
    next.builtAt !== head.builtAt
  ) {
    return 'order.terms_changed'
  }
  // The supplier accepts with its own agreement's hash, and the buyer with the supplier's.
  if (same(next.termsHash, ZERO)) return 'message.invalid'
  if (next.side === 'buyer' && !same(next.termsHash, head.termsHash)) return 'terms.hash_mismatch'
  if (next.expiry + SERVICE_ORDER_ACCEPT_MARGIN > head.builtAt + SERVICE_ACCEPT_WITHIN) {
    return 'message.validity_too_long'
  }
  return null
}

/**
 * Why a supplier's quote doesn't agree to a proposal's terms, or null when it does. The quote's
 * agreement has to carry the hash of the terms the proposal builds, under the quote's salt, for
 * the thread's commitment, the base offer's supplier and a service. That hash is the one the
 * supplier's move states. Given the buyer, the agreement has to name its business and mandate too.
 *
 * It leaves the supplier's signature and the agreement's expiry to the buyer's agent and to Avow,
 * as `serviceQuoteProblem` does, and never throws.
 */
export function threadQuoteProblem(
  thread: Pick<NegotiationThread, 'base'> & {
    buyer?: Pick<JobBuyer, 'businessId' | 'mandateHash'>
  },
  proposal: Pick<
    NegotiationMove,
    'unitPrice' | 'leadTime' | 'quantity' | 'builtAt' | 'commitmentId'
  >,
  stated: Hex,
  quote: ThreadQuote,
  settlement: ServiceSettlement,
): ReasonCode | null {
  let terms: ServiceTerms
  try {
    terms = proposalTerms(thread.base, proposal, settlement)
  } catch {
    return 'terms.template_invalid'
  }
  const problem = serviceQuoteProblem(
    {
      offer: proposedVersion(thread.base, proposal),
      quantity: proposal.quantity,
      builtAt: proposal.builtAt,
      commitmentId: proposal.commitmentId,
      ...(thread.buyer ? { buyer: thread.buyer } : {}),
    },
    { ...quote, terms },
    settlement,
  )
  if (problem) return problem
  return same(quote.agreement.termsHash, stated) ? null : 'terms.hash_mismatch'
}

/**
 * Why a signed move, with what it brings along, can't be the thread's next at `now`, or null when
 * it can. It runs `moveProblem`, then checks what travels beside the move. A supplier's proposal
 * or acceptance brings its quote, which has to agree to the proposal's terms under the hash the
 * move states. A decline that names a replacing offer version brings that version whole, from the
 * same supplier, under the id the move names. Nothing else brings either.
 *
 * The caller still checks the move's signature, and Avow checks the quote's.
 */
export function signedMoveProblem(
  thread: NegotiationThread & { buyer?: Pick<JobBuyer, 'businessId' | 'mandateHash'> },
  next: SignedMove,
  domain: AvowDomain,
  now: bigint,
  settlement: ServiceSettlement,
  rules: NegotiationRules = negotiationRules(thread.base),
): ReasonCode | null {
  const problem = moveProblem(thread, next.move, domain, now, rules)
  if (problem) return problem
  const { move } = next
  const quotes = move.side === 'supplier' && move.kind !== 'decline'
  if (quotes !== (next.quote !== null)) return 'message.invalid'
  if (next.quote) {
    const unagreed = threadQuoteProblem(thread, move, move.termsHash, next.quote, settlement)
    if (unagreed) return unagreed
  }
  const names = !same(move.currentOffer, ZERO)
  if (names !== (next.current !== null)) return 'message.invalid'
  if (next.current) {
    if (next.current.supplier !== thread.base.supplier) return 'message.invalid'
    try {
      if (!same(offerVersionId(next.current), move.currentOffer)) return 'message.invalid'
    } catch {
      return 'terms.template_invalid'
    }
  }
  return null
}

const moveKind = z.enum(Object.keys(MOVE_KINDS) as [MoveKind, ...MoveKind[]])
const units = z.number().int().min(0).max(SERVICE_QUANTITY_MAX)

export const negotiationMoveJson = z.strictObject({
  thread: bytes32,
  commitmentId: bytes32,
  seq: z
    .number()
    .int()
    .min(0)
    .max(THREAD_MOVES_MAX - 1),
  previous: bytes32,
  side,
  kind: moveKind,
  baseOffer: bytes32,
  quantity: units,
  unitPrice: u256,
  leadTime: u64,
  builtAt: u64,
  termsHash: bytes32,
  // A reason is a code, never a sentence, so it's short and holds no spaces.
  reason: z
    .string()
    .regex(/^([a-z0-9_]+(\.[a-z0-9_]+)+)?$/)
    .max(64),
  retryAt: u64,
  available: units,
  currentOffer: bytes32,
  expiry: u64,
})

export const threadQuoteJson = z.strictObject({
  salt: bytes32,
  agreement: termsAgreementJson,
  supplierSignature: hexBytes,
})

export const signedMoveJson = z.strictObject({
  move: negotiationMoveJson,
  signature: hexBytes,
  quote: threadQuoteJson.nullable(),
  current: serviceOfferVersionJson.nullable(),
})

export const negotiationThreadJson = z
  .strictObject({
    base: serviceOfferVersionJson,
    moves: z.array(signedMoveJson).min(1).max(THREAD_MOVES_MAX),
  })
  // An offer the template's rules refuse is refused where the thread is read.
  .refine((thread) => serviceOfferProblem(thread.base as ServiceOfferVersion) === null)

export const parseNegotiationMove = readOrNull(
  negotiationMoveJson as unknown as z.ZodType<NegotiationMove>,
)
export const parseSignedMove = readOrNull(signedMoveJson as unknown as z.ZodType<SignedMove>)
export const parseNegotiationThread = readOrNull(
  negotiationThreadJson as unknown as z.ZodType<NegotiationThread>,
)
