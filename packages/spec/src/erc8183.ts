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
 * Where a commitment sits in a job. An ending that paid the supplier anything is completed, a
 * kept commitment released at its release date is expired, as a job anyone refunds after its
 * expiry, and every other ending returned the whole reserve, or never held one, as a rejected job
 * does.
 */
export function erc8183Status(c: Commitment): Erc8183Status {
  if (c.outcome === null) return ERC8183_STATUS_OF[c.state]
  if (c.outcome.charged > 0n) return 'Completed'
  return c.outcome.kind === 'kept' ? 'Expired' : 'Rejected'
}

/**
 * A commitment as an ERC-8183 job, for an adapter that shows Avow's commitments to systems that
 * read ERC-8183. Amounts are the token's base units.
 */
export interface Erc8183Job {
  status: Erc8183Status
  /** The business account whose lock holds the reserve. */
  client: Address
  /** The supplier's payee, which a charge pays. */
  provider: Address
  /**
   * The lock, which decides every charge. It pays one once the contest window closes, applies
   * Avow's ruling or the arbiter's, and applies the day-90 default.
   */
  evaluator: Address
  /** The reserve, which is the most the supplier can charge and never the price of the job. */
  budget: bigint
  /** The release date, after which anyone can return a reserve nothing charged. */
  expiredAt: bigint
  /** The salted terms hash both sides signed, which stands in for the job's description. */
  description: Hex
  /** What the supplier was paid and the business got back, once the commitment has ended. */
  settled: { paid: bigint; refunded: bigint } | null
}

/**
 * The job view of a commitment, from its record and the three addresses the record leaves to the
 * chain: the business account, the lock and the supplier's payee. Throws when an amount can't be
 * paid exactly in a token with these decimals.
 */
export function toErc8183Job(
  c: Commitment,
  chain: { account: Address; lock: Address; payee: Address; decimals: number },
): Erc8183Job {
  const terms = lockTerms(c.terms, chain.decimals)
  return {
    status: erc8183Status(c),
    client: chain.account,
    provider: chain.payee,
    evaluator: chain.lock,
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
