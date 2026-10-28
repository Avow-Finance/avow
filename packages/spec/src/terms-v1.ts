import {
  type Address,
  concat,
  type Hex,
  isAddress,
  keccak256,
  stringToHex,
  zeroAddress,
} from 'viem'
import type { Charge } from './eip712.js'
import type { TermsProfile } from './profiles.js'
import { toTokenUnits } from './rail.js'
import type { ReasonCode } from './reasons.js'
import type { Currency, DisputeTerms } from './types.js'

/**
 * Version 1 of the terms, the flat GPU reservation format published before the terms had a
 * version field. Commitments made under it stay verifiable, so everything in this file is frozen.
 * It hashes, checks and maps version 1 terms exactly as it did when they were signed, and the
 * tests pin its outputs. New commitments use version 2, in `terms.ts`.
 */

/**
 * The terms of a GPU reservation, version 1. Nothing here names a rail, and the arbiter is an EVM
 * address, so the same terms and terms hash work on any EVM rail that backs them.
 */
export interface ComputeTermsV1 {
  kind: 'compute'
  resource: { gpu: string; count: number; region: string; sku: string }
  currency: Currency
  windowStart: bigint
  windowDuration: bigint
  /** The last moment the supplier can accept, the window's start by default. */
  acceptBy: bigint
  /** Usage, paid like any other purchase and never from the reserve. */
  price: { perGpuHour: bigint }
  /** The most the supplier can charge, which equals the largest charge below. */
  reserve: bigint
  freeCancelBy: bigint
  lateCancellation: bigint
  noShow: bigint
  gracePeriod: bigint
  chargeDeadline: bigint
  contestWindow: bigint
  releaseDate: bigint
  dispute: DisputeTerms
}

/** Version 1 terms carry no version field, and every later version does. */
export function isTermsV1(terms: object): terms is ComputeTermsV1 {
  return !('version' in terms)
}

/**
 * The canonical JSON version 1 hashed: object keys sorted, no whitespace, bigints as decimal
 * strings and undefined fields left out. Kept apart from `canonicalJson` so version 1 hashes
 * never move.
 */
function canonicalJsonV1(value: unknown): string {
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
      if (Array.isArray(value)) return `[${value.map(canonicalJsonV1).join(',')}]`
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJsonV1(v)}`).join(',')}}`
    }
    default:
      throw new TypeError(`Terms can't hold a ${typeof value}`)
  }
}

/**
 * The salted hash of version 1 terms. The arbiter's address is hashed in lower case, so two copies
 * of the same terms that write it in different letter case give the same hash.
 */
export function termsHashV1(terms: ComputeTermsV1, salt: Hex): Hex {
  if (salt.length !== 66) throw new TypeError('The salt must be 32 bytes')
  const canonical = terms.dispute
    ? { ...terms, dispute: { ...terms.dispute, arbiter: terms.dispute.arbiter.toLowerCase() } }
    : terms
  return keccak256(concat([salt, stringToHex(canonicalJsonV1(canonical))]))
}

/** Checks version 1 terms on their own, before any mandate. Returns null when they're sound. */
export function validateTermsV1(terms: ComputeTermsV1, profile: TermsProfile): ReasonCode | null {
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
  const dispute = terms.dispute as ComputeTermsV1['dispute'] | undefined
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
 * The charges a commitment under version 1 terms carries, as Avow's approval names them and the
 * lock stores them. A late cancellation can be reported from the free-cancellation deadline and a
 * no-show from the window's start plus the grace period, each up to its amount in the token's
 * base units. A kind the terms set to zero is left out, since the lock refuses a charge with no
 * amount.
 */
export function termsChargesV1(terms: ComputeTermsV1, decimals: number): Charge[] {
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

const MINUTE = 60n
const HOUR = 60n * MINUTE

/**
 * Version 1 demo terms for 8 H100s: a $500 reserve, free cancellation until 24 hours before the
 * start, $250 for a late cancellation, $500 for a no-show, 30 minutes' grace and a 72-hour contest
 * window. Usage is $3 per GPU-hour, paid separately. A dispute nobody rules on by day 90 splits a
 * confirmed charge evenly, and the caller names the arbiter.
 */
export function demoTermsV1(windowStart: bigint, arbiter: Address): ComputeTermsV1 {
  const windowEnd = windowStart + 24n * HOUR
  return {
    kind: 'compute',
    resource: { gpu: 'H100', count: 8, region: 'demo', sku: 'demo-h100x8' },
    currency: 'USD',
    windowStart,
    windowDuration: 24n * HOUR,
    acceptBy: windowStart,
    price: { perGpuHour: 3_000_000n },
    reserve: 500_000_000n,
    freeCancelBy: windowStart - 24n * HOUR,
    lateCancellation: 250_000_000n,
    noShow: 500_000_000n,
    gracePeriod: 30n * MINUTE,
    chargeDeadline: windowEnd,
    contestWindow: 72n * HOUR,
    releaseDate: windowEnd,
    dispute: { arbiter, day90SupplierShareBps: 5000 },
  }
}

/**
 * The same version 1 terms run in minutes for testnet: a 30-minute window, free cancellation
 * until 10 minutes before, 2 minutes' grace and a 10-minute contest window, which only the
 * testnet demo profile accepts.
 */
export function testnetDemoTermsV1(windowStart: bigint, arbiter: Address): ComputeTermsV1 {
  const windowEnd = windowStart + 30n * MINUTE
  return {
    ...demoTermsV1(windowStart, arbiter),
    windowDuration: 30n * MINUTE,
    freeCancelBy: windowStart - 10n * MINUTE,
    gracePeriod: 2n * MINUTE,
    chargeDeadline: windowEnd,
    contestWindow: 10n * MINUTE,
    releaseDate: windowEnd,
  }
}
