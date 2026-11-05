import type { Address } from 'viem'
import { type GpuReservationTerms, gpuReservationTerms } from './gpu-reservation.js'
import { type JobTerms, jobTerms } from './job.js'

/** Whole dollars in micros. */
export function dollars(n: number): bigint {
  if (!Number.isInteger(n)) throw new RangeError('Use whole dollars, or write the micros out')
  return BigInt(n) * 1_000_000n
}

const MINUTE = 60n
const HOUR = 60n * MINUTE

/**
 * Demo terms for 8 H100s under the GPU reservation template: a $500 reserve, free cancellation
 * until 24 hours before the start, $250 for a late cancellation, $500 for a no-show after 30
 * minutes' grace and a 72-hour contest window. Usage is $3 per GPU-hour, paid separately. A
 * dispute nobody rules on by day 90 splits a confirmed charge evenly, and the caller names the
 * arbiter.
 */
export function demoTerms(windowStart: bigint, arbiter: Address): GpuReservationTerms {
  const windowEnd = windowStart + 24n * HOUR
  return gpuReservationTerms({
    resource: { gpu: 'H100', count: 8, region: 'demo', sku: 'demo-h100x8' },
    currency: 'USD',
    windowStart,
    windowDuration: 24n * HOUR,
    pricePerGpuHour: dollars(3),
    freeCancelBy: windowStart - 24n * HOUR,
    lateCancellation: dollars(250),
    noShow: dollars(500),
    gracePeriod: 30n * MINUTE,
    chargeDeadline: windowEnd,
    contestWindow: 72n * HOUR,
    releaseDate: windowEnd,
    arbiter,
    day90SupplierShareBps: 5000,
  })
}

/**
 * The same terms run in minutes for testnet: a 30-minute window, free cancellation until 10
 * minutes before, 2 minutes' grace and a 10-minute contest window, which only the testnet demo
 * profile accepts.
 */
export function testnetDemoTerms(windowStart: bigint, arbiter: Address): GpuReservationTerms {
  const windowEnd = windowStart + 30n * MINUTE
  return gpuReservationTerms({
    resource: { gpu: 'H100', count: 8, region: 'demo', sku: 'demo-h100x8' },
    currency: 'USD',
    windowStart,
    windowDuration: 30n * MINUTE,
    pricePerGpuHour: dollars(3),
    freeCancelBy: windowStart - 10n * MINUTE,
    lateCancellation: dollars(250),
    noShow: dollars(500),
    gracePeriod: 2n * MINUTE,
    chargeDeadline: windowEnd,
    contestWindow: 10n * MINUTE,
    releaseDate: windowEnd,
    arbiter,
    day90SupplierShareBps: 5000,
  })
}

/**
 * A job on testnet as Avow's test customer proposes one: a ten-minute fine-tuning run on one H100
 * in the demo region, starting at `startsAt`, for $40 paid on delivery. Its reserve backs a late
 * cancellation after work has started, up to $10, and a no-show, up to $6, two minutes after the
 * start. Charges can be reported until ten minutes after the deadline, and the reserve comes back
 * then.
 */
export function testnetDemoJobTerms(startsAt: bigint, arbiter: Address): JobTerms {
  const deliverBy = startsAt + 10n * MINUTE
  return jobTerms({
    work: { kind: 'fine-tuning', summary: 'Fine-tune a small model on the demo dataset' },
    compute: { gpu: 'H100', count: 1, region: 'demo' },
    currency: 'USD',
    startsAt,
    deliverBy,
    price: dollars(40),
    lateCancellation: dollars(10),
    noShow: dollars(6),
    gracePeriod: 2n * MINUTE,
    chargeDeadline: deliverBy + 10n * MINUTE,
    contestWindow: 10n * MINUTE,
    releaseDate: deliverBy + 10n * MINUTE,
    arbiter,
    day90SupplierShareBps: 5000,
  })
}
