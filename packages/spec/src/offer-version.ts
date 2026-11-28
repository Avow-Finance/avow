import type { Hex } from 'viem'
import { z } from 'zod'
import { JOB_CATEGORY, JOB_KIND_MAX } from './job.js'
import {
  type JobOfferVersion,
  jobOfferProblem,
  jobOfferVersionId,
  jobOfferVersionJson,
} from './job-offer.js'
import type { SellerCategory } from './seller-mandate.js'
import {
  offerVersionId,
  SERVICE_CATEGORY,
  SERVICE_NAME_MAX,
  type ServiceOfferVersion,
  serviceOfferProblem,
  serviceOfferVersionJson,
} from './service.js'
import { isPlainText } from './text.js'
import type { Parsed } from './wire.js'

/**
 * Any offer version a seller can publish: a service's, which has no `template` field, or a job's,
 * which names `job/1` as its template. Each keeps its own fields, rules and id, and this module
 * only tells them apart, so whatever carries offers of either kind reads them in one place.
 */
export type OfferVersion = ServiceOfferVersion | JobOfferVersion

/** Whether an offer version is a job's. A service's version has no template field. */
export const isJobOfferVersion = (v: OfferVersion): v is JobOfferVersion => 'template' in v

/**
 * Either kind of offer version as JSON. A job's carries its template and a service's has none, and
 * each object is strict, so no JSON reads as both.
 */
export const offerVersionJson = z.union([serviceOfferVersionJson, jobOfferVersionJson])

/** What's wrong with an offer version of either kind, in words for the person setting it. */
export function offerVersionProblem(v: OfferVersion): string | null {
  if (typeof v !== 'object' || v === null) return 'Set an offer.'
  return isJobOfferVersion(v) ? jobOfferProblem(v) : serviceOfferProblem(v)
}

/** Reads an offer version of either kind from JSON, refusing one its own rules refuse. */
export function parseOfferVersion(json: unknown): Parsed<OfferVersion> {
  const parsed = offerVersionJson.safeParse(json)
  if (!parsed.success) return { ok: false, reason: 'message.invalid' }
  const version: OfferVersion = parsed.data
  return offerVersionProblem(version) === null
    ? { ok: true, value: version }
    : { ok: false, reason: 'message.invalid' }
}

/**
 * An offer version's id under its own label, so a service's and a job's never collide. Throws for
 * a version its rules refuse.
 */
export const offerIdOf = (v: OfferVersion): Hex =>
  isJobOfferVersion(v) ? jobOfferVersionId(v) : offerVersionId(v)

/**
 * The item a seller's mandate reads of an offer version: a service's name, or a job's kind of
 * work, under its category. Two versions are the same item only when both match, since a service
 * and a job may share a name.
 */
export const offerItemOf = (v: OfferVersion): { category: SellerCategory; name: string } =>
  isJobOfferVersion(v)
    ? { category: JOB_CATEGORY, name: v.work.kind }
    : { category: SERVICE_CATEGORY, name: v.item.name }

/**
 * Whether an offer version's item is named in plain text on one line, by `isPlainText`. Avow lists
 * an offer where other businesses' agents read its name, so it lists none whose name could pose as
 * a line it wrote or reorder the words after it. A job's kind of work is held to this already.
 */
export const offerItemNameIsPlain = (v: OfferVersion): boolean =>
  isPlainText(offerItemOf(v).name, isJobOfferVersion(v) ? JOB_KIND_MAX : SERVICE_NAME_MAX)
