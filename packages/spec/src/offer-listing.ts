import type { Hex } from 'viem'
import { z } from 'zod'
import { type JobOfferVersion, jobOfferVersionJson } from './job-offer.js'
import { bytes32, u64 } from './json-fields.js'
import {
  isJobOfferVersion,
  type OfferVersion,
  offerIdOf,
  offerItemOf,
  offerVersionProblem,
} from './offer-version.js'
import { type ServiceOfferVersion, serviceOfferVersionJson } from './service.js'
import { OFFER_LISTING_JOB_VERSION } from './version.js'
import type { Parsed } from './wire.js'

/**
 * How a selling agent lists its offers with Avow, for the directory a buying agent searches with
 * an `OfferSearch`, which Avow doesn't answer yet. The agent sends each version it means to sell to
 * `SANDBOX_PATHS.offerListings`, signed by its signing key under its business's lock, and Avow
 * checks it against the agent's newest seller's mandate with `sellerOfferProblem` before it holds
 * it. Avow refuses a version the mandate doesn't allow, and holds nothing for it. A version is a
 * service's or a job's, and a job priced where the mandate asks a person to decide is refused, since
 * nothing lets a person approve a job's sale yet.
 *
 * A service's listing is version 1, as it was before jobs listed, and a job's is version 2, which
 * says so in its `schemaVersion`, as `OFFER_LISTING_JOB_VERSION`. `offerListingRequestOf` builds the
 * body for either kind, and a reader refuses a job without the field or a service with it.
 *
 * An item has one current version, named by `offerItemOf` as its category and name, so a service
 * and a job that share a name are two items. A new version of an item replaces the one Avow held
 * for it, and the agent withdraws an item's current version at
 * `SANDBOX_PATHS.offerWithdrawals`. Versions only move forward, so a version once replaced or
 * withdrawn is never current again. Listing it again is refused by name as `offer.superseded` or
 * `offer.withdrawn`, the same reasons a booking of it hears, so a buyer told a version was
 * replaced never finds it current later.
 *
 * A listing grants nothing. It says Avow found the version within the seller's mandate when it was
 * listed, and the mandate can be replaced, end or be revoked after that, so a search and a sale
 * each check again. Every supplier that lists is a sandbox business, and nothing here says any
 * check verified it.
 */

/** The most items one business keeps listed at once, each with its one current version. */
export const OFFER_LISTINGS_MAX = 100

/**
 * The body that lists one offer version with Avow, which names the listing agent's own business as
 * its supplier: a service's at version 1, or a job's at version 2.
 */
export type OfferListingRequest =
  | { version: ServiceOfferVersion }
  | { schemaVersion: typeof OFFER_LISTING_JOB_VERSION; version: JobOfferVersion }

/** The body that lists a version, at the schema version its kind takes. */
export const offerListingRequestOf = (version: OfferVersion): OfferListingRequest =>
  isJobOfferVersion(version) ? { schemaVersion: OFFER_LISTING_JOB_VERSION, version } : { version }

/** The body that withdraws an item's current version from Avow's directory. */
export interface OfferWithdrawalRequest {
  /** The id of the version to withdraw, which has to be its item's current version. */
  id: Hex
}

/** The body of a selling agent's read of its business's listings, which is an empty object. */
export type OfferListingsRequest = Record<string, never>

/** What every listing carries beside its version. */
export interface OfferListingFields {
  /** The version's id, as `offerIdOf` gives it under its kind's own label. */
  id: Hex
  /** When Avow first listed it, in unix seconds by its own clock. */
  listedAt: bigint
  /**
   * The seller's mandate Avow checked the version against when it listed it, as
   * `sellerMandateHash` gives it. It says which mandate allowed the listing then, and nothing
   * about the mandate in force later.
   */
  sellerMandate: Hex
  /** The id of the version it replaced as its item's current version, or null for none. */
  replaced: Hex | null
}

/**
 * An offer version Avow holds as its item's current version: a service's at version 1, or a job's
 * at version 2.
 */
export type OfferListing =
  | (OfferListingFields & { version: ServiceOfferVersion })
  | (OfferListingFields & {
      schemaVersion: typeof OFFER_LISTING_JOB_VERSION
      version: JobOfferVersion
    })

/** A listing of a version, at the schema version its kind takes. */
export const offerListingOf = (fields: OfferListingFields, version: OfferVersion): OfferListing =>
  isJobOfferVersion(version)
    ? { ...fields, schemaVersion: OFFER_LISTING_JOB_VERSION, version }
    : { ...fields, version }

/** Avow's answer to a withdrawal. */
export interface OfferWithdrawal {
  /** The id of the version withdrawn. */
  id: Hex
  /** When Avow withdrew it, in unix seconds by its own clock. */
  withdrawnAt: bigint
}

/** Every current listing of the business, oldest first. */
export interface OfferListings {
  listed: OfferListing[]
}

const jobListing = { schemaVersion: z.literal(OFFER_LISTING_JOB_VERSION) }

export const offerListingRequestJson = z.union([
  z.strictObject({ version: serviceOfferVersionJson }),
  z.strictObject({ ...jobListing, version: jobOfferVersionJson }),
])

export const offerWithdrawalRequestJson = z.strictObject({ id: bytes32 })

export const offerListingsRequestJson = z.strictObject({})

const listingFields = {
  id: bytes32,
  listedAt: u64,
  sellerMandate: bytes32,
  replaced: bytes32.nullable(),
}

export const offerListingJson = z.union([
  z.strictObject({ ...listingFields, version: serviceOfferVersionJson }),
  z.strictObject({ ...listingFields, ...jobListing, version: jobOfferVersionJson }),
])

export const offerWithdrawalJson = z.strictObject({ id: bytes32, withdrawnAt: u64 })

export const offerListingsJson = z.strictObject({
  listed: z.array(offerListingJson).max(OFFER_LISTINGS_MAX),
})

const invalid = { ok: false, reason: 'message.invalid' } as const

/** An offer version already read from JSON, or null for one its own rules refuse. */
const soundVersion = (version: OfferVersion): OfferVersion | null =>
  offerVersionProblem(version) === null ? version : null

/** The key an item's one current version is held under, its category and name. */
export const offerItemKey = (v: OfferVersion): string => {
  const { category, name } = offerItemOf(v)
  return JSON.stringify([category, name])
}

/** Reads a value that may be anything, and answers `message.invalid` for one that throws when read. */
function reading<T>(read: () => Parsed<T>): Parsed<T> {
  try {
    return read()
  } catch {
    return invalid
  }
}

/**
 * Parses the body that lists an offer version of either kind. The version has to be one
 * `offerVersionProblem` passes. Whether it names the listing agent's business is the caller's to
 * check. It never throws.
 */
export function parseOfferListingRequest(json: unknown): Parsed<OfferListingRequest> {
  return reading(() => {
    const parsed = offerListingRequestJson.safeParse(json)
    const version = parsed.success ? soundVersion(parsed.data.version) : null
    return version ? { ok: true, value: offerListingRequestOf(version) } : invalid
  })
}

/** Parses the body that withdraws a version. Its id comes back in lower case. It never throws. */
export function parseOfferWithdrawalRequest(json: unknown): Parsed<OfferWithdrawalRequest> {
  return reading(() => {
    const parsed = offerWithdrawalRequestJson.safeParse(json)
    return parsed.success ? { ok: true, value: { id: parsed.data.id } } : invalid
  })
}

/** Parses the body of a selling agent's read of its listings. It never throws. */
export function parseOfferListingsRequest(json: unknown): Parsed<OfferListingsRequest> {
  return reading(() => {
    const parsed = offerListingsRequestJson.safeParse(json)
    return parsed.success ? { ok: true, value: {} } : invalid
  })
}

const listingOf = (data: z.output<typeof offerListingJson>): OfferListing | null => {
  const version = soundVersion(data.version)
  if (!version || offerIdOf(version) !== data.id) return null
  // A listing that replaced none says null, so naming itself would say a thing no listing can.
  if (data.replaced === data.id) return null
  const { id, listedAt, sellerMandate, replaced } = data
  return offerListingOf({ id, listedAt, sellerMandate, replaced }, version)
}

/**
 * Parses Avow's answer to a listing. Its id has to be the id of the version it carries, and it
 * can't name itself as the version it replaced. Hashes come back in lower case. It never throws.
 */
export function parseOfferListing(json: unknown): Parsed<OfferListing> {
  return reading(() => {
    const parsed = offerListingJson.safeParse(json)
    const listing = parsed.success ? listingOf(parsed.data) : null
    return listing ? { ok: true, value: listing } : invalid
  })
}

/** Parses Avow's answer to a withdrawal. Its id comes back in lower case. It never throws. */
export function parseOfferWithdrawal(json: unknown): Parsed<OfferWithdrawal> {
  return reading(() => {
    const parsed = offerWithdrawalJson.safeParse(json)
    return parsed.success ? { ok: true, value: parsed.data } : invalid
  })
}

/**
 * Parses a business's listings. Each has to read as `parseOfferListing` reads one, and no two can
 * be the same version or the same item, by `offerItemOf`, since an item has one current version. It
 * never throws.
 */
export function parseOfferListings(json: unknown): Parsed<OfferListings> {
  return reading(() => {
    const parsed = offerListingsJson.safeParse(json)
    if (!parsed.success) return invalid
    const listed: OfferListing[] = []
    for (const data of parsed.data.listed) {
      const listing = listingOf(data)
      if (!listing) return invalid
      listed.push(listing)
    }
    const items = new Set(listed.map((l) => offerItemKey(l.version)))
    const ids = new Set(listed.map((l) => l.id))
    if (items.size !== listed.length || ids.size !== listed.length) return invalid
    return { ok: true, value: { listed } }
  })
}
