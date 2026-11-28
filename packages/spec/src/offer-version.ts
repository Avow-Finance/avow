import type { Hex } from 'viem'
import { z } from 'zod'
import { JOB_CATEGORY } from './job.js'
import {
  type JobOfferVersion,
  jobOfferProblem,
  jobOfferQuote,
  jobOfferVersionId,
  jobOfferVersionJson,
} from './job-offer.js'
import type { SellerCategory } from './seller-mandate.js'
import {
  offerVersionId,
  SERVICE_CATEGORY,
  type ServiceOfferQuote,
  type ServiceOfferVersion,
  serviceOfferProblem,
  serviceOfferQuote,
  serviceOfferVersionJson,
} from './service.js'
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
 * What booking a quantity of an offer version costs, with each charge and the reserve it takes. A
 * service's total is its unit price times the quantity, as `serviceOfferQuote` gives it. A job is
 * one unit, so its total is its price and its charges are `jobOfferQuote`'s.
 */
export type OfferQuote = ServiceOfferQuote

/**
 * What booking `quantity` units of an offer version costs, for either kind. Throws for a version
 * its rules refuse, or a quantity it doesn't take, which for a job is anything but 1.
 */
export function offerQuote(v: OfferVersion, quantity: number): OfferQuote {
  if (!isJobOfferVersion(v)) return serviceOfferQuote(v, quantity)
  if (quantity !== 1) throw new RangeError('A job offer takes one job a booking')
  const { price, lateCancellation, noShow, reserve } = jobOfferQuote(v)
  return { total: price, lateCancellation, noShow, reserve }
}

/**
 * How long after booking an offer version delivers, in seconds: a service's lead time, or a job's
 * start plus its turnaround.
 */
export const offerDeliveryAfter = (v: OfferVersion): bigint =>
  isJobOfferVersion(v) ? v.rules.startAfter + v.rules.turnaround : v.rules.leadTime

/**
 * The words that describe an offer version's item, a service's name and summary or a job's kind
 * of work and summary.
 */
export const offerTextOf = (v: OfferVersion): string =>
  isJobOfferVersion(v) ? `${v.work.kind} ${v.work.summary}` : `${v.item.name} ${v.item.summary}`
