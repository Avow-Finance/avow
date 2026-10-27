import type { Hex } from 'viem'
import type { BackingRef, RailState } from './rail.js'
import type { ComputeTerms, Side } from './types.js'

/**
 * The master spec's 11 commitment states. Draft, agreed, awaiting approval and expired live on
 * Avow's servers, and Tempo sees a commitment from the moment money is reserved. The last four
 * are endings.
 */
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
 * Every move the master spec's state diagram allows. A draft can move to itself on a
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
  // The contest window closes, or the business contests within it.
  charge_pending: ['charged', 'paused'],
  // A ruling 24 hours after it's posted, or the day-90 default.
  paused: ['resolved'],
  expired: [],
  released: [],
  charged: [],
  resolved: [],
}

export function canMove(from: CommitmentState, to: CommitmentState): boolean {
  return TRANSITIONS[from].includes(to)
}

/** How a commitment ended, with the ending each kind belongs to. */
export const OUTCOME_ENDINGS = {
  expired: 'expired',
  kept: 'released',
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

/** Amounts are micros. Charged plus released equals the reserve, or zero when nothing was locked. */
export interface Outcome {
  kind: OutcomeKind
  charged: bigint
  released: bigint
}

/** What stands behind one side. V1 backs the buyer's side only, with cash in the business's lock. */
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

/** Decision 14's evidence for a start. */
export interface StartRecord {
  requestHash: Hex
  /** Avow's timestamp on the start request. */
  requestedAt: bigint
  /** The supplier's signed receipt, null until it arrives. */
  receipt: Hex | null
}

/** Decision 11's contest record. Every contest carries a reason code and a supporting statement. */
export interface ContestRecord {
  reasonCode: string
  statementHash: Hex
  evidenceHashes: readonly Hex[]
  contestedAt: bigint
}

/** One promise between a buyer and a supplier, as the API stores it and the SDK reads it. */
export interface Commitment {
  schemaVersion: string
  commitmentId: Hex
  category: string
  buyer: { businessId: string; agentId: string; mandateId: Hex }
  supplier: { businessId: string; agentId: string | null }
  terms: ComputeTerms
  /** The salted terms hash. The salt stays with Avow and goes to the supplier. */
  termsHash: Hex
  state: CommitmentState
  backing: readonly BackingRecord[]
  start: StartRecord | null
  contest: ContestRecord | null
  outcome: Outcome | null
}
