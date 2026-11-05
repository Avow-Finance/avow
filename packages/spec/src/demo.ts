import type { Address } from 'viem'
import type { ComputeOffer, ComputeOffers } from './compute-offers.js'
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

/** The demo GPU supplier's business id on testnet. */
export const DEMO_GPU_SUPPLIER = 'avow-demo-gpu'

/**
 * The four offers Avow's demo GPU supplier lists for a job's window, each reserving $40 a GPU, so
 * the agent has a real choice. Under the starter's defaults, a $3.00 budget per GPU-hour and $500
 * of authority for a job on one H100, one is clearly best and each other fails a check that names
 * why.
 *
 * - `h100-firm` takes 1 to 16 GPUs at $2.40, firm, over the job's whole run. It's the one that fits.
 * - `h100-flex` is cheaper at $1.60 and flexible. Its window and its free cancellation both start
 *   and end at the job's start, so it can never pass the customer's check before the job starts,
 *   and the customer refuses it as still cancellable (`dependency.cancellable`).
 * - `h100-later` starts after the job's deadline, so it doesn't hold the job's run
 *   (`dependency.does_not_fit`).
 * - `h100-x16` takes exactly 16 GPUs at $2.00, which reserves $640, more than the mandate allows for
 *   one commitment (`mandate.over_commitment_cap`). Sixteen GPUs of `h100-firm` reserve the same.
 *
 * Each window but the flexible one starts two minutes before the job, and each ends five minutes
 * after its deadline. An offer lapses ten minutes after it's listed, or a minute before its window
 * starts if that comes first, so no one books a window that has begun. The supplier itself signs any
 * GPU terms within its limits, whatever it listed.
 */
export function demoComputeOffers(job: {
  startsAt: bigint
  deliverBy: bigint
  listedAt: bigint
}): ComputeOffers {
  const end = job.deliverBy + 5n * MINUTE
  const later = job.deliverBy + 10n * MINUTE
  const hoursFrom = (start: bigint) => Number((end - start + MINUTE - 1n) / MINUTE) / 60
  const offer = (o: Pick<ComputeOffer, 'id' | 'pricePerGpuHour'> & Partial<ComputeOffer>) => {
    const startsAt = o.startsAt ?? job.startsAt - 2n * MINUTE
    const lapses = job.listedAt + 10n * MINUTE
    return {
      supplier: DEMO_GPU_SUPPLIER,
      gpu: 'H100',
      region: 'demo',
      sku: 'demo-h100',
      gpus: { min: 1, max: 16 },
      hours: hoursFrom(startsAt),
      freeCancelBy: job.listedAt,
      reservePerGpu: dollars(40),
      ...o,
      startsAt,
      expiry: lapses < startsAt - MINUTE ? lapses : startsAt - MINUTE,
    }
  }
  return {
    supplier: DEMO_GPU_SUPPLIER,
    listedAt: job.listedAt,
    offers: [
      offer({ id: 'h100-firm', pricePerGpuHour: 2_400_000n }),
      offer({
        id: 'h100-flex',
        pricePerGpuHour: 1_600_000n,
        startsAt: job.startsAt,
        freeCancelBy: job.startsAt,
      }),
      offer({ id: 'h100-later', pricePerGpuHour: 2_200_000n, startsAt: later, hours: 0.5 }),
      offer({ id: 'h100-x16', pricePerGpuHour: 2_000_000n, gpus: { min: 16, max: 16 } }),
    ],
  }
}
