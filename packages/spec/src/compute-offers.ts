import { z } from 'zod'
import { type GpuReservationTerms, gpuReservationTerms } from './gpu-reservation.js'
import { u64, u256 } from './json-fields.js'
import type { SandboxDeployment } from './sandbox.js'
import { SUPPLIER_ADAPTER_PATHS } from './supplier-adapter.js'
import type { Parsed } from './wire.js'

/**
 * A GPU supplier's offers of compute for a job, which its adapter lists at
 * `SUPPLIER_ADAPTER_PATHS.offers` for the window a job needs. An agent compares them and books one
 * with terms `computeOfferTerms` builds, so the agent and the supplier build the same terms from
 * the same offer. The supplier still decides what it signs.
 *
 * An offer is firm when its free cancellation had ended by the time it was listed, so a booking of
 * it can't be cancelled at no charge, and flexible when it ends later. Usage is paid separately at
 * the offer's rate and the reserve doesn't secure it. The reserve covers what the booking's terms
 * let the supplier charge if the buyer walks away.
 */
export interface ComputeOffer {
  id: string
  /** The supplier's business id. */
  supplier: string
  gpu: string
  region: string
  sku: string
  /** How many GPUs one booking of the offer can take. */
  gpus: { min: number; max: number }
  /** How long the window lasts, in whole minutes. */
  minutes: number
  /** When the window starts, in unix seconds. */
  startsAt: bigint
  /** Until this moment a booking can be cancelled at no charge. At or before `listedAt`, firm. */
  freeCancelBy: bigint
  /** Usage per GPU-hour, in micros, paid apart from the reserve and never secured by it. */
  pricePerGpuHour: bigint
  /** The reserve a booking needs for each GPU, in micros. */
  reservePerGpu: bigint
  /**
   * When the offer lapses, in unix seconds. It says when the listing stops standing. The supplier
   * keeps no record of its listings and signs any terms within its own limits.
   */
  expiry: bigint
}

/** What a GPU supplier's adapter lists for a job's window. */
export interface ComputeOffers {
  supplier: string
  /** When the supplier listed these offers, in unix seconds. */
  listedAt: bigint
  offers: ComputeOffer[]
}

/** The most offers one listing holds. */
export const MAX_COMPUTE_OFFERS = 16

/**
 * The path that lists a supplier's offers for the window a job needs, from its start to its
 * deadline, an unsigned GET under the supplier's adapter.
 */
export function computeOffersPath(window: { startsAt: bigint; deliverBy: bigint }): string {
  return `${SUPPLIER_ADAPTER_PATHS.offers}?startsAt=${window.startsAt}&deliverBy=${window.deliverBy}`
}

/** Whether an offer was firm when it was listed: its free cancellation had already ended. */
export const isFirmOffer = (offer: ComputeOffer, listedAt: bigint): boolean =>
  offer.freeCancelBy <= listedAt

/** An offer's window in seconds. */
export const offerSeconds = (offer: Pick<ComputeOffer, 'minutes'>): bigint =>
  BigInt(offer.minutes) * 60n

/** Whether one booking of the offer can take this many GPUs. */
export const offerTakes = (offer: Pick<ComputeOffer, 'gpus'>, gpus: number): boolean =>
  Number.isSafeInteger(gpus) && gpus >= offer.gpus.min && gpus <= offer.gpus.max

/**
 * What booking `gpus` of an offer costs: the usage price for its whole window, paid apart from the
 * reserve, and the reserve the booking needs, both in micros. Throws for a count the offer doesn't
 * take.
 */
export function computeOfferCost(
  offer: ComputeOffer,
  gpus: number,
): { price: bigint; reserve: bigint } {
  if (!offerTakes(offer, gpus)) {
    throw new RangeError(`Offer ${offer.id} takes ${offer.gpus.min} to ${offer.gpus.max} GPUs`)
  }
  const n = BigInt(gpus)
  return {
    price: (offer.pricePerGpuHour * n * offerSeconds(offer)) / 3600n,
    reserve: offer.reservePerGpu * n,
  }
}

const MINUTE = 60n

/**
 * The GPU reservation terms for booking `gpus` of an offer. The window and the free-cancellation
 * deadline are the offer's, the rate is its price per GPU-hour, and the reserve is its reserve per
 * GPU times the count. A no-show costs the whole reserve after the grace period, two minutes or
 * half the window when that's shorter, and a late cancellation half of it. Charges can be reported
 * until the window ends, the contest window is ten minutes, and the reserve comes back at the
 * window's end. The arbiter and the day-90 share are the deployment's, which Avow's approvals name.
 * Throws for a count the offer doesn't take.
 */
export function computeOfferTerms(
  offer: ComputeOffer,
  gpus: number,
  settlement: Pick<SandboxDeployment, 'arbiter' | 'day90SupplierShareBps'>,
): GpuReservationTerms {
  const { reserve } = computeOfferCost(offer, gpus)
  const windowDuration = offerSeconds(offer)
  const windowEnd = offer.startsAt + windowDuration
  const half = windowDuration / 2n
  return gpuReservationTerms({
    resource: { gpu: offer.gpu, count: gpus, region: offer.region, sku: offer.sku },
    currency: 'USD',
    windowStart: offer.startsAt,
    windowDuration,
    pricePerGpuHour: offer.pricePerGpuHour,
    freeCancelBy: offer.freeCancelBy,
    lateCancellation: reserve / 2n,
    noShow: reserve,
    gracePeriod: half < 2n * MINUTE ? half : 2n * MINUTE,
    chargeDeadline: windowEnd,
    contestWindow: 10n * MINUTE,
    releaseDate: windowEnd,
    arbiter: settlement.arbiter,
    day90SupplierShareBps: settlement.day90SupplierShareBps,
  })
}

const text = (max: number) => z.string().min(1).max(max)

/** An offer as JSON, with amounts and times as decimal strings. */
export const computeOfferJson = z
  .strictObject({
    id: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/),
    supplier: text(100),
    gpu: text(64),
    region: text(64),
    sku: text(64),
    gpus: z.strictObject({
      min: z.number().int().min(1).max(1024),
      max: z.number().int().min(1).max(1024),
    }),
    minutes: z
      .number()
      .int()
      .min(1)
      .max(7 * 24 * 60),
    startsAt: u64,
    freeCancelBy: u64,
    pricePerGpuHour: u256,
    reservePerGpu: u256,
    expiry: u64,
  })
  .refine((o) => o.gpus.min <= o.gpus.max, 'gpus.min is at most gpus.max')
  .refine((o) => o.freeCancelBy <= o.startsAt, 'free cancellation ends by the start')

/** A supplier's listing as JSON. */
export const computeOffersJson = z.strictObject({
  supplier: text(100),
  listedAt: u64,
  offers: z.array(computeOfferJson).min(1).max(MAX_COMPUTE_OFFERS),
})

/** Reads a supplier's listing of offers, refusing ids listed twice or another supplier's offer. */
export function parseComputeOffers(json: unknown): Parsed<ComputeOffers> {
  const parsed = computeOffersJson.safeParse(json)
  if (!parsed.success) return { ok: false, reason: 'message.invalid' }
  const listing = parsed.data as ComputeOffers
  const ids = new Set(listing.offers.map((o) => o.id))
  const theirs = listing.offers.every((o) => o.supplier === listing.supplier)
  return ids.size === listing.offers.length && theirs
    ? { ok: true, value: listing }
    : { ok: false, reason: 'message.invalid' }
}
