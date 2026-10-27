import type { Acceptance, Approval, AvowDomain, ComputeTerms, ReasonCode } from '@avow-finance/spec'

/** What a supplier hands the verifier to get an acceptance to sign. */
export interface AcceptanceRequest {
  /** Avow's approval that funded the reserve, as the supplier received it. */
  approval: Approval
  /** The terms this supplier agreed to for the booking, from its own records. */
  terms: ComputeTerms
  /** The lock and chain the acceptance is for. */
  domain: AvowDomain
}

export type PreparedAcceptance =
  | { ok: true; acceptance: Acceptance }
  | { ok: false; reason: ReasonCode }

/**
 * The supported way for a supplier to get an acceptance to sign. An acceptance binds the supplier
 * to everything in Avow's approval, so this is to build one only after it checks every term that
 * binds the supplier against the supplier's own agreed values, and the approval's digest against
 * the one the lock stored, and to refuse when any of them is missing or differs. Those terms are
 * the amount, the token, the deadlines, the contest window, the charges, the day-90 share, the
 * arbiter and the terms hash, with the supplier's own account, signing key and payout. The rest of
 * the approval belongs to the business and Avow, and the supplier needs it only for the digest.
 *
 * The supplier's terms don't carry the day-90 share or the arbiter yet, so every request lacks
 * them, and this refuses every request with `terms.incomplete` and builds nothing. A supplier can't
 * accept a reserve through the verifier until those terms and checks exist.
 */
export function prepareAcceptance(_request: AcceptanceRequest): PreparedAcceptance {
  return { ok: false, reason: 'terms.incomplete' }
}
