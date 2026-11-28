import { formatUnits } from 'viem'

/** An amount as a decimal string of dollars, from units with the given decimals. */
export const dollars = (units: bigint, decimals: number) => formatUnits(units, decimals)

/** A time in seconds since the epoch, as ISO 8601 in UTC. */
export const iso = (seconds: bigint) => new Date(Number(seconds) * 1000).toISOString()
