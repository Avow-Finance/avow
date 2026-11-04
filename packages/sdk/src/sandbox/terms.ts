import {
  dollars,
  type GpuReservationTerms,
  gpuReservationTerms,
  type SandboxDeployment,
} from '@avow-finance/spec'

const MINUTE = 60n

/**
 * How long after booking the window opens. It leaves the supplier time to check the commitment and
 * accept before the window, and free cancellation ends halfway there.
 */
export const SANDBOX_STARTS_IN = 4n * MINUTE

/** What a sandbox booking asks for: so many GPUs of one kind, for so many hours. */
export interface SandboxResource {
  gpu: string
  count: number
  hours: number
}

/** Dollars, whole or with cents, in micros. */
export function micros(amount: number, what: string): bigint {
  const cents = Math.round(amount * 100)
  if (!Number.isFinite(amount) || amount <= 0 || Math.abs(amount * 100 - cents) > 1e-6) {
    throw new RangeError(`The ${what} has to be a positive amount of dollars, such as 200 or 12.50`)
  }
  return BigInt(cents) * 10_000n
}

/** Micros as dollars, the unit a sandbox booking is written in. */
export const toDollars = (amount: bigint): number => Number(amount) / 1_000_000

/**
 * A sandbox booking's GPU reservation terms, as the buyer quickstart books them. The window opens
 * four minutes after `now` and lasts the resource's hours. Free cancellation ends two minutes in, a
 * late cancellation costs half the reserve, a no-show costs the whole reserve after two minutes'
 * grace, and the reserve goes back at the window's end when nothing is reported. Usage is $3 per
 * GPU-hour, paid apart from the reserve.
 */
export function sandboxTerms(b: {
  deployment: Pick<SandboxDeployment, 'arbiter' | 'day90SupplierShareBps'>
  resource: SandboxResource
  /** In micros. */
  reserve: bigint
  /** Unix seconds. */
  now: bigint
}): GpuReservationTerms {
  const { gpu, count, hours } = b.resource
  if (!/^[A-Za-z0-9-]{1,32}$/.test(gpu)) {
    throw new RangeError('The GPU has to be a model name such as H100')
  }
  if (!Number.isInteger(count) || count < 1 || count > 1024) {
    throw new RangeError('The GPU count has to be a whole number from 1 to 1024')
  }
  const seconds = Math.round(hours * 3600)
  if (!Number.isFinite(hours) || seconds < 60 || hours > 24 * 7) {
    throw new RangeError('The booking has to last from a minute to a week of hours, such as 1')
  }
  const windowStart = b.now + SANDBOX_STARTS_IN
  const windowDuration = BigInt(seconds)
  const windowEnd = windowStart + windowDuration
  const half = windowDuration / 2n
  return gpuReservationTerms({
    resource: { gpu, count, region: 'demo', sku: `demo-${gpu.toLowerCase()}x${count}` },
    currency: 'USD',
    windowStart,
    windowDuration,
    pricePerGpuHour: dollars(3),
    freeCancelBy: windowStart - SANDBOX_STARTS_IN / 2n,
    lateCancellation: b.reserve / 2n,
    noShow: b.reserve,
    gracePeriod: half < 2n * MINUTE ? half : 2n * MINUTE,
    chargeDeadline: windowEnd,
    contestWindow: 10n * MINUTE,
    releaseDate: windowEnd,
    arbiter: b.deployment.arbiter,
    day90SupplierShareBps: b.deployment.day90SupplierShareBps,
  })
}
