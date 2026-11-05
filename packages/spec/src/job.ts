import type { Address } from 'viem'
import type { Dependencies } from './dependencies.js'
import { type GpuSubject, gpuSubjectProblem } from './gpu-reservation.js'
import type { ReasonCode } from './reasons.js'
import {
  AMOUNT_DECIMALS,
  CHAINED_TERMS_VERSION,
  type ChainedTermsOf,
  type Currency,
  DEPENDENCY_CHECKS_ALLOWED,
  type DependencyChecksOf,
  type RemedyCharge,
  TERMS_VERSION,
  type TermsOf,
} from './types.js'

/**
 * A job, a piece of work a supplier does for a customer by a deadline, on GPU capacity it booked
 * from someone else. Its meaning is fixed, and a change of meaning would be `job/2`.
 *
 * A job always relies on a booking of that capacity, so its terms are version 3 and name it in
 * their dependencies section. Version 2 terms under this template are refused as
 * `dependency.required`, by the customer and by Avow alike.
 *
 * The customer's reserve backs only what the customer owes if it walks away, which the lock's two
 * charge kinds express. A late cancellation is chargeable once work has started, and a no-show
 * once the customer hasn't handed over the work's inputs by the end of the grace period. The job's
 * price is the consideration, which the lock never reads. It arrives as a separate transfer on
 * delivery, and the reserve doesn't secure it.
 */
export const JOB = 'job/1' as const

/**
 * The mandate category every job falls under, which its terms agreement and reserve request name.
 * A customer's mandate allows jobs by naming it, and job terms under any other category are refused
 * as `terms.category_mismatch`.
 */
export const JOB_CATEGORY = 'compute-job' as const

/** The longest `work.kind` a job names. */
export const JOB_KIND_MAX = 64

/** The longest `work.summary` a job names. */
export const JOB_SUMMARY_MAX = 280

/** What a job promises: the work, the GPU capacity it runs on, and when it runs. */
export interface JobSubject {
  /** The work, with a short name such as `fine-tuning` and one sentence on what gets done. */
  work: { kind: string; summary: string }
  /** The GPU capacity the work runs on, which a booking the job relies on has to hold. */
  compute: { gpu: string; count: number; region: string }
  /** When work starts. The customer's free cancellation ends here, and its inputs are due. */
  startsAt: bigint
  /** When the result is delivered by. The booking relied on has to hold the capacity until then. */
  deliverBy: bigint
}

/** Job terms as version 2 shapes them, the form a customer proposes before compute is named. */
export type JobTerms = TermsOf<JobSubject, typeof JOB>

/**
 * Version 3 job terms, which name the booking of the compute the job runs on. The customer checks
 * that booking itself, so a job's terms always say `buyer` checks. The `avow` setting promises to
 * hide the booking from the buyer, which a job can't keep, since the customer gets its terms in
 * full and a link to verify a job shows the booking.
 */
export type ChainedJobTerms = Omit<ChainedTermsOf<JobSubject, typeof JOB>, 'dependencyCheck'> & {
  dependencyCheck: JobDependencyCheck
}

/** Who checks a job's compute, the one setting `DEPENDENCY_CHECKS_ALLOWED` gives a job. */
export type JobDependencyCheck = DependencyChecksOf<typeof JOB>
const [JOB_DEPENDENCY_CHECK] = DEPENDENCY_CHECKS_ALLOWED[JOB]

/** What a job states, in micros and unix seconds, before the template builds its terms. */
export interface JobInput {
  work: JobSubject['work']
  compute: JobSubject['compute']
  currency: Currency
  startsAt: bigint
  deliverBy: bigint
  /** The last moment the supplier can accept the customer's reserve, the start when left out. */
  acceptBy?: bigint
  /** The job's price, paid by a separate transfer on delivery. The reserve doesn't secure it. */
  price: bigint
  /** The most the supplier can charge when the customer cancels after work has started. */
  lateCancellation: bigint
  /** The most the supplier can charge when the customer doesn't hand over the work's inputs. */
  noShow: bigint
  /** How long after the start the customer can still hand over the inputs before it's a no-show. */
  gracePeriod: bigint
  chargeDeadline: bigint
  contestWindow: bigint
  releaseDate: bigint
  arbiter: Address
  day90SupplierShareBps: number
}

/**
 * Builds job terms in version 2's shape, which `chainedTerms` turns into version 3 terms naming
 * the compute booking. Free cancellation ends when work starts, a late cancellation is chargeable
 * from then, and a no-show once the grace period after the start has passed. A charge set to zero
 * is left out, and the reserve is the largest charge.
 */
export function jobTerms(input: JobInput): JobTerms {
  const charges: RemedyCharge[] = []
  if (input.lateCancellation > 0n) {
    charges.push({
      kind: 'lateCancellation',
      amount: input.lateCancellation,
      earliest: input.startsAt,
    })
  }
  if (input.noShow > 0n) {
    charges.push({
      kind: 'noShow',
      amount: input.noShow,
      earliest: input.startsAt + input.gracePeriod,
    })
  }
  const reserve = input.lateCancellation > input.noShow ? input.lateCancellation : input.noShow
  return {
    version: TERMS_VERSION,
    template: JOB,
    currency: input.currency,
    amountDecimals: AMOUNT_DECIMALS,
    subject: {
      work: { ...input.work },
      compute: { ...input.compute },
      startsAt: input.startsAt,
      deliverBy: input.deliverBy,
    },
    consideration: { kind: 'fixed', amount: input.price },
    remedies: {
      acceptBy: input.acceptBy ?? input.startsAt,
      freeCancelBy: input.startsAt,
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

/** Version 3 job terms that rely on the compute bookings given, which the customer checks. */
export function chainedJobTerms(terms: JobTerms, dependencies: Dependencies): ChainedJobTerms {
  return {
    ...terms,
    version: CHAINED_TERMS_VERSION,
    dependencyCheck: JOB_DEPENDENCY_CHECK,
    dependencies,
  }
}

const isText = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max

/**
 * What's wrong with a job's subject on its own, or null when nothing is. The work has a kind and a
 * summary of bounded length, the compute names a GPU, a positive count and a region, and the start
 * and deadline are whole numbers (`terms.template_invalid`). Work starts before its deadline
 * (`terms.deadlines_out_of_order`). A subject of any other shape is refused here, so nothing that
 * reads it after this throws.
 */
export function jobSubjectProblem(s: JobSubject): ReasonCode | null {
  if (typeof s !== 'object' || s === null) return 'terms.template_invalid'
  const work: Partial<JobSubject['work']> | undefined = s.work
  const compute: Partial<JobSubject['compute']> | undefined = s.compute
  if (typeof work !== 'object' || work === null) return 'terms.template_invalid'
  if (typeof compute !== 'object' || compute === null) return 'terms.template_invalid'
  if (!isText(work.kind, JOB_KIND_MAX) || !isText(work.summary, JOB_SUMMARY_MAX)) {
    return 'terms.template_invalid'
  }
  if (!isText(compute.gpu, JOB_KIND_MAX) || !isText(compute.region, JOB_KIND_MAX)) {
    return 'terms.template_invalid'
  }
  if (!Number.isSafeInteger(compute.count) || (compute.count as number) <= 0) {
    return 'terms.template_invalid'
  }
  if (typeof s.startsAt !== 'bigint' || typeof s.deliverBy !== 'bigint') {
    return 'terms.template_invalid'
  }
  return s.startsAt < s.deliverBy ? null : 'terms.deadlines_out_of_order'
}

/**
 * The template's own rules, which a reader checks after the core's. The subject passes
 * `jobSubjectProblem` and the consideration is one fixed price above zero. Free cancellation ends
 * exactly when work starts, the supplier accepts by then, and the deadline falls by the charge
 * deadline. A late cancellation is chargeable from the start, and a no-show from the start or
 * later.
 */
export function validateJob(
  t: Pick<JobTerms, 'subject' | 'consideration' | 'remedies'>,
): ReasonCode | null {
  const { subject: s, remedies: r, consideration: c } = t
  const subject = jobSubjectProblem(s)
  if (subject === 'terms.template_invalid') return subject
  if (c.kind !== 'fixed' || c.amount <= 0n) return 'terms.template_invalid'
  if (subject) return subject
  if (r.freeCancelBy !== s.startsAt) return 'terms.template_invalid'
  if (r.acceptBy > s.startsAt || s.deliverBy > r.chargeDeadline) {
    return 'terms.deadlines_out_of_order'
  }
  for (const charge of r.charges) {
    if (charge.kind === 'lateCancellation' && charge.earliest !== s.startsAt) {
      return 'terms.template_invalid'
    }
    if (charge.kind === 'noShow' && charge.earliest < s.startsAt) {
      return 'terms.deadlines_out_of_order'
    }
  }
  return null
}

/**
 * Whether a job fits inside a GPU reservation it relies on. The reservation holds the same GPU in
 * the same region, at least as many of them, from the job's start until its deadline. Each pair is
 * judged on its own, so two jobs that each fit inside the same reservation both pass. A subject
 * either template refuses fits nowhere.
 */
export function jobFitsReservation(job: JobSubject, reservation: GpuSubject): boolean {
  if (jobSubjectProblem(job) || gpuSubjectProblem(reservation)) return false
  const need = job.compute
  const held = reservation.resource
  return (
    need.gpu === held.gpu &&
    need.region === held.region &&
    need.count <= held.count &&
    job.startsAt >= reservation.windowStart &&
    job.deliverBy <= reservation.windowStart + reservation.windowDuration
  )
}
