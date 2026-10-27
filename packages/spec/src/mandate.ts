import { isAddressEqual } from 'viem'
import { type RailToken, toTokenUnits } from './rail.js'
import type { ReasonCode } from './reasons.js'
import { type TermsProfile, validateTerms } from './terms.js'
import type { Mandate, ReserveRequest } from './types.js'

export interface MandateCheckInput {
  mandate: Mandate
  request: ReserveRequest
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
  if (r.terms.currency !== m.currency) return deny('mandate.currency_not_allowed')
  if (token.currency !== r.terms.currency) return deny('terms.currency_mismatch')

  if (m.suppliers.length > 0 && !m.suppliers.includes(r.supplier)) {
    return deny('mandate.supplier_not_allowed')
  }
  if (m.categories.length > 0 && !m.categories.includes(r.category)) {
    return deny('mandate.category_not_allowed')
  }

  const amount = r.terms.reserve
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
  if (m.expiry < r.terms.releaseDate) return deny('mandate.ends_before_window')

  const rule = m.approvalRule
  if (rule.kind === 'always' || (rule.kind === 'above' && amount > rule.amount)) {
    return { result: 'needs_human', reason: 'approval.human_required' }
  }
  return { result: 'approved', reason: 'approved' }
}
