import { concat, type Hex, isAddress, keccak256, stringToHex, toHex, zeroAddress } from 'viem'
import type { Charge } from './eip712.js'
import { toTokenUnits } from './rail.js'
import type { ReasonCode } from './reasons.js'
import type { ComputeTerms } from './types.js'

/**
 * Serializes a value the same way every time: object keys sorted, no whitespace, bigints as
 * decimal strings and undefined fields left out. The terms hash is taken over these bytes.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'bigint':
      return JSON.stringify(value.toString())
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('Numbers in terms must be finite')
      return JSON.stringify(value)
    case 'string':
    case 'boolean':
      return JSON.stringify(value)
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
    }
    default:
      throw new TypeError(`Terms can't hold a ${typeof value}`)
  }
}

/** A fresh 32-byte salt, so nobody can guess standard terms from their hash. */
export function newSalt(): Hex {
  return toHex(crypto.getRandomValues(new Uint8Array(32)))
}

/**
 * The salted terms hash the lock stores and every signed message names. The arbiter's address is
 * hashed in lower case, so two copies of the same terms that write it in different letter case
 * give the same hash.
 */
export function termsHash(terms: ComputeTerms, salt: Hex): Hex {
  if (salt.length !== 66) throw new TypeError('The salt must be 32 bytes')
  const canonical = terms.dispute
    ? { ...terms, dispute: { ...terms.dispute, arbiter: terms.dispute.arbiter.toLowerCase() } }
    : terms
  return keccak256(concat([salt, stringToHex(canonicalJson(canonical))]))
}

/** The timing a factory fixes in every lock it creates, in seconds. */
export interface LockTiming {
  /** The shortest contest window a commitment can have. */
  minContestWindow: bigint
  /** How long Avow has to confirm or refer a report. */
  confirmWindow: bigint
  /** How long a posted ruling waits before it takes effect. */
  rulingDelay: bigint
  /** When, counted from a pause, Avow's ruling key stops ruling and the arbiter can start. */
  rulingKeyEnd: bigint
  /** When, counted from a pause, a charge nobody ruled on resolves. */
  day90: bigint
}

/** Limits that differ between the production factory and the testnet demo factory. */
export interface TermsProfile {
  name: 'production' | 'testnet-demo'
  minContestWindow: bigint
  /** The timing of the locks this profile's factory creates. A supplier accepts no other. */
  lockTiming: LockTiming
}

const HOUR = 3600n
const DAY = 24n * HOUR

/**
 * The intended production limits and lock timing. They're unaudited, and no deployed factory
 * creates locks with this timing yet, so a supplier that uses this profile refuses today's locks.
 */
export const PRODUCTION_PROFILE: TermsProfile = {
  name: 'production',
  minContestWindow: 72n * HOUR,
  lockTiming: {
    minContestWindow: 72n * HOUR,
    confirmWindow: DAY,
    rulingDelay: DAY,
    rulingKeyEnd: 30n * DAY,
    day90: 90n * DAY,
  },
}

/**
 * The testnet demo factory's limits, with dispute timing in minutes so a whole commitment runs in
 * one sitting. That factory doesn't enforce every production limit.
 */
export const TESTNET_DEMO_PROFILE: TermsProfile = {
  name: 'testnet-demo',
  minContestWindow: 600n,
  lockTiming: {
    minContestWindow: 600n,
    confirmWindow: 300n,
    rulingDelay: 300n,
    rulingKeyEnd: 1800n,
    day90: 5400n,
  },
}

/** Checks the terms on their own, before any mandate. Returns null when they're sound. */
export function validateTerms(terms: ComputeTerms, profile: TermsProfile): ReasonCode | null {
  const largestCharge =
    terms.lateCancellation > terms.noShow ? terms.lateCancellation : terms.noShow
  if (terms.reserve !== largestCharge || terms.reserve <= 0n) return 'terms.reserve_mismatch'
  const windowEnd = terms.windowStart + terms.windowDuration
  // Every charge needs a moment it can be reported in, so a no-show must be reportable after the
  // grace period and before the charge deadline.
  const inOrder =
    terms.windowDuration > 0n &&
    terms.gracePeriod >= 0n &&
    terms.freeCancelBy <= terms.windowStart &&
    terms.acceptBy <= terms.windowStart &&
    terms.acceptBy < terms.chargeDeadline &&
    terms.freeCancelBy < terms.chargeDeadline &&
    terms.windowStart + terms.gracePeriod < terms.chargeDeadline &&
    windowEnd <= terms.chargeDeadline &&
    terms.chargeDeadline <= terms.releaseDate
  if (!inOrder) return 'terms.deadlines_out_of_order'
  if (terms.contestWindow < profile.minContestWindow) return 'terms.contest_window_short'
  // Terms written before the dispute block existed can't be checked against an approval.
  const dispute = terms.dispute as ComputeTerms['dispute'] | undefined
  if (!dispute) return 'terms.incomplete'
  const share = dispute.day90SupplierShareBps
  if (
    typeof dispute.arbiter !== 'string' ||
    !isAddress(dispute.arbiter, { strict: false }) ||
    dispute.arbiter.toLowerCase() === zeroAddress ||
    !Number.isInteger(share) ||
    share < 0 ||
    share > 10_000
  ) {
    return 'terms.dispute_invalid'
  }
  return null
}

/**
 * The charges a commitment under these terms carries, as Avow's approval names them and the lock
 * stores them. A late cancellation can be reported from the free-cancellation deadline and a
 * no-show from the window's start plus the grace period, each up to its amount in the token's
 * base units. A kind the terms set to zero is left out, since the lock refuses a charge with no
 * amount.
 */
export function termsCharges(terms: ComputeTerms, decimals: number): Charge[] {
  const charges: Charge[] = []
  if (terms.lateCancellation > 0n) {
    charges.push({
      kind: 'lateCancellation',
      most: toTokenUnits(terms.lateCancellation, decimals),
      earliest: terms.freeCancelBy,
    })
  }
  if (terms.noShow > 0n) {
    charges.push({
      kind: 'noShow',
      most: toTokenUnits(terms.noShow, decimals),
      earliest: terms.windowStart + terms.gracePeriod,
    })
  }
  return charges
}
