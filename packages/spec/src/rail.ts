import type { Address, Hex } from 'viem'
import type { Currency, Side } from './types.js'

/**
 * Everything that depends on the rail sits in this file. A second rail adds a variant here, and the
 * commitment, its terms and its states stay as they are.
 */
export type Rail = 'tempo'

/** A token on a rail and the currency it stands for. */
export interface RailToken {
  rail: Rail
  chainId: number
  token: Address
  currency: Currency
  decimals: number
}

/**
 * Converts micros into a token's base units. A token with fewer than 6 decimals can't carry
 * every micro, so an amount it can't represent exactly throws.
 */
export function toTokenUnits(micros: bigint, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new RangeError(`A token can't have ${decimals} decimals`)
  }
  if (decimals >= 6) return micros * 10n ** BigInt(decimals - 6)
  const step = 10n ** BigInt(6 - decimals)
  if (micros % step !== 0n) {
    throw new RangeError(`${micros} micros can't be paid in a token with ${decimals} decimals`)
  }
  return micros / step
}

/**
 * One side's backing on Tempo. The lock stores these fields, and Avow's approval signs them.
 */
export interface BackingRef {
  rail: Rail
  /** 42431 on Moderato. */
  chainId: number
  /** The backer's own lock. */
  lock: Address
  commitmentId: Hex
  side: Side
  /** A TIP-20, with 6 decimals. */
  token: Address
  /** Base units of the token. */
  amount: bigint
  /** On the lock's approved list. */
  payee: Address
  acceptBy: bigint
  chargeDeadline: bigint
  contestWindow: bigint
  releaseDate: bigint
  /** The salted hash of the full terms. */
  termsHash: Hex
}

/** A backing's state in the lock, as the settlement adapter reads it. */
export const RAIL_STATES = [
  'none',
  'reserved',
  'accepted',
  'charge_pending',
  'paused',
  'released',
  'charged',
  'resolved',
] as const
export type RailState = (typeof RAIL_STATES)[number]
