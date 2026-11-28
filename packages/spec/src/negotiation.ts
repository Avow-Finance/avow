import type { Hex } from 'viem'
import { z } from 'zod'
import {
  DECLINE_RETRY_MAX,
  DECLINE_RULES,
  type DeclineReason,
  type DeclineRule,
  isDeclineReason,
  replacementProblem,
  supplierMayDecline,
} from './decline.js'
import {
  type AvowDomain,
  digestOf,
  MOVE_KINDS,
  type MoveKind,
  type NegotiationMove,
  negotiationMoveTypedData,
  type TermsAgreement,
} from './eip712.js'
import { address, bytes32, hexBytes, sameHex as same, side, u64, u256 } from './json-fields.js'
import { businessIdJson, readOrNull } from './order-wire.js'
import type { ReasonCode } from './reasons.js'
import {
  agreedVersion,
  type OfferNegotiation,
  type OpenTerm,
  offerVersionId,
  SERVICE_QUANTITY_MAX,
  type ServiceOfferVersion,
  type ServiceTerms,
  serviceOfferQuote,
  serviceOfferTerms,
  serviceOfferVersionJson,
  soundOfferVersion,
} from './service.js'
import {
  leavesTimeToAccept,
  SERVICE_ORDER_CLOCK_SKEW,
  type ServiceSettlement,
  serviceAgreementProblem,
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
 * signed agreement to the terms' hash. The buyer signs that hash only when it accepts a supplier's
 * proposal. When the supplier accepts the buyer's, the buyer has signed the quantity, the price,
 * the lead time and the build moment, and it has signed no hash. Its signature doesn't cover the
 * arbiter or the day-90 share the terms are built with, so the buyer builds the terms itself and
 * compares their hash with the supplier's before it reserves.
 *
 * An accepted proposal is an agreed thread, and it is no commitment yet. Nothing is reserved until
 * the buyer's lock takes the reserve, and the commitment exists only once the supplier's
 * acceptance is on that lock. Until then either side can walk away. A decline shows which side
 * ended the thread. A thread that ran out of time shows only that no move followed, and never
 * whose fault that was.
 *
 * A move signs at `MESSAGE_VERSIONS.NegotiationMove`. Its typed data and canonical form are fixed,
 * and which declines a reader takes is read from `decline.ts`. Nothing carried a move before Avow
 * stored threads, so the decline rules could change without a new version. Once Avow keeps
 * threads, a change that narrows what a reader takes, such as a reason refused that was taken,
 * bumps that version, so a thread signed under the old rules is never read under the new ones.
 *
 * This module holds the moves and what makes each one valid where it stands. It reads no lock and
 * checks no signature, so a caller establishes who signed a move before it asks whether the move
 * fits. Nothing here says a move is within either side's authority, which is the mandates' part.
 */

/** The most proposals and counter-offers one thread takes. Accepting and declining don't count. */
export const THREAD_PROPOSALS_MAX = 6

/**
 * The longest one move stands, in seconds. A reader allows `SERVICE_ORDER_CLOCK_SKEW` on top for a
 * sender whose clock runs ahead, so a move can stand a minute longer by the reader's clock.
 */
export const THREAD_MOVE_SECONDS = 5n * 60n

/** The longest a thread runs from the moment its first proposal is built, in seconds. */
export const THREAD_SECONDS = 30n * 60n

/** The most moves a thread holds: every proposal and counter, an acceptance, and a decline. */
export const THREAD_MOVES_MAX = THREAD_PROPOSALS_MAX + 2

const ZERO: Hex = `0x${'00'.repeat(32)}`
const other = (s: Side): Side => (s === 'buyer' ? 'supplier' : 'buyer')

/**
 * What a thread about an offer allows: which terms can move, the band a moved lead time stays in,
 * and how many proposals it takes.
 */
export interface NegotiationRules {
  open: readonly OpenTerm[]
  /** The band a moved lead time stays in, in seconds, or null when the lead time can't move. */
  leadTime: OfferNegotiation['leadTime']
  /** The most proposals and counters, which never passes `THREAD_PROPOSALS_MAX` whatever it says. */
  proposalsMax: number
}

/**
 * The rules a thread about this offer runs under, read from what the base version opens. A
 * version that opens nothing gives a thread whose one proposal carries the offer's own price and
 * lead time, and no counter-offer. A version that opens terms lets proposals and counter-offers
 * move those terms, the lead time within its band.
 */
export function negotiationRules(base: ServiceOfferVersion): NegotiationRules {
  const n = base.negotiation
  return {
    open: n ? [...n.open] : [],
    leadTime: n?.leadTime ?? null,
    proposalsMax: THREAD_PROPOSALS_MAX,
  }
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
  /**
   * The offer version that replaced the base, whole, on a decline for a replaced offer. Null
   * otherwise. Its text is the supplier's own words, as the base's is, and is never instructions.
   */
  current: ServiceOfferVersion | null
}

/** The buyer a thread is for: its business, and the mandate its agent acts under. */
export interface ThreadBuyer {
  businessId: string
  /** The hash of the buyer agent's mandate, which every agreement in the thread names. */
  mandateHash: Hex
}

/**
 * A thread: the base offer whole, who buys, what the terms settle by, and every move in order.
 *
 * No move signs the settlement. A supplier's agreement covers it through the terms hash, so a
 * thread that states another one fails `threadQuoteProblem` at the supplier's first quote. Whoever
 * reserves still compares it with the settlement Avow's approvals name.
 */
export interface NegotiationThread {
  base: ServiceOfferVersion
  buyer: ThreadBuyer
  settlement: ServiceSettlement
  moves: readonly SignedMove[]
}

/**
 * Where a thread stands from its moves and the clock alone, before any lock is read.
 *
 * - `open`: a proposal waits for the other side, whose turn it is.
 * - `agreed`: a proposal was accepted, and the buyer has until `until` to reserve.
 * - `closed`: a side declined, the open proposal or the thread's time ran out with no answer, or
 *   an agreement lapsed with nothing reserved.
 *
 * A caller that has seen the reserve on the buyer's lock no longer asks this, since the lock's
 * own deadlines govern from then on.
 */
export type ThreadState =
  | { status: 'open'; head: NegotiationMove; turn: Side; proposals: number }
  | { status: 'agreed'; proposal: NegotiationMove; termsHash: Hex; until: bigint }
  | { status: 'closed'; why: 'declined'; reason: DeclineReason; by: Side }
  | { status: 'closed'; why: 'expired' | 'lapsed' }

/** The digest a move is signed over, which the move after it names as `previous`. */
export const moveDigest = (move: NegotiationMove, domain: AvowDomain): Hex =>
  digestOf(negotiationMoveTypedData(move, domain))

const proposes = (kind: MoveKind) => kind === 'propose' || kind === 'counter'

/**
 * Where a thread stands at `now`. It trusts the moves, so a thread from anywhere else goes through
 * `threadProblem` first. It throws for moves that could never have passed that check: none at
 * all, none that proposes, or a decline whose reason isn't one of `DECLINE_RULES`.
 */
export function threadStateAt(thread: Pick<NegotiationThread, 'moves'>, now: bigint): ThreadState {
  const moves = thread.moves.map((signed) => signed.move)
  const first = moves[0]
  const last = moves.at(-1)
  const proposals = moves.filter((m) => proposes(m.kind))
  // An acceptance always follows the proposal it accepts, so the newest proposal is the one.
  const head = proposals.at(-1)
  if (!first || !last || !head) throw new RangeError('A thread opens with a proposal')
  if (last.kind === 'decline') {
    if (!isDeclineReason(last.reason)) {
      throw new RangeError('A decline gives one of the reasons a thread takes')
    }
    return { status: 'closed', why: 'declined', reason: last.reason, by: last.side }
  }
  if (last.kind === 'accept') {
    if (now >= last.expiry) return { status: 'closed', why: 'lapsed' }
    return { status: 'agreed', proposal: head, termsHash: last.termsHash, until: last.expiry }
  }
  if (now >= head.expiry || now >= first.builtAt + THREAD_SECONDS) {
    return { status: 'closed', why: 'expired' }
  }
  return { status: 'open', head, turn: other(head.side), proposals: proposals.length }
}

/**
 * The offer version a proposal asks for: the base with the proposal's price and lead time, as
 * `agreedVersion` fixes it. For a base that opens nothing it is the base itself.
 */
export function proposedVersion(
  base: ServiceOfferVersion,
  proposal: Pick<NegotiationMove, 'unitPrice' | 'leadTime'>,
): ServiceOfferVersion {
  return agreedVersion(base, proposal)
}

/**
 * The terms a proposal builds, which the supplier's agreement signs the hash of. Throws for a
 * proposal the template refuses, which `moveProblem` never lets into a thread.
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

/**
 * The terms a proposal moves: the unit price or the lead time when they differ from the base
 * offer's, and the quantity when it differs from `from`. A thread reads a counter against the
 * proposal it answers, and a seller's mandate reads a move against the buyer's opening proposal.
 * The buyer's opening proposal sets the quantity, so with no `from` the quantity never moves.
 */
export function termsMovedFrom(
  base: ServiceOfferVersion,
  from: Pick<NegotiationMove, 'quantity'> | null,
  proposal: Pick<NegotiationMove, 'unitPrice' | 'leadTime' | 'quantity'>,
): OpenTerm[] {
  const terms: OpenTerm[] = []
  if (proposal.unitPrice !== base.unitPrice) terms.push('unitPrice')
  if (from && proposal.quantity !== from.quantity) terms.push('quantity')
  if (proposal.leadTime !== base.rules.leadTime) terms.push('leadTime')
  return terms
}

/**
 * The most proposals and counters a thread under these rules takes, from 1 to
 * `THREAD_PROPOSALS_MAX`. A limit that isn't a whole number allows the opening proposal only.
 */
function proposalLimit(rules: NegotiationRules): number {
  const { proposalsMax } = rules
  if (!Number.isSafeInteger(proposalsMax)) return 1
  return Math.max(1, Math.min(proposalsMax, THREAD_PROPOSALS_MAX))
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
  if (!leavesTimeToAccept(next.expiry, next.builtAt)) return 'message.validity_too_long'
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
  if (termsMovedFrom(base, answered, next).some((term) => !rules.open.includes(term))) {
    return 'terms.not_negotiable'
  }
  // A proposal never asks more than the offer's own price, so the listing is the most a buyer
  // can be asked to pay for what it lists.
  if (next.unitPrice > base.unitPrice) return 'terms.not_negotiable'
  const band = rules.leadTime
  if (next.leadTime !== base.rules.leadTime) {
    if (!band || next.leadTime < band.min || next.leadTime > band.max) return 'terms.not_negotiable'
  }
  try {
    serviceOfferQuote(proposedVersion(base, next), next.quantity)
  } catch {
    return 'terms.template_invalid'
  }
  return null
}

/**
 * Why a declining move can't stand, or null. It holds no proposal and no times of its own, a
 * reason its side can give, and only the fields that reason allows.
 */
function declineProblem(
  next: NegotiationMove,
  first: NegotiationMove,
  baseId: Hex,
): ReasonCode | null {
  if (!isDeclineReason(next.reason)) return 'message.invalid'
  const rule: DeclineRule = DECLINE_RULES[next.reason]
  if (rule.by !== 'either' && next.side !== rule.by) return 'message.invalid'
  // A supplier declines only with a reason its buyer may hear as it is.
  if (next.side === 'supplier' && !supplierMayDecline(next.reason)) return 'message.invalid'
  if (next.quantity !== 0 || next.unitPrice !== 0n || next.leadTime !== 0n) return 'message.invalid'
  if (next.builtAt !== 0n || !same(next.termsHash, ZERO)) return 'message.invalid'
  // A decline ends the thread, so nothing waits on it and it has no expiry to give.
  if (next.expiry !== 0n) return 'message.invalid'
  if (next.retryAt !== 0n) {
    // The time is measured from the thread's own first moment, so every reader judges it alike.
    if (!rule.retryAt || next.retryAt <= first.builtAt) return 'message.invalid'
    if (next.retryAt > first.builtAt + DECLINE_RETRY_MAX) return 'message.invalid'
  }
  if (next.available !== 0) {
    if (!rule.available) return 'message.invalid'
    if (next.available < 0 || next.available > SERVICE_QUANTITY_MAX) return 'message.invalid'
  }
  // A decline for a replaced offer names the version that replaced it, and no other decline does.
  const names = !same(next.currentOffer, ZERO)
  if (names !== (next.reason === 'offer.superseded')) return 'message.invalid'
  if (names && same(next.currentOffer, baseId)) return 'message.invalid'
  return null
}

/**
 * Why `next` can't be the thread's next move at `now`, or null when it can. `moves` are the
 * thread's moves so far, each of which passed this check, and none for a first proposal.
 *
 * A move takes the next number and names the digest of the move before it, so one copy of a
 * thread holds one chain. This can't stop a key signing two different moves for one number. Avow's
 * copy takes the first, and the two signatures together prove the key signed both. The buyer opens
 * with a proposal. After that the side a proposal waits on counters or accepts, and either side
 * declines at any point before the thread closes. A proposal or an acceptance stands for
 * `THREAD_MOVE_SECONDS` at most, and none outlasts `THREAD_SECONDS` from the first proposal. A
 * buyer's acceptance stands no longer than the supplier's proposal it accepts.
 *
 * The caller checks the signature and that its signer is the side the move names. This checks
 * neither, and it doesn't read a supplier's quote, which `threadQuoteProblem` does.
 */
export function moveProblem(
  thread: Pick<NegotiationThread, 'base' | 'moves'>,
  next: NegotiationMove,
  domain: AvowDomain,
  now: bigint,
  rules: NegotiationRules = negotiationRules(thread.base),
): ReasonCode | null {
  const { base } = thread
  const moves = thread.moves.map((signed) => signed.move)
  const first = moves[0] ?? null
  const last = moves.at(-1) ?? null

  let baseId: Hex
  try {
    baseId = offerVersionId(base)
  } catch {
    return 'terms.template_invalid'
  }
  if (!same(next.baseOffer, baseId)) return 'message.invalid'
  if (same(next.thread, ZERO) || same(next.commitmentId, ZERO)) return 'message.invalid'
  if (next.kind !== 'decline') {
    if (next.expiry <= now) return 'message.expired'
    if (next.expiry > now + THREAD_MOVE_SECONDS + SERVICE_ORDER_CLOCK_SKEW) {
      return 'message.validity_too_long'
    }
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
  if (!same(next.thread, first.thread)) return 'message.invalid'
  if (!same(next.commitmentId, first.commitmentId)) return 'order.commitment_mismatch'
  if (next.kind === 'propose') return 'order.out_of_step'

  let state: ThreadState
  try {
    state = threadStateAt(thread, now)
  } catch {
    // Moves no thread could hold, from a copy nobody replayed with `threadProblem`.
    return 'message.invalid'
  }
  if (state.status === 'closed') {
    return state.why === 'declined' ? 'order.out_of_step' : 'message.expired'
  }

  if (next.kind === 'decline') return declineProblem(next, first, baseId)

  // A counter or an acceptance answers the open proposal, and only the side it waits on answers.
  if (state.status !== 'open' || next.side !== state.turn) return 'order.out_of_step'
  if (next.expiry > first.builtAt + THREAD_SECONDS) return 'message.validity_too_long'

  if (next.kind === 'counter') {
    // Rules can lower the most proposals a thread takes, and never raise it.
    if (state.proposals >= proposalLimit(rules)) {
      return 'negotiation.rounds_exhausted'
    }
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
  if (next.side === 'buyer') {
    if (!same(next.termsHash, head.termsHash)) return 'terms.hash_mismatch'
    // The supplier's agreement is sure to stand only as long as its proposal, so the buyer's
    // acceptance gives no more time to reserve than that.
    if (next.expiry > head.expiry) return 'message.validity_too_long'
  }
  if (!leavesTimeToAccept(next.expiry, head.builtAt)) return 'message.validity_too_long'
  return null
}

/**
 * Why a supplier's quote doesn't agree to a proposal's terms, or null when it does. The quote's
 * agreement has to carry the hash of the terms the proposal builds with the thread's settlement,
 * under the quote's salt, for the thread's commitment, the base offer's supplier, the thread's
 * buyer and a service. That hash is the one the supplier's move states.
 *
 * It leaves the supplier's signature to Avow, as `serviceQuoteProblem` does, and how long the
 * agreement stands to `signedMoveProblem`. It never throws.
 */
export function threadQuoteProblem(
  thread: Pick<NegotiationThread, 'base' | 'buyer' | 'settlement'>,
  proposal: Pick<
    NegotiationMove,
    'unitPrice' | 'leadTime' | 'quantity' | 'builtAt' | 'commitmentId'
  >,
  stated: Hex,
  quote: ThreadQuote,
): ReasonCode | null {
  let terms: ServiceTerms
  try {
    terms = proposalTerms(thread.base, proposal, thread.settlement)
  } catch {
    return 'terms.template_invalid'
  }
  const problem = serviceAgreementProblem(
    { commitmentId: proposal.commitmentId, supplier: thread.base.supplier, buyer: thread.buyer },
    terms,
    quote,
  )
  if (problem) return problem
  return same(quote.agreement.termsHash, stated) ? null : 'terms.hash_mismatch'
}

/**
 * Why a signed move, with what it brings along, can't be the thread's next at `now`, or null when
 * it can. It runs `moveProblem`, then checks what travels beside the move. A supplier's proposal
 * or acceptance brings its quote, which has to agree to the proposal's terms under the hash the
 * move states, and stand at least as long as the move does. A decline for a replaced offer brings
 * the replacing version whole, from the same supplier, for the same item, under the id the move
 * names. Nothing else brings either.
 *
 * The caller still checks the move's signature, and Avow checks the quote's.
 */
export function signedMoveProblem(
  thread: NegotiationThread,
  next: SignedMove,
  domain: AvowDomain,
  now: bigint,
  rules: NegotiationRules = negotiationRules(thread.base),
): ReasonCode | null {
  const problem = moveProblem(thread, next.move, domain, now, rules)
  if (problem) return problem
  const { move } = next
  const quotes = move.side === 'supplier' && move.kind !== 'decline'
  if (quotes !== (next.quote !== null)) return 'message.invalid'
  if (next.quote) {
    const unagreed = threadQuoteProblem(thread, move, move.termsHash, next.quote)
    if (unagreed) return unagreed
    // An agreement that lapses before its move does would leave the buyer agreed to nothing.
    if (next.quote.agreement.expiry < move.expiry) return 'message.invalid'
  }
  const names = !same(move.currentOffer, ZERO)
  if (names !== (next.current !== null)) return 'message.invalid'
  if (next.current) return replacementProblem(thread.base, next.current, move.currentOffer)
  return null
}

const latest = (...times: bigint[]) => times.reduce((a, b) => (a > b ? a : b), 0n)

/**
 * Why a thread from anywhere else isn't one its moves could have made, or null when it is. Run it
 * on every thread read from the wire before `threadStateAt` or anything else trusts the moves.
 *
 * It replays the thread from its first move with `signedMoveProblem`, each move at the earliest
 * moment it could have been sent, given its own times and the moves before it. A thread whose
 * moves were each taken in turn always passes, since a move valid when it was sent is valid at
 * that earlier moment too. No move carries the moment it was sent, so the replay shows only that
 * each move could have arrived in time. When it did arrive is known only to whoever took it in,
 * and the copy that whoever keeps the thread holds decides. It checks no signature.
 */
export function threadProblem(
  thread: NegotiationThread,
  domain: AvowDomain,
  rules: NegotiationRules = negotiationRules(thread.base),
): ReasonCode | null {
  if (thread.moves.length === 0 || thread.moves.length > THREAD_MOVES_MAX) return 'message.invalid'
  let at = 0n
  for (const [index, signed] of thread.moves.entries()) {
    const { move } = signed
    if (move.kind !== 'decline') {
      at = latest(
        at,
        move.expiry - (THREAD_MOVE_SECONDS + SERVICE_ORDER_CLOCK_SKEW),
        proposes(move.kind) ? move.builtAt - SERVICE_ORDER_CLOCK_SKEW : 0n,
      )
    }
    const soFar = { ...thread, moves: thread.moves.slice(0, index) }
    const problem = signedMoveProblem(soFar, signed, domain, at, rules)
    if (problem) return problem
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
    buyer: z.strictObject({ businessId: businessIdJson, mandateHash: bytes32 }),
    settlement: z.strictObject({
      arbiter: address,
      day90SupplierShareBps: z.number().int().min(0).max(10_000),
    }),
    moves: z.array(signedMoveJson).min(1).max(THREAD_MOVES_MAX),
  })
  // An offer the template's rules refuse is refused where the thread is read.
  .refine((thread) => soundOfferVersion(thread.base) !== null)

export const parseNegotiationMove = readOrNull(
  negotiationMoveJson as unknown as z.ZodType<NegotiationMove>,
)
export const parseSignedMove = readOrNull(signedMoveJson as unknown as z.ZodType<SignedMove>)
export const parseNegotiationThread = readOrNull(
  negotiationThreadJson as unknown as z.ZodType<NegotiationThread>,
)
