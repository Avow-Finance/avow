import { isAddressEqual } from 'viem'
import type { TermsProfile } from './profiles.js'
import { type RailToken, toTokenUnits } from './rail.js'
import type { ReasonCode } from './reasons.js'
import { type AnyTerms, type EnforceableTerms, enforceableTerms, validateTerms } from './terms.js'
import type { Mandate, ReserveRequest } from './types.js'

export interface MandateCheckInput {
  mandate: Mandate
  /** The reserve request. A verifier checking a commitment made under version 1 terms passes those. */
  request: Omit<ReserveRequest, 'terms'> & { terms: AnyTerms }
  /** The token the buyer's lock holds reserves in. */
  token: RailToken
  /** Micros already reserved and still open under this mandate, as the lock reports them. */
  openReserves: bigint
  revoked: boolean
  now: bigint
  profile: TermsProfile
}

export type MandateCheck =
  | { result: 'approved'; reason: 'approved' }
  | { result: 'needs_human'; reason: 'approval.human_required' }
  | { result: 'denied'; reason: ReasonCode }

/** Checks a mandate on its own. Returns null when it's well formed. */
export function validateMandate(m: Mandate): ReasonCode | null {
  if (m.suppliers.length === 0 && m.categories.length === 0) return 'mandate.invalid'
  if (m.actions.length === 0) return 'mandate.invalid'
  if (m.capPerCommitment <= 0n || m.capPerCommitment > m.capOpenReserves) return 'mandate.invalid'
  if (m.paymentLimits.length === 0 || m.paymentLimits.some((l) => l.amount <= 0n)) {
    return 'mandate.invalid'
  }
  if (m.approvalRule.kind === 'above' && m.approvalRule.amount < 0n) return 'mandate.invalid'
  return null
}

/**
 * Whether a mandate expires before the window of a commitment with these terms ends, which leaves
 * the agent unable to act on the commitment for its whole life. The mandate check refuses such a
 * reserve with `mandate.ends_before_window`, and Avow refuses a newly signed mandate that would do
 * this to a commitment the agent already holds.
 */
export function mandateEndsBeforeWindow(
  mandate: Pick<Mandate, 'expiry'>,
  enforced: Pick<EnforceableTerms, 'releaseDate'>,
): boolean {
  return mandate.expiry < enforced.releaseDate
}

/**
 * The mandate check Avow runs before it signs an approval. It's pure, so the SDK and a supplier
 * can run the same check on the signed mandate. The caller checks the mandate's signature first.
 */
export function checkMandate(input: MandateCheckInput): MandateCheck {
  const { mandate: m, request: r, token } = input
  const deny = (reason: ReasonCode): MandateCheck => ({ result: 'denied', reason })

  const malformed = validateMandate(m)
  if (malformed) return deny(malformed)
  if (m.expiry <= input.now) return deny('mandate.expired')
  if (input.revoked) return deny('mandate.revoked')
  if (!isAddressEqual(r.agentKey, m.agentKey)) return deny('agent.key_mismatch')
  if (!m.actions.includes('reserve')) return deny('mandate.action_not_permitted')

  const termsProblem = validateTerms(r.terms, input.profile)
  if (termsProblem) return deny(termsProblem)
  const enforced = enforceableTerms(r.terms)
  if (enforced.currency !== m.currency) return deny('mandate.currency_not_allowed')
  if (token.currency !== enforced.currency) return deny('terms.currency_mismatch')

  if (m.suppliers.length > 0 && !m.suppliers.includes(r.supplier)) {
    return deny('mandate.supplier_not_allowed')
  }
  if (m.categories.length > 0 && !m.categories.includes(r.category)) {
    return deny('mandate.category_not_allowed')
  }

  const amount = enforced.reserve
  const limit = m.paymentLimits.find((l) => isAddressEqual(l.token, token.token))
  if (!limit) return deny('mandate.token_not_allowed')
  let units: bigint
  try {
    units = toTokenUnits(amount, token.decimals)
  } catch {
    return deny('mandate.token_not_allowed')
  }
  // The keychain enforces what's left of the limit on-chain. This catches a reserve over the whole
  // limit before anyone signs a transaction that would revert.
  if (units > limit.amount) return deny('mandate.over_payment_limit')
  if (amount > m.capPerCommitment) return deny('mandate.over_commitment_cap')
  if (input.openReserves + amount > m.capOpenReserves) return deny('mandate.over_open_reserves_cap')
  if (mandateEndsBeforeWindow(m, enforced)) return deny('mandate.ends_before_window')

  const rule = m.approvalRule
  if (rule.kind === 'always' || (rule.kind === 'above' && amount > rule.amount)) {
    return { result: 'needs_human', reason: 'approval.human_required' }
  }
  return { result: 'approved', reason: 'approved' }
}
