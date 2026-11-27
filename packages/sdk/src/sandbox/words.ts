/** Small words every card shares, so a length of time or a share reads the same wherever it shows. */

const count = (n: bigint, unit: string) => `${n} ${unit}${n === 1n ? '' : 's'}`

/** A length of time above zero, in the largest unit that states it exactly. */
export function span(seconds: bigint): string {
  if (seconds % 86_400n === 0n) return count(seconds / 86_400n, 'day')
  if (seconds % 3_600n === 0n) return count(seconds / 3_600n, 'hour')
  if (seconds % 60n === 0n) return count(seconds / 60n, 'minute')
  return count(seconds, 'second')
}

/** A length of time, or `None` for no time at all. */
export const duration = (seconds: bigint): string => (seconds === 0n ? 'None' : span(seconds))

/** A share in basis points, as a percentage. */
export const percent = (bps: number): string => `${bps / 100}%`
