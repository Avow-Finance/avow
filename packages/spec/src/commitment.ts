import type { Hex } from 'viem'
import type { BackingRef, RailState } from './rail.js'
import type { Reference } from './references.js'
import { type AnyTerms, enforceableTerms } from './terms.js'
import type { Side } from './types.js'

/** The 11 commitment states. The last four are endings. */
export const COMMITMENT_STATES = [
  'draft',
  'agreed',
  'awaiting_approval',
  'reserved',
  'accepted',
  'charge_pending',
  'paused',
  'expired',
  'released',
  'charged',
  'resolved',
] as const
export type CommitmentState = (typeof COMMITMENT_STATES)[number]

export const ENDINGS = ['expired', 'released', 'charged', 'resolved'] as const
export type Ending = (typeof ENDINGS)[number]

export function isEnding(state: CommitmentState): state is Ending {
  return (ENDINGS as readonly string[]).includes(state)
}

/**
 * The states that live only on Avow's servers, because no money has reached the lock. Tempo sees a
 * commitment in every other state, from the moment its reserve is locked.
 */
export const OFF_CHAIN_STATES = [
  'draft',
  'agreed',
  'awaiting_approval',
  'expired',
] as const satisfies readonly CommitmentState[]

export function isOffChain(state: CommitmentState): boolean {
  return (OFF_CHAIN_STATES as readonly string[]).includes(state)
}

/**
 * Every move between states. A draft can move to itself on a
 * counter-offer, and an ending moves nowhere.
 */
export const TRANSITIONS: { readonly [S in CommitmentState]: readonly CommitmentState[] } = {
  // Both sides sign the terms, or one side counter-offers.
  draft: ['draft', 'agreed'],
  // Avow's mandate check passes, or the offer lapses.
  agreed: ['awaiting_approval', 'expired'],
  // The administrator approves when the mandate asks and money moves into the lock, or nobody
  // approves in time.
  awaiting_approval: ['reserved', 'expired'],
  // The supplier's key records acceptance, or nobody accepts in time, or the agent is revoked.
  reserved: ['accepted', 'released'],
  // Kept, cancelled in time, supplier failed or past the release date, or a late cancellation or
  // no-show reported by the charge deadline.
  accepted: ['released', 'charge_pending'],
  // The contest window closes, the business contests within it, or the supplier consents to give
  // the reserve back.
  charge_pending: ['charged', 'paused', 'released'],
  // A ruling 24 hours after it's posted, the day-90 default, or the supplier's consent before a
  // ruling is posted.
  paused: ['resolved', 'released'],
  expired: [],
  released: [],
  charged: [],
  resolved: [],
}

export function canMove(from: CommitmentState, to: CommitmentState): boolean {
  return TRANSITIONS[from].includes(to)
}

/**
 * The states the lock takes the supplier's consent to give the reserve back in: an accepted
 * reserve, a pending charge, and a paused charge until a ruling is posted. `TRANSITIONS` moves each
 * of them to `released`.
 */
export const CONSENT_STATES = [
  'accepted',
  'charge_pending',
  'paused',
] as const satisfies readonly CommitmentState[]
export type ConsentState = (typeof CONSENT_STATES)[number]

/** Whether the lock takes the supplier's consent in a commitment's state or a backing's. */
export function takesConsent(state: CommitmentState | RailState): state is ConsentState {
  return (CONSENT_STATES as readonly string[]).includes(state)
}

/**
 * The states a commitment reaches only through the business contesting a pending charge. A record
 * in one of them carries that contest. A release by the supplier's consent carries it when the
 * consent came after the contest, and a record in any other state has none.
 */
export const CONTESTED_STATES = ['paused', 'resolved'] as const satisfies readonly CommitmentState[]
export type ContestedState = (typeof CONTESTED_STATES)[number]

export function isContested(state: CommitmentState): state is ContestedState {
  return (CONTESTED_STATES as readonly string[]).includes(state)
}

/**
 * How a commitment ended, with the ending each kind belongs to. `kept` is the supplier's consent to
 * give the reserve back because the commitment was kept, which the lock takes at any time.
 * `reached_release_date` is a reserve that went back at its release date with no report. A record
 * before version 3 used `kept` for both, so one that ended as `kept` stays version 2.
 */
export const OUTCOME_ENDINGS = {
  expired: 'expired',
  kept: 'released',
  reached_release_date: 'released',
  cancelled_in_time: 'released',
  supplier_failed: 'released',
  not_accepted: 'released',
  agent_revoked: 'released',
  cancelled_late: 'charged',
  no_show: 'charged',
  ruled: 'resolved',
  day_90_default: 'resolved',
} as const satisfies Record<string, Ending>
export type OutcomeKind = keyof typeof OUTCOME_ENDINGS

/** The kinds of outcome the supplier's consent records, one for each reason a consent gives. */
export const CONSENT_OUTCOMES = [
  'kept',
  'supplier_failed',
] as const satisfies readonly OutcomeKindIn<'released'>[]
export type ConsentOutcome = (typeof CONSENT_OUTCOMES)[number]

export function isConsentOutcome(kind: OutcomeKind): kind is ConsentOutcome {
  return (CONSENT_OUTCOMES as readonly string[]).includes(kind)
}

/** The kinds of outcome that end a commitment in `E`. */
export type OutcomeKindIn<E extends Ending> = {
  [K in OutcomeKind]: (typeof OUTCOME_ENDINGS)[K] extends E ? K : never
}[OutcomeKind]

/**
 * How a commitment ended, as one of the kinds `K`, or as any kind when `K` is left out. Amounts
 * are micros. Charged plus released equals the reserve, or zero when nothing was locked, and
 * `commitmentFitsState` checks that against the ending.
 */
export interface Outcome<K extends OutcomeKind = OutcomeKind> {
  kind: K
  charged: bigint
  released: bigint
}

/** What stands behind one side. This release backs the buyer's side only, with cash in the business's lock. */
export interface BackingRecord {
  side: Side
  type: 'cash'
  provider: string
  /**
   * `reserve` settles automatically up to the amount, `agreement` is a legal obligation between
   * the two businesses beyond the reserve, and `partner` is a licensed third party, later.
   */
  enforcement: 'reserve' | 'agreement' | 'partner'
  ref: BackingRef
  status: RailState
}

/** The evidence that a job started: Avow's timestamp and the supplier's signed receipt. */
export interface StartRecord {
  requestHash: Hex
  /** Avow's timestamp on the start request. */
  requestedAt: bigint
  /** The supplier's signed receipt, null until it arrives. */
  receipt: Hex | null
}

/** A contest. Every contest carries a reason code and a supporting statement. */
export interface ContestRecord {
  reasonCode: string
  statementHash: Hex
  evidenceHashes: readonly Hex[]
  contestedAt: bigint
}

/** The fields a commitment record holds in every state. */
export interface CommitmentFields {
  /**
   * The record's own version, `COMMITMENT_RECORD_VERSION`, or 2 for a record that ended as `kept`
   * before version 3. Its terms carry theirs.
   */
  schemaVersion: string
  commitmentId: Hex
  category: string
  buyer: { businessId: string; agentId: string; mandateId: Hex }
  supplier: { businessId: string; agentId: string | null }
  /** Version 2 terms, or version 1 for a commitment made under them. */
  terms: AnyTerms
  /** The salted terms hash. The salt stays with Avow and goes to the supplier. */
  termsHash: Hex
  backing: readonly BackingRecord[]
  start: StartRecord | null
  /** Other commitments and payments this record cites. A version 1 record cites none. */
  references: readonly Reference[]
}

/** A commitment record in the state `S`, holding the contest and outcome that state calls for. */
export type CommitmentIn<S extends CommitmentState> = CommitmentFields & {
  state: S
} & ContestAndOutcome<S>

/**
 * The contest and outcome a record in `S` holds. The business's contest is in every state reached
 * through one and null in every other, except that a release by the supplier's consent may carry
 * it, since the lock takes that consent after a contest. The outcome is how the commitment ended,
 * of a kind that belongs to its ending, and null before one.
 */
type ContestAndOutcome<S extends CommitmentState> = S extends 'released'
  ?
      | { contest: null; outcome: Outcome<OutcomeKindIn<S>> }
      | { contest: ContestRecord; outcome: Outcome<ConsentOutcome> }
  : {
      contest: S extends ContestedState ? ContestRecord : null
      outcome: S extends Ending ? Outcome<OutcomeKindIn<S>> : null
    }

/**
 * One promise between a buyer and a supplier, as the API stores it and the SDK reads it. Its state
 * decides what else it holds, so a draft with an outcome or a paused commitment without a contest
 * can't be written as one.
 */
export type Commitment = { [S in CommitmentState]: CommitmentIn<S> }[CommitmentState]

/**
 * A commitment record whose contest and outcome nobody has checked against its state yet, as a
 * reader holds one before `commitmentFitsState` passes it.
 */
export type UncheckedCommitment = CommitmentFields & {
  state: CommitmentState
  contest: ContestRecord | null
  outcome: Outcome | null
}

/**
 * Whether a record holds the contest and outcome its state calls for. An outcome belongs to the
 * endings and to no other state, with a kind that belongs to the record's own ending and amounts
 * that fit it. A contest belongs to the contested states, and to a release by the supplier's
 * consent that came after one, and to no other.
 */
export function commitmentFitsState(record: UncheckedCommitment): record is Commitment {
  const { state, contest, outcome } = record
  if (!isEnding(state)) return outcome === null && (contest !== null) === isContested(state)
  if (outcome === null || OUTCOME_ENDINGS[outcome.kind] !== state) return false
  const contestFits = isContested(state)
    ? contest !== null
    : contest === null || isConsentOutcome(outcome.kind)
  return contestFits && amountsFit(state, outcome, enforceableTerms(record.terms).reserve)
}

/**
 * Whether an outcome's amounts fit its ending. An expired commitment never locked anything, a
 * release gives the whole reserve back, a charge pays the supplier part or all of it, and every
 * ending after the reserve was locked accounts for all of it.
 */
function amountsFit(ending: Ending, o: Outcome, reserve: bigint): boolean {
  switch (ending) {
    case 'expired':
      return o.charged === 0n && o.released === 0n
    case 'released':
      return o.charged === 0n && o.released === reserve
    case 'charged':
      return o.charged > 0n && o.charged + o.released === reserve
    case 'resolved':
      return o.charged + o.released === reserve
  }
}
