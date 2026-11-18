import { GPU_RESERVATION } from '@avow-finance/spec'
import type { OfferRules } from './offer.js'

/** How many open bookings the supplier holds for one buyer's lock, and in all. */
export interface OpenLimits {
  perBuyer: number
  total: number
}

/**
 * What the supplier accepts, as it publishes it at `GET /policy`. The rules are sentences a
 * developer reads, and the limits are the same numbers for an agent to check an offer against
 * before it sends one.
 */
export interface AcceptancePolicy {
  businessId: string
  summary: string
  rules: string[]
  limits: {
    chainId: number
    template: string
    profile: string
    /** Micros of the reserve's dollar token, as a decimal string. */
    maxReserve: string
    /** Seconds the supplier needs between signing and the acceptance deadline. */
    minTimeToAccept: string
    openPerBuyer: number
    openInAll: number
  }
}

/** Micros as dollars and cents, such as `$1,000` or `$12.50`. */
export function dollars(micros: bigint): string {
  const whole = (micros / 1_000_000n).toLocaleString('en-US')
  const cents = (micros % 1_000_000n) / 10_000n
  return cents === 0n ? `$${whole}` : `$${whole}.${cents.toString().padStart(2, '0')}`
}

/**
 * The supplier's acceptance policy, built from the rules it signs by and its open-booking limits,
 * so what it publishes is what it enforces.
 */
export function acceptancePolicy(rules: OfferRules, limits: OpenLimits): AcceptancePolicy {
  return {
    businessId: rules.businessId,
    summary:
      "This supplier takes a booking only when an Avow commitment backs it, with the reserve held in the buyer's own lock. It holds capacity only for a booking its verifier has checked.",
    rules: [
      `It signs GPU reservation terms that meet Avow's ${rules.profile.name} profile on chain ${rules.chainId}, for a reserve of at most ${dollars(rules.maxReserve)}.`,
      `Agents offer terms at POST /agreements. It signs an offer only on a lock Avow's factory made, and only when the acceptance deadline leaves it at least ${rules.minTimeToAccept} seconds.`,
      "It holds capacity once Avow authorizes the funded reserve and its verifier passes Avow's authorization and approval, the buyer's mandate and the lock against the terms it signed. It grants the capacity once the lock holds its acceptance.",
      'A booking whose reserve never arrives lapses at its acceptance deadline, and Avow releases any reserve back to the business.',
      "It charges only what the terms allow, for a late cancellation from the free-cancellation deadline on or a no-show once the grace period has passed, and never more than the terms' most for that charge. The business can dispute a charge before its contest window closes.",
      `It holds at most ${limits.perBuyer} open bookings for one buyer's lock and ${limits.total} in all. An offer past either limit gets a 429 and can come again once a booking is accepted or lapses.`,
    ],
    limits: {
      chainId: rules.chainId,
      template: GPU_RESERVATION,
      profile: rules.profile.name,
      maxReserve: rules.maxReserve.toString(),
      minTimeToAccept: rules.minTimeToAccept.toString(),
      openPerBuyer: limits.perBuyer,
      openInAll: limits.total,
    },
  }
}
