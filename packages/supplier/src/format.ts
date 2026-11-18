import { formatUnits } from 'viem'

/**
 * Terms state money in micros, millionths of a dollar, whatever token the lock holds. A lock's own
 * amounts are in its token's base units, so they take the token's decimals instead.
 */
export const TERMS_DECIMALS = 6

/** An amount as a decimal string of dollars, from units with the given decimals. */
export const dollars = (units: bigint, decimals: number) => formatUnits(units, decimals)

/** A time in seconds since the epoch, as ISO 8601 in UTC. */
export const iso = (seconds: bigint) => new Date(Number(seconds) * 1000).toISOString()
