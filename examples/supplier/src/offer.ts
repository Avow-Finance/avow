import {
  type AvowDomain,
  GPU_RESERVATION,
  type Terms,
  type TermsAgreement,
  type TermsProfile,
  termsHash,
  validateTerms,
} from '@avow-finance/spec'
import type { Hex } from 'viem'

/** What this supplier signs. A real supplier checks its own catalog and capacity here too. */
export interface OfferRules {
  chainId: number
  businessId: string
  /** The largest reserve, in micros, the supplier takes for one booking. */
  maxReserve: bigint
  profile: TermsProfile
  /** Seconds the supplier needs between signing and the acceptance deadline. */
  minTimeToAccept: bigint
}

/** An agent's request to sign a terms agreement, as the SDK's `SupplierConnection` sends it. */
export interface AgreementOffer {
  agreement: TermsAgreement
  terms: Terms
  salt: Hex
  domain: AvowDomain
}

/**
 * Why the supplier won't sign an agreement, or null when it will. It signs only GPU reservation
 * terms that meet the profile, whose salted hash is the agreement's, that name this supplier on
 * this chain, reserve no more than its limit and leave it time to accept.
 */
export function agreementProblem(
  offer: AgreementOffer,
  rules: OfferRules,
  now: bigint,
): string | null {
  const { agreement, terms, salt, domain } = offer
  if (domain.chainId !== rules.chainId) return `the agreement is for chain ${domain.chainId}`
  if (agreement.supplierBusinessId !== rules.businessId)
    return 'the agreement names another supplier'
  if (agreement.expiry <= now) return 'the agreement has expired'
  if (terms.template !== GPU_RESERVATION) return `this supplier doesn't sell ${terms.template}`
  const invalid = validateTerms(terms, rules.profile)
  if (invalid) return `the terms don't meet the ${rules.profile.name} profile (${invalid})`
  if (termsHash(terms, salt).toLowerCase() !== agreement.termsHash.toLowerCase()) {
    return "the terms and salt don't give the agreement's terms hash"
  }
  if (terms.backing.amount > rules.maxReserve) return 'the reserve is over what this supplier takes'
  if (terms.remedies.acceptBy < now + rules.minTimeToAccept) {
    return 'the acceptance deadline leaves too little time to accept'
  }
  return null
}
