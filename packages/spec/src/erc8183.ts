import type { Address, Hex } from 'viem'
import type { Commitment, CommitmentState, Ending } from './commitment.js'
import { toTokenUnits } from './rail.js'
import { lockTerms } from './terms.js'

/**
 * ERC-8183's job states, as its draft of 25 February 2026 names them. Completed, Rejected and
 * Expired are endings.
 */
export const ERC8183_STATUSES = [
  'Open',
  'Funded',
  'Submitted',
  'Completed',
  'Rejected',
  'Expired',
] as const
export type Erc8183Status = (typeof ERC8183_STATUSES)[number]

/** The moves ERC-8183's state table allows. No job moves out of an ending. */
export const ERC8183_TRANSITIONS: { readonly [S in Erc8183Status]: readonly Erc8183Status[] } = {
  Open: ['Funded', 'Rejected'],
  Funded: ['Submitted', 'Rejected', 'Expired'],
  Submitted: ['Completed', 'Rejected', 'Expired'],
  Completed: [],
  Rejected: [],
  Expired: [],
}

/**
 * Where each state before an ending sits in a job. A commitment is open until money reaches the
 * lock, funded while the supplier is bound to it, and submitted from the supplier's report of a
 * charge until the charge is paid or ruled on.
 */
export const ERC8183_STATUS_OF: {
  readonly [S in Exclude<CommitmentState, Ending>]: Erc8183Status
} = {
  draft: 'Open',
  agreed: 'Open',
  awaiting_approval: 'Open',
  reserved: 'Funded',
  accepted: 'Funded',
  charge_pending: 'Submitted',
  paused: 'Submitted',
}

/**
 * Where a commitment sits in a job, decided by its state. A charge completes the job, and so does
 * a ruling or the day-90 default that paid the supplier anything. ERC-8183 lets a job expire only
 * once `expiredAt` has passed, so a reserve that went back at its release date expires the job.
 * Every other ending gave the whole reserve back, often before the release date, or never held
 * one, as a rejected job does.
 */
export function erc8183Status(c: Commitment): Erc8183Status {
  switch (c.state) {
    case 'charged':
      return 'Completed'
    case 'resolved':
      return c.outcome.charged > 0n ? 'Completed' : 'Rejected'
    case 'released':
      return c.outcome.kind === 'reached_release_date' ? 'Expired' : 'Rejected'
    case 'expired':
      return 'Rejected'
    default:
      return ERC8183_STATUS_OF[c.state]
  }
}

/**
 * A commitment as an ERC-8183 job, for an adapter that shows Avow's commitments to systems that
 * read ERC-8183. Amounts are the token's base units.
 */
export interface Erc8183Job {
  status: Erc8183Status
  /** The business account whose lock holds the reserve. */
  client: Address
  /**
   * The supplier's payee that the reserve's backing names, which a charge pays. Null until the
   * reserve is in a lock.
   */
  provider: Address | null
  /**
   * The lock that the reserve's backing names, which decides every charge. It pays one once the
   * contest window closes, applies Avow's ruling or the arbiter's, and applies the day-90 default.
   * Null until the reserve is in a lock.
   */
  evaluator: Address | null
  /** The reserve, which is the most the supplier can charge. Usage is paid apart from it. */
  budget: bigint
  /**
   * The release date. From then on anyone can return a reserve the supplier accepted with no
   * report, and a reported charge stays held until it ends, so a submitted job can outlast it.
   */
  expiredAt: bigint
  /** The salted terms hash both sides signed, which stands in for the job's description. */
  description: Hex
  /**
   * What the supplier was paid and the business got back, once the commitment has ended. The two
   * add up to the budget, or to zero when nothing reached the lock.
   */
  settled: { paid: bigint; refunded: bigint } | null
}

/**
 * The job view of a commitment, from its record, the business account the record leaves to the
 * chain, and the decimals of the reserve's token. The lock and the payee come from the reserve's
 * backing. The record has to fit its state, as `parseCommitment` checks. Throws when an amount
 * can't be paid exactly in a token with these decimals.
 */
export function toErc8183Job(
  c: Commitment,
  chain: { account: Address; decimals: number },
): Erc8183Job {
  const terms = lockTerms(c.terms, chain.decimals)
  const backing = c.backing.find((b) => b.side === terms.side)?.ref ?? null
  return {
    status: erc8183Status(c),
    client: chain.account,
    provider: backing?.payee ?? null,
    evaluator: backing?.lock ?? null,
    budget: terms.amount,
    expiredAt: terms.releaseDate,
    description: c.termsHash,
    settled:
      c.outcome === null
        ? null
        : {
            paid: toTokenUnits(c.outcome.charged, chain.decimals),
            refunded: toTokenUnits(c.outcome.released, chain.decimals),
          },
  }
}
