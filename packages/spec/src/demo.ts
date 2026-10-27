import type { ComputeTerms } from './types.js'

/** Whole dollars in micros. */
export function dollars(n: number): bigint {
  if (!Number.isInteger(n)) throw new RangeError('Use whole dollars, or write the micros out')
  return BigInt(n) * 1_000_000n
}

const MINUTE = 60n
const HOUR = 60n * MINUTE

/**
 * The master spec's demo terms for 8 H100s: a $500 reserve, free cancellation until 24 hours
 * before the start, $250 for a late cancellation, $500 for a no-show, 30 minutes' grace and a
 * 72-hour contest window. Usage is $3 per GPU-hour, paid separately.
 */
export function demoTerms(windowStart: bigint): ComputeTerms {
  const windowEnd = windowStart + 24n * HOUR
  return {
    kind: 'compute',
    resource: { gpu: 'H100', count: 8, region: 'demo', sku: 'demo-h100x8' },
    currency: 'USD',
    windowStart,
    windowDuration: 24n * HOUR,
    acceptBy: windowStart,
    price: { perGpuHour: dollars(3) },
    reserve: dollars(500),
    freeCancelBy: windowStart - 24n * HOUR,
    lateCancellation: dollars(250),
    noShow: dollars(500),
    gracePeriod: 30n * MINUTE,
    chargeDeadline: windowEnd,
    contestWindow: 72n * HOUR,
    releaseDate: windowEnd,
  }
}

/**
 * The same terms run in minutes, the master spec's testnet column: a 30-minute window, free
 * cancellation until 10 minutes before, 2 minutes' grace and a 10-minute contest window, which
 * only the testnet demo profile accepts.
 */
export function testnetDemoTerms(windowStart: bigint): ComputeTerms {
  const windowEnd = windowStart + 30n * MINUTE
  return {
    ...demoTerms(windowStart),
    windowDuration: 30n * MINUTE,
    freeCancelBy: windowStart - 10n * MINUTE,
    gracePeriod: 2n * MINUTE,
    chargeDeadline: windowEnd,
    contestWindow: 10n * MINUTE,
    releaseDate: windowEnd,
  }
}
