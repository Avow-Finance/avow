import type { Address } from 'viem'
import type { ReasonCode } from './reasons.js'
import {
  AMOUNT_DECIMALS,
  type Currency,
  type RemedyCharge,
  TERMS_VERSION,
  type TermsOf,
} from './types.js'

/**
 * The first template, a reservation of GPU capacity for a window of time. It's the only part of
 * the terms that knows what a GPU is. Its meaning is fixed, and a change of meaning would be
 * `gpu-reservation/2`.
 */
export const GPU_RESERVATION = 'gpu-reservation/1' as const

/** The unit a GPU reservation's rate is charged per. */
export const GPU_HOUR = 'gpu-hour'

/** What a GPU reservation promises: the capacity and the window it's held for. */
export interface GpuSubject {
  resource: { gpu: string; count: number; region: string; sku: string }
  windowStart: bigint
  windowDuration: bigint
}

/** GPU reservation terms. Usage is charged per GPU-hour and paid like any other purchase. */
export type GpuReservationTerms = TermsOf<GpuSubject, typeof GPU_RESERVATION>

/** What a booking states, in micros and unix seconds, before the template builds its terms. */
export interface GpuReservationInput {
  resource: GpuSubject['resource']
  currency: Currency
  windowStart: bigint
  windowDuration: bigint
  /** The last moment the supplier can accept, the window's start when left out. */
  acceptBy?: bigint
  pricePerGpuHour: bigint
  freeCancelBy: bigint
  lateCancellation: bigint
  noShow: bigint
  /** How long after the window starts the buyer can still start before it's a no-show. */
  gracePeriod: bigint
  chargeDeadline: bigint
  contestWindow: bigint
  releaseDate: bigint
  arbiter: Address
  day90SupplierShareBps: number
}

/**
 * Builds GPU reservation terms. A late cancellation can be charged from the free-cancellation
 * deadline and a no-show once the grace period after the window's start has passed. A charge set
 * to zero is left out, and the reserve is the largest charge.
 */
export function gpuReservationTerms(input: GpuReservationInput): GpuReservationTerms {
  const charges: RemedyCharge[] = []
  if (input.lateCancellation > 0n) {
    charges.push({
      kind: 'lateCancellation',
      amount: input.lateCancellation,
      earliest: input.freeCancelBy,
    })
  }
  if (input.noShow > 0n) {
    charges.push({
      kind: 'noShow',
      amount: input.noShow,
      earliest: input.windowStart + input.gracePeriod,
    })
  }
  const reserve = input.lateCancellation > input.noShow ? input.lateCancellation : input.noShow
  return {
    version: TERMS_VERSION,
    template: GPU_RESERVATION,
    currency: input.currency,
    amountDecimals: AMOUNT_DECIMALS,
    subject: {
      resource: { ...input.resource },
      windowStart: input.windowStart,
      windowDuration: input.windowDuration,
    },
    consideration: { kind: 'rate', amount: input.pricePerGpuHour, unit: GPU_HOUR },
    remedies: {
      acceptBy: input.acceptBy ?? input.windowStart,
      freeCancelBy: input.freeCancelBy,
      charges,
      chargeDeadline: input.chargeDeadline,
    },
    resolution: {
      contestWindow: input.contestWindow,
      arbiter: input.arbiter,
      day90SupplierShareBps: input.day90SupplierShareBps,
    },
    backing: { kind: 'reserve', side: 'buyer', amount: reserve, releaseDate: input.releaseDate },
  }
}

/**
 * The template's own rules, which a reader checks after the core's. The resource names a GPU,
 * a positive count, a region and a SKU, the rate is per GPU-hour and the window has a length.
 * Free cancellation and acceptance end by the window's start, and the window ends by the charge
 * deadline. A late cancellation is chargeable from the free-cancellation deadline, and a no-show
 * from the window's start or later.
 */
export function validateGpuReservation(t: GpuReservationTerms): ReasonCode | null {
  const { subject: s, remedies: r, consideration: c } = t
  const { gpu, count, region, sku } = s.resource
  if (!gpu || !region || !sku || !Number.isSafeInteger(count) || count <= 0) {
    return 'terms.template_invalid'
  }
  if (c.kind !== 'rate' || c.unit !== GPU_HOUR) return 'terms.template_invalid'
  if (s.windowDuration <= 0n) return 'terms.deadlines_out_of_order'
  const windowEnd = s.windowStart + s.windowDuration
  if (r.freeCancelBy > s.windowStart || r.acceptBy > s.windowStart) {
    return 'terms.deadlines_out_of_order'
  }
  if (windowEnd > r.chargeDeadline) return 'terms.deadlines_out_of_order'
  for (const charge of r.charges) {
    if (charge.kind === 'lateCancellation' && charge.earliest !== r.freeCancelBy) {
      return 'terms.template_invalid'
    }
    if (charge.kind === 'noShow' && charge.earliest < s.windowStart) {
      return 'terms.deadlines_out_of_order'
    }
  }
  return null
}

/** How long after the window starts a no-show becomes chargeable, or null with no such charge. */
export function gpuGracePeriod(t: GpuReservationTerms): bigint | null {
  const noShow = t.remedies.charges.find((c) => c.kind === 'noShow')
  return noShow ? noShow.earliest - t.subject.windowStart : null
}
