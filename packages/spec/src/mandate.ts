import { isAddressEqual } from 'viem'
import { type CheckedChainedTerms, isChainedTerms } from './dependencies.js'
import { termsPrice } from './price.js'
import type { TermsProfile } from './profiles.js'
import { type RailToken, toTokenUnits } from './rail.js'
import type { ReasonCode } from './reasons.js'
import {
  type AnyTerms,
  type EnforceableTerms,
  enforceableTerms,
  plainTermsOf,
  templateCategoryProblem,
  validateChainedTerms,
  validateTerms,
} from './terms.js'
import type { ApprovalRule, ChainedTerms, Mandate, ReserveRequest } from './types.js'

/**
 * The layers that hold an agent to its mandate's price limit, in the order they check it. The lock
 * never reads a price, so wherever a price limit shows, it's labelled with these two and no more.
 */
export const PRICE_LIMIT_ENFORCED_BY = ['sdk', 'avow'] as const

/** The longest window a limit over a period may count back, a year of 366 days, in seconds. */
export const MAX_PRICE_PERIOD = 366n * 86_400n

/**
 * What the agent's key committed within its mandate's rolling window before this commitment, as
 * the sum of each commitment's price, or that the caller doesn't count it. Avow counts every
 * commitment it approved for the key, under every mandate the key held, by when it approved each,
 * whatever became of it after. The SDK counts the commitments it made. A supplier's verifier holds
 * no such count, and checks the rest of the mandate with `not_counted`, which leaves the limit to
 * the SDK and Avow.
 */
export type CommittedInPeriod = bigint | 'not_counted'

export interface MandateCheckInput {
  mandate: Mandate
  /**
   * The reserve request. A verifier checking a commitment made under version 1 terms passes those.
   * Version 3 terms come only as `CheckedChainedTerms`, which short of a deliberate cast only
   * `verifyDependencies` produces, and are checked as the plain booking they make, with their
   * dependencies section checked for form.
   */
  request: Omit<ReserveRequest, 'terms'> & { terms: AnyTerms | CheckedChainedTerms }
  /** The token the buyer's lock holds reserves in. */
  token: RailToken
  /** Micros already reserved and still open under this mandate, as the lock reports them. */
  openReserves: bigint
  /**
   * The prices the agent's key committed within the mandate's period, counted back from `now`,
   * when the mandate has a limit over a period. Read only then.
   */
  committedInPeriod: CommittedInPeriod
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
  if (m.priceCapPerCommitment !== undefined && m.priceCapPerCommitment <= 0n) {
    return 'mandate.invalid'
  }
  const period = m.pricePeriodLimit
  if (period !== undefined) {
    if (period.amount <= 0n || period.period <= 0n || period.period > MAX_PRICE_PERIOD) {
      return 'mandate.invalid'
    }
    if (m.priceCapPerCommitment !== undefined && m.priceCapPerCommitment > period.amount) {
      return 'mandate.invalid'
    }
  }
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
 * Whether terms are priced over the mandate's price limit for one commitment, or null when the
 * mandate has none or they fit it. It reads no lock, so version 3 terms come as they are, before
 * anyone checked the bookings they rely on, and the SDK refuses them with it before it signs
 * anything. `checkMandate` makes the same comparison.
 */
export function priceLimitProblem(
  m: Pick<Mandate, 'priceCapPerCommitment'>,
  terms: AnyTerms | ChainedTerms,
): 'mandate.over_price_limit' | null {
  if (m.priceCapPerCommitment === undefined) return null
  return termsPrice(terms) > m.priceCapPerCommitment ? 'mandate.over_price_limit' : null
}

/**
 * Whether a commitment priced as these terms are would take what the agent's key committed within
 * the mandate's rolling window past its limit over a period, or null when it wouldn't, when the
 * mandate has no such limit, or when the caller doesn't count the window. `checkMandate` makes the
 * same comparison.
 */
export function periodLimitProblem(
  m: Pick<Mandate, 'pricePeriodLimit'>,
  terms: AnyTerms | ChainedTerms,
  committed: CommittedInPeriod,
): 'mandate.over_price_period_limit' | null {
  if (m.pricePeriodLimit === undefined || committed === 'not_counted') return null
  return committed + termsPrice(terms) > m.pricePeriodLimit.amount
    ? 'mandate.over_price_period_limit'
    : null
}

/**
 * The mandate check Avow runs before it signs an approval. It's pure, so the SDK and a supplier
 * can run the same check on the signed mandate. A mandate's price limit is held here and nowhere
 * on the chain, so the SDK's run and Avow's are the two layers that enforce it. The caller checks
 * the mandate's signature first.
 * It reads version 3 terms as the plain booking they make, and it can't read a lock, so it takes
 * them only as the checked terms the dependency check produces. The types hold a caller to that,
 * short of a deliberate cast, and nothing checks it at run time.
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

  const termsProblem = isChainedTerms(r.terms)
    ? validateChainedTerms(r.terms, input.profile)
    : validateTerms(r.terms, input.profile)
  if (termsProblem) return deny(termsProblem)
  // Version 1 terms have no template, so no category of their own.
  const category = 'template' in r.terms ? templateCategoryProblem(r.terms, r.category) : null
  if (category) return deny(category)
  const enforced = enforceableTerms(isChainedTerms(r.terms) ? plainTermsOf(r.terms) : r.terms)
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
  // The lock never reads a price, so this check, in the SDK and in Avow's API, is all that holds
  // an agent to the price limit.
  const overPrice = priceLimitProblem(m, r.terms)
  if (overPrice) return deny(overPrice)
  const overPeriod = periodLimitProblem(m, r.terms, input.committedInPeriod)
  if (overPeriod) return deny(overPeriod)
  if (mandateEndsBeforeWindow(m, enforced)) return deny('mandate.ends_before_window')

  if (handsToPerson(m.approvalRule, amount)) {
    return { result: 'needs_human', reason: 'approval.human_required' }
  }
  return { result: 'approved', reason: 'approved' }
}

/**
 * Whether an approval rule hands an amount to a person: always, or above the rule's amount, and
 * never at it. A buyer's mandate reads it for a reserve and a seller's mandate for a sale, and
 * whoever asks a person to approve one reads it too, so nobody is asked about an amount the rule
 * lets through.
 */
export const handsToPerson = (rule: ApprovalRule, amount: bigint): boolean =>
  rule.kind === 'always' || (rule.kind === 'above' && amount > rule.amount)
