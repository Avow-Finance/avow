import { concat, type Hex, keccak256, stringToHex, toHex } from 'viem'
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

/** The salted terms hash the lock stores and every signed message names. */
export function termsHash(terms: ComputeTerms, salt: Hex): Hex {
  if (salt.length !== 66) throw new TypeError('The salt must be 32 bytes')
  return keccak256(concat([salt, stringToHex(canonicalJson(terms))]))
}

/** Limits that differ between the production factory and the testnet demo factory. */
export interface TermsProfile {
  name: 'production' | 'testnet-demo'
  minContestWindow: bigint
}

export const PRODUCTION_PROFILE: TermsProfile = { name: 'production', minContestWindow: 259_200n }
export const TESTNET_DEMO_PROFILE: TermsProfile = { name: 'testnet-demo', minContestWindow: 600n }

/** Checks the terms on their own, before any mandate. Returns null when they're sound. */
export function validateTerms(terms: ComputeTerms, profile: TermsProfile): ReasonCode | null {
  const largestCharge =
    terms.lateCancellation > terms.noShow ? terms.lateCancellation : terms.noShow
  if (terms.reserve !== largestCharge || terms.reserve <= 0n) return 'terms.reserve_mismatch'
  const windowEnd = terms.windowStart + terms.windowDuration
  // Every charge needs a moment it can be reported in, so a no-show must be reportable after the
  // grace period and before the charge deadline (decision 7).
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
  return null
}
