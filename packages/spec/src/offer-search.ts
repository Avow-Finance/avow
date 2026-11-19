import { z } from 'zod'
import { u64, u256 } from './json-fields.js'
import type { ReasonCode } from './reasons.js'
import {
  offerVersionId,
  SERVICE_QUANTITY_MAX,
  type ServiceOfferVersion,
  serviceOfferProblem,
  serviceOfferQuote,
  serviceOfferVersionJson,
} from './service.js'
import { CURRENCIES, type Currency } from './types.js'
import type { Parsed } from './wire.js'

/**
 * How an agent finds offers in Avow's directory, and how Avow answers. The agent sends an
 * `OfferSearch` to `SANDBOX_PATHS.offerSearch`, signed by its key under its business's lock. Avow
 * answers with the listed offers that fit the search, the ones the agent's mandate allows first.
 * When the agent asks, the ones its mandate doesn't allow yet follow in their own group, each with
 * what its administrator would have to change, so an agent can find a new supplier and ask for it.
 *
 * A result grants nothing. Booking an offer checks the agent's mandate and funds again, and Avow
 * refuses a version that was replaced (`offer.superseded`) or withdrawn (`offer.withdrawn`) since
 * the search. Each group is ordered by `OFFER_RANKING`, and an agent can check Avow kept to it with
 * `offerSearchResultProblem`.
 */

/**
 * The rule that orders each group of results. The lowest total price for the quantity comes first,
 * then the soonest delivery, then the lowest version id, so equal offers always list the same way.
 * Every offer in a result is in the search's currency, so totals compare directly. The reserve an
 * offer takes shows beside its price and doesn't change its place.
 */
export const OFFER_RANKING = 'total-then-delivery' as const

/** The longest a search's words may be, in characters. */
export const OFFER_QUERY_MAX = 200

/** The most offers Avow lists in each group of a result. */
export const OFFER_RESULTS_MAX = 50

/**
 * The reasons a mandate refuses an offer that its administrator can lift by approving a new
 * mandate or daily limit. An offer refused for any other reason isn't listed at all.
 */
export const APPROVAL_NEEDS = [
  'mandate.supplier_not_allowed',
  'mandate.category_not_allowed',
  'mandate.over_commitment_cap',
  'mandate.over_open_reserves_cap',
  'mandate.over_payment_limit',
  'mandate.ends_before_window',
] as const satisfies readonly ReasonCode[]
export type ApprovalNeed = (typeof APPROVAL_NEEDS)[number]

/** What an agent is looking for and what it can spend. */
export interface OfferSearch {
  /**
   * Words that only filter. The query splits on whitespace, and each word has to appear somewhere
   * in the item's name or summary, in any case. Null lists every offer that fits the rest, and a
   * blank query reads as null.
   */
  query: string | null
  /** The most the agent will pay for the whole booking, in micros of `currency`. */
  budget: bigint
  currency: Currency
  /** How many units the agent would book. */
  quantity: number
  /** The latest the agent needs delivery, in unix seconds, or null when any time will do. */
  deliverBy: bigint | null
  /** Whether to list the offers the agent's mandate doesn't allow yet. */
  needingApproval: boolean
}

/** One offer a search found. */
export interface OfferMatch {
  /** The version Avow would book, whose `supplier` is the supplier's business id. */
  version: ServiceOfferVersion
  /**
   * The supplier's name as its profile gives it. Every supplier listed today is a sandbox business
   * that no check has verified, and the result says so on each one.
   */
  supplier: { name: string; sandbox: true }
  /** Nothing for an offer the agent's mandate allows, or what its administrator would change. */
  needs: ApprovalNeed[]
}

/** Avow's answer to a search. */
export interface OfferSearchResult {
  ranking: typeof OFFER_RANKING
  /** When Avow checked the offers against the agent's mandate and funds, in unix seconds. */
  checkedAt: bigint
  /** The offers the agent's mandate allows now. */
  eligible: OfferMatch[]
  /** The offers it doesn't allow yet, listed only when the search asked for them. */
  needingApproval: OfferMatch[]
}

const words = (query: string | null) =>
  query === null ? [] : query.toLowerCase().split(/\s+/).filter(Boolean)

/**
 * Whether an offer version fits a search at `now`, leaving the agent's mandate aside. It's in the
 * search's currency, its item has every word of the query, it takes the quantity, its total for
 * that quantity is within the budget, and booked at `now` it delivers by the search's deadline.
 */
export function offerFits(search: OfferSearch, version: ServiceOfferVersion, now: bigint): boolean {
  if (serviceOfferProblem(version) !== null || version.currency !== search.currency) return false
  const text = `${version.item.name} ${version.item.summary}`.toLowerCase()
  if (!words(search.query).every((w) => text.includes(w))) return false
  if (search.quantity > version.rules.maxPerBooking) return false
  let total: bigint
  try {
    total = serviceOfferQuote(version, search.quantity).total
  } catch {
    return false
  }
  if (total > search.budget) return false
  return search.deliverBy === null || now + version.rules.leadTime <= search.deliverBy
}

/** Orders offers by `OFFER_RANKING` for a quantity, returning a new array. */
export function rankOffers<T extends { version: ServiceOfferVersion }>(
  quantity: number,
  offers: readonly T[],
): T[] {
  const keyed = offers.map((offer) => ({
    offer,
    total: serviceOfferQuote(offer.version, quantity).total,
    leadTime: offer.version.rules.leadTime,
    id: offerVersionId(offer.version),
  }))
  keyed.sort((a, b) => {
    if (a.total !== b.total) return a.total < b.total ? -1 : 1
    if (a.leadTime !== b.leadTime) return a.leadTime < b.leadTime ? -1 : 1
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  return keyed.map((k) => k.offer)
}

const sameOrder = (quantity: number, matches: readonly OfferMatch[]) =>
  rankOffers(quantity, matches).every((m, i) => m === matches[i])

/**
 * What's wrong with Avow's answer to a search, in words, or null when nothing is. Every offer fits
 * the search at the time Avow checked it, each group keeps to the ranking and to
 * `OFFER_RESULTS_MAX`, no version lists twice, an eligible offer needs nothing, an offer needing
 * approval names what, and offers needing approval appear only when the search asked for them.
 */
export function offerSearchResultProblem(
  search: OfferSearch,
  result: OfferSearchResult,
): string | null {
  const all = [...result.eligible, ...result.needingApproval]
  if (!all.every((m) => offerFits(search, m.version, result.checkedAt))) {
    return "An offer doesn't fit the search."
  }
  if (new Set(all.map((m) => offerVersionId(m.version))).size !== all.length) {
    return 'An offer is listed twice.'
  }
  if (result.eligible.some((m) => m.needs.length > 0)) return 'An eligible offer needs approval.'
  if (result.needingApproval.some((m) => m.needs.length === 0)) {
    return "An offer needing approval doesn't say what for."
  }
  if (!search.needingApproval && result.needingApproval.length > 0) {
    return "Offers needing approval are listed though the search didn't ask for them."
  }
  if (
    result.eligible.length > OFFER_RESULTS_MAX ||
    result.needingApproval.length > OFFER_RESULTS_MAX
  ) {
    return `A group lists more than ${OFFER_RESULTS_MAX} offers.`
  }
  if (
    !sameOrder(search.quantity, result.eligible) ||
    !sameOrder(search.quantity, result.needingApproval)
  ) {
    return "A group isn't in the ranking's order."
  }
  return null
}

/** A search as JSON. Words, quantity, deadline and the group needing approval may be left out. */
export const offerSearchJson = z.strictObject({
  query: z.string().max(OFFER_QUERY_MAX).optional(),
  budget: u256,
  currency: z.enum(CURRENCIES),
  quantity: z.number().int().min(1).max(SERVICE_QUANTITY_MAX).optional(),
  deliverBy: u64.optional(),
  needingApproval: z.boolean().optional(),
})

/**
 * Reads a search from JSON. Words left out, empty or only whitespace all read as no words, which
 * lists every offer, and the quantity defaults to 1.
 */
export function parseOfferSearch(json: unknown): Parsed<OfferSearch> {
  const parsed = offerSearchJson.safeParse(json)
  if (!parsed.success || parsed.data.budget === 0n) return { ok: false, reason: 'message.invalid' }
  const { query, budget, currency, quantity, deliverBy, needingApproval } = parsed.data
  return {
    ok: true,
    value: {
      query: query === undefined || query.trim() === '' ? null : query.trim(),
      budget,
      currency,
      quantity: quantity ?? 1,
      deliverBy: deliverBy ?? null,
      needingApproval: needingApproval ?? false,
    },
  }
}

const offerMatchJson = z.strictObject({
  version: serviceOfferVersionJson,
  supplier: z.strictObject({ name: z.string().min(1).max(120), sandbox: z.literal(true) }),
  needs: z.array(z.enum(APPROVAL_NEEDS)).max(APPROVAL_NEEDS.length),
})

/** Avow's answer to a search as JSON, with amounts and times as decimal strings. */
export const offerSearchResultJson = z.strictObject({
  ranking: z.literal(OFFER_RANKING),
  checkedAt: u64,
  eligible: z.array(offerMatchJson).max(OFFER_RESULTS_MAX),
  needingApproval: z.array(offerMatchJson).max(OFFER_RESULTS_MAX),
})

/**
 * Reads Avow's answer to a search from JSON, refusing one whose shape is wrong, whose versions
 * `serviceOfferProblem` refuses, or that lists a reason twice for one offer. Whether it answers the
 * search that was sent is `offerSearchResultProblem`'s to say.
 */
export function parseOfferSearchResult(json: unknown): Parsed<OfferSearchResult> {
  const parsed = offerSearchResultJson.safeParse(json)
  if (!parsed.success) return { ok: false, reason: 'message.invalid' }
  const result: OfferSearchResult = parsed.data
  const matches = [...result.eligible, ...result.needingApproval]
  const sound = matches.every(
    (m) => serviceOfferProblem(m.version) === null && new Set(m.needs).size === m.needs.length,
  )
  return sound ? { ok: true, value: result } : { ok: false, reason: 'message.invalid' }
}
