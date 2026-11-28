import { type Address, encodeAbiParameters, type Hex, keccak256, maxUint64, maxUint256 } from 'viem'
import { z } from 'zod'
import { canonicalJson } from './canonical.js'
import { BPS, isCount, isShare } from './fields.js'
import {
  type ChainedJobTerms,
  JOB,
  JOB_KIND_MAX,
  JOB_SUMMARY_MAX,
  type JobSubject,
  type JobTerms,
  jobTerms,
  validateJob,
} from './job.js'
import { u64, u256 } from './json-fields.js'
import { BUSINESS_ID_MAX } from './service.js'
import { plainTermsOf } from './terms.js'
import { isPlainText, isSoundText } from './text.js'
import { CHAINED_TERMS_VERSION, CURRENCIES, type Currency } from './types.js'
import type { Parsed } from './wire.js'

/**
 * A job offer is a supplier's standing offer of one kind of job under `job/1`: the work, the GPU
 * capacity it runs on, one fixed price for the whole job, and when work starts and is delivered
 * after an order. A buyer builds the job's terms from a version with `jobOfferTerms` and orders
 * them as it orders any job, and the supplier quotes them with the compute booking they rely on
 * added, as version 3 terms. The job itself is unchanged, so a job ordered without an offer runs
 * exactly as before.
 *
 * Job terms carry no offer id, since `job/1` names none and a change to its subject would be
 * `job/2`. `jobTermsMatchOffer` says whether terms are exactly the ones a version gives, for
 * whoever holds the version, and the version is never read from the terms.
 *
 * A version's meaning is fixed, and a change of meaning would be `avow:offer:job/2`.
 */

/** The most GPUs a job offer names, as a compute offer takes at most. */
export const JOB_OFFER_GPUS_MAX = 1024

/**
 * The least time from an order to the start a job offer gives, in seconds. The supplier books the
 * compute and quotes, and the buyer checks the booking and funds its reserve, all before the start.
 */
export const JOB_OFFER_START_MIN = 15n * 60n

/** How long after a job's delivery deadline its supplier can report a charge, in seconds. */
export const JOB_OFFER_CHARGE_AFTER = 24n * 60n * 60n

/**
 * The latest moment a job can be built from an offer, in unix seconds, 2^40, which is tens of
 * thousands of years away. A version's lengths leave room for it, so the times of a job built at
 * any moment up to it count in a uint64 of seconds.
 */
export const JOB_OFFER_BUILT_BY_MAX = 2n ** 40n

/** The contest window of a job built from an offer on the testnet, in seconds. */
const JOB_OFFER_CONTEST_WINDOW = 10n * 60n

/**
 * A supplier's rules for one kind of job, which it approves when it publishes the offer. Every
 * length counts from the moment the buyer builds the terms, and none names a clock time.
 */
export interface JobOfferRules {
  /**
   * How long after the order work starts, in seconds, at least `JOB_OFFER_START_MIN`. The buyer's
   * free cancellation ends at the start, and the supplier accepts by then.
   */
  startAfter: bigint
  /** How long from the start the supplier delivers by, in seconds, above zero. */
  turnaround: bigint
  /**
   * How long after the start the buyer can still hand over the work's inputs before it's a no-show,
   * in seconds, up to the turnaround, so a no-show can be reported by the delivery deadline.
   */
  gracePeriod: bigint
  /**
   * How many of these jobs the supplier takes in a day. The terms don't carry it, so whoever accepts
   * jobs for the supplier counts against it.
   */
  dailyCapacity: number
  /** What a cancellation after the start can cost, as a share of the price in basis points. */
  lateCancellationBps: number
  /** What not handing over the inputs can cost, as a share of the price in basis points. */
  noShowBps: number
}

/**
 * One version of a supplier's offer of a job. A version never changes. A new price, other compute
 * or a change to the rules is a new version, with a new id.
 */
export interface JobOfferVersion {
  /** Which template the version sells under, so a version reads as a job's wherever it's carried. */
  template: typeof JOB
  /** The supplier's business id. */
  supplier: string
  /**
   * The work, as the job's terms name it. Its kind is the item a seller's mandate reads, plain text
   * on one line, since a person reads it on the card they sign.
   */
  work: JobSubject['work']
  /** The GPU capacity every job of this version runs on, which the booking it relies on holds. */
  compute: JobSubject['compute']
  currency: Currency
  /** The price of one job, in micros, paid by a separate transfer on delivery. */
  price: bigint
  rules: JobOfferRules
}

/**
 * What's wrong with a job offer version, in words for the person setting it, or null when nothing
 * is. The supplier, work and compute are named, the price is above zero, work starts at least
 * `JOB_OFFER_START_MIN` after the order and is delivered some time after it starts, the grace
 * period ends by delivery, capacity is at least one job a day, each charge is a share from 0 to
 * 100%, and at least one is above zero, since a reserve with nothing to charge backs nothing.
 * The start, the turnaround and the charge window after delivery, counted from any moment up to
 * `JOB_OFFER_BUILT_BY_MAX`, add up to a uint64 of seconds, and the price times 10,000 basis points fits a uint256, so a share of it can be worked out.
 * Every field has its declared type, so a version that passes hashes one way only.
 */
export function jobOfferProblem(v: JobOfferVersion): string | null {
  if (typeof v !== 'object' || v === null || v.template !== JOB) return 'Offer a job/1 job.'
  if (!isSoundText(v.supplier, BUSINESS_ID_MAX)) return "Name the supplier's business."
  if (typeof v.work !== 'object' || v.work === null) return 'Name the work.'
  if (!isPlainText(v.work.kind, JOB_KIND_MAX)) {
    return `Name the kind of work in 1 to ${JOB_KIND_MAX} characters on one line, with no quotes.`
  }
  if (!isSoundText(v.work.summary, JOB_SUMMARY_MAX)) {
    return `Say what the work is in 1 to ${JOB_SUMMARY_MAX} characters.`
  }
  const c = v.compute
  if (typeof c !== 'object' || c === null) return 'Name the compute the work runs on.'
  if (!isSoundText(c.gpu, JOB_KIND_MAX) || !isSoundText(c.region, JOB_KIND_MAX)) {
    return `Name the GPU and the region in 1 to ${JOB_KIND_MAX} characters each.`
  }
  if (!isCount(c.count, JOB_OFFER_GPUS_MAX)) {
    return `A job runs on 1 to ${JOB_OFFER_GPUS_MAX} GPUs.`
  }
  if (!(CURRENCIES as readonly unknown[]).includes(v.currency)) return 'Choose a currency.'
  if (typeof v.price !== 'bigint' || v.price <= 0n) return 'The price has to be more than zero.'
  if (v.price * BPS > maxUint256) return 'The price is too large to take a share of.'
  const r = v.rules
  if (typeof r !== 'object' || r === null) return 'Set the rules for ordering.'
  if (typeof r.startAfter !== 'bigint' || r.startAfter < JOB_OFFER_START_MIN) {
    return 'Work starts at least 15 minutes after the order, so there is time to book and accept.'
  }
  if (typeof r.turnaround !== 'bigint' || r.turnaround <= 0n) {
    return 'Delivery comes some time after work starts.'
  }
  if (JOB_OFFER_BUILT_BY_MAX + r.startAfter + r.turnaround + JOB_OFFER_CHARGE_AFTER > maxUint64) {
    return 'Work starts and is delivered too far ahead to count in seconds.'
  }
  if (typeof r.gracePeriod !== 'bigint' || r.gracePeriod < 0n || r.gracePeriod > r.turnaround) {
    return 'The grace period for the inputs ends by delivery.'
  }
  if (!isCount(r.dailyCapacity, Number.MAX_SAFE_INTEGER)) {
    return 'Capacity is at least one job a day.'
  }
  if (!isShare(r.lateCancellationBps) || !isShare(r.noShowBps)) {
    return 'A charge is a share of the price from 0 to 100%.'
  }
  if (r.lateCancellationBps === 0 && r.noShowBps === 0) {
    return 'Set a late-cancellation or no-show charge, or the reserve backs nothing.'
  }
  return null
}

const text = (max: number) => z.string().min(1).max(max)

/** A job offer version as JSON, with amounts and times as decimal strings and nothing else in it. */
export const jobOfferVersionJson = z.strictObject({
  template: z.literal(JOB),
  supplier: text(BUSINESS_ID_MAX),
  work: z.strictObject({ kind: text(JOB_KIND_MAX), summary: text(JOB_SUMMARY_MAX) }),
  compute: z.strictObject({
    gpu: text(JOB_KIND_MAX),
    count: z.number().int(),
    region: text(JOB_KIND_MAX),
  }),
  currency: z.enum(CURRENCIES),
  price: u256,
  rules: z.strictObject({
    startAfter: u64,
    turnaround: u64,
    gracePeriod: u64,
    dailyCapacity: z.number().int(),
    lateCancellationBps: z.number().int(),
    noShowBps: z.number().int(),
  }),
})

/** Reads a job offer version from JSON, refusing one `jobOfferProblem` finds anything wrong with. */
export function parseJobOfferVersion(json: unknown): Parsed<JobOfferVersion> {
  const parsed = jobOfferVersionJson.safeParse(json)
  if (!parsed.success) return { ok: false, reason: 'message.invalid' }
  const version: JobOfferVersion = parsed.data
  return jobOfferProblem(version) === null
    ? { ok: true, value: version }
    : { ok: false, reason: 'message.invalid' }
}

/** The label a job offer version's id is hashed under, apart from a service offer's. */
export const JOB_OFFER_VERSION_LABEL = 'avow:offer:job/1'

/**
 * A job offer version with exactly its own fields, read from one that may hold more. The id is
 * over these and nothing else.
 */
export function jobOfferVersionFields(v: JobOfferVersion): JobOfferVersion {
  const { work, compute, rules: r } = v
  return {
    template: v.template,
    supplier: v.supplier,
    work: { kind: work.kind, summary: work.summary },
    compute: { gpu: compute.gpu, count: compute.count, region: compute.region },
    currency: v.currency,
    price: v.price,
    rules: {
      startAfter: r.startAfter,
      turnaround: r.turnaround,
      gracePeriod: r.gracePeriod,
      dailyCapacity: r.dailyCapacity,
      lateCancellationBps: r.lateCancellationBps,
      noShowBps: r.noShowBps,
    },
  }
}

/**
 * A job offer version's id: keccak256 of the ABI encoding of `avow:offer:job/1` and the version's
 * canonical JSON as a string. The label keeps it from ever equalling a service offer's id. It
 * throws for a version `jobOfferProblem` refuses rather than give one an id.
 */
export function jobOfferVersionId(v: JobOfferVersion): Hex {
  const problem = jobOfferProblem(v)
  if (problem) throw new RangeError(problem)
  return keccak256(
    encodeAbiParameters(
      [{ type: 'string' }, { type: 'string' }],
      [JOB_OFFER_VERSION_LABEL, canonicalJson(jobOfferVersionFields(v))],
    ),
  )
}

/** What one job of an offer version costs, in micros. */
export interface JobOfferQuote {
  /** The job's price, paid by a separate transfer on delivery. */
  price: bigint
  /** What a cancellation after the start can cost, the version's share of the price. */
  lateCancellation: bigint
  /** What not handing over the inputs can cost, the version's share of the price. */
  noShow: bigint
  /** The reserve the job takes, the larger of the two charges. */
  reserve: bigint
}

/** A share of a price, rounded up to the micro, so a charge is never less than its share. */
const shareOf = (price: bigint, bps: number) => (price * BigInt(bps) + BPS - 1n) / BPS

/**
 * What one job of an offer version costs. Each charge is its share of the price rounded up to the
 * micro, so a seller's mandate that sets a charge's lowest share passes every job a version at
 * that share builds. Throws for a version `jobOfferProblem` refuses.
 */
export function jobOfferQuote(v: JobOfferVersion): JobOfferQuote {
  const problem = jobOfferProblem(v)
  if (problem) throw new RangeError(problem)
  const lateCancellation = shareOf(v.price, v.rules.lateCancellationBps)
  const noShow = shareOf(v.price, v.rules.noShowBps)
  const reserve = lateCancellation > noShow ? lateCancellation : noShow
  return { price: v.price, lateCancellation, noShow, reserve }
}

/**
 * The job terms, in version 2's shape, for ordering one job of an offer version at `now`. Work
 * starts the version's `startAfter` after `now`, which ends free cancellation and is when the
 * supplier accepts by, and delivery is due its turnaround after the start. A late cancellation is
 * chargeable from the start and a no-show once the grace period has passed, each at its share of
 * the price. Charges can be reported until `JOB_OFFER_CHARGE_AFTER` past the delivery deadline,
 * when the reserve comes back, and the contest window is ten minutes. The arbiter and the day-90
 * share are the deployment's. The supplier's quote adds the compute booking the job relies on, as
 * version 3 terms. Throws for a version `jobOfferProblem` refuses, or a moment before 0 or after
 * `JOB_OFFER_BUILT_BY_MAX`, so every time it builds counts in a uint64 of seconds.
 */
export function jobOfferTerms(
  v: JobOfferVersion,
  now: bigint,
  settlement: { arbiter: Address; day90SupplierShareBps: number },
): JobTerms {
  const { lateCancellation, noShow } = jobOfferQuote(v)
  if (typeof now !== 'bigint' || now < 0n || now > JOB_OFFER_BUILT_BY_MAX) {
    throw new RangeError('A job is built from an offer at a moment from 0 to 2^40 seconds')
  }
  const startsAt = now + v.rules.startAfter
  const deliverBy = startsAt + v.rules.turnaround
  const chargeDeadline = deliverBy + JOB_OFFER_CHARGE_AFTER
  const terms = jobTerms({
    work: { kind: v.work.kind, summary: v.work.summary },
    compute: { gpu: v.compute.gpu, count: v.compute.count, region: v.compute.region },
    currency: v.currency,
    startsAt,
    deliverBy,
    price: v.price,
    lateCancellation,
    noShow,
    gracePeriod: v.rules.gracePeriod,
    chargeDeadline,
    contestWindow: JOB_OFFER_CONTEST_WINDOW,
    releaseDate: chargeDeadline,
    arbiter: settlement.arbiter,
    day90SupplierShareBps: settlement.day90SupplierShareBps,
  })
  // The version passed every rule above, so its terms pass the template's.
  const problem = validateJob(terms)
  if (problem) throw new Error(`The offer built terms its template refuses, ${problem}`)
  return terms
}

/**
 * Whether job terms are exactly the ones `jobOfferTerms` builds from this version, at the moment
 * their start implies, under their own arbiter and day-90 share. Version 3 terms are read without
 * the bookings they rely on, which the supplier's quote adds, so an order and its quote both
 * match. The terms name no version, so this says only that they match the one given.
 */
export function jobTermsMatchOffer(terms: JobTerms | ChainedJobTerms, v: JobOfferVersion): boolean {
  try {
    if (jobOfferProblem(v) !== null || terms.template !== JOB) return false
    const plain = terms.version === CHAINED_TERMS_VERSION ? plainTermsOf(terms) : terms
    const builtAt = terms.subject.startsAt - v.rules.startAfter
    const expected = jobOfferTerms(v, builtAt, {
      arbiter: terms.resolution.arbiter,
      day90SupplierShareBps: terms.resolution.day90SupplierShareBps,
    })
    return canonicalJson(expected) === canonicalJson(plain)
  } catch {
    return false
  }
}
