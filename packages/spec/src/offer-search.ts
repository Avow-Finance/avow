import type { Hex } from 'viem'
import { z } from 'zod'
import { API_REQUEST_MAX_VALIDITY } from './api-request.js'
import { bytes32, u64, u256 } from './json-fields.js'
import type { ReasonCode } from './reasons.js'
import {
  offerVersionId,
  SERVICE_NAME_MAX,
  SERVICE_QUANTITY_MAX,
  type ServiceOfferQuote,
  type ServiceOfferVersion,
  serviceOfferProblem,
  serviceOfferQuote,
  serviceOfferVersionJson,
} from './service.js'
import { isFilled } from './text.js'
import { CURRENCIES, type Currency } from './types.js'
import type { Parsed } from './wire.js'

/**
 * How an agent finds offers in Avow's directory, and how Avow answers. The agent sends an
 * `OfferSearch` to `SANDBOX_PATHS.offerSearch`, signed by its key under its business's lock. Avow
 * answers with an `OfferSearchResult` holding the listed offers that fit the search, the ones the
 * agent's mandate allows first. When the agent asks, the ones its mandate doesn't allow yet follow
 * in their own group, each with what its administrator would have to change, so an agent can find
 * a new supplier and ask for it.
 *
 * A result grants nothing. Booking an offer checks the agent's mandate and funds again, and Avow
 * refuses a version that was replaced (`offer.superseded`) or withdrawn (`offer.withdrawn`) since
 * the search. Avow builds its answer with `offerSearchResult`, `parseOfferSearchResult` refuses an
 * answer that isn't consistent with the search it echoes, and `offerSearchAnswerProblem` lets the
 * agent check the answer is to its own search, its current mandate and the present moment.
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
 * The refusals of the mandate check that an administrator can lift, by approving a new mandate or
 * daily limit, or by approving the booking itself where the mandate asks a person to approve
 * bookings above an amount. An offer the check refuses for any other reason isn't listed.
 */
export const APPROVAL_NEEDS = [
  'approval.human_required',
  'mandate.supplier_not_allowed',
  'mandate.category_not_allowed',
  'mandate.over_commitment_cap',
  'mandate.over_open_reserves_cap',
  'mandate.over_payment_limit',
  'mandate.over_price_limit',
  'mandate.ends_before_window',
] as const satisfies readonly ReasonCode[]
export type ApprovalNeed = (typeof APPROVAL_NEEDS)[number]

/** What an agent is looking for and what it can spend. */
export interface OfferSearch {
  /**
   * Words that only filter. The query splits on whitespace, and each word has to appear somewhere
   * in the item's name or summary, in any case, including inside a longer word. Null lists every
   * offer that fits the rest, and a blank query reads as null.
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

/** One offer a search found, priced for the search's quantity. */
export interface OfferMatch {
  /** The version's id, which `offerVersionId` gives and a booking names. */
  id: Hex
  /** The version Avow would book, whose `supplier` is the supplier's business id. */
  version: ServiceOfferVersion
  /**
   * The supplier's name as its profile gives it. Every supplier listed today is a sandbox business
   * that no check has verified, and the result says so on each one.
   */
  supplier: { name: string; sandbox: true }
  /** What booking the search's quantity costs, with each charge and the reserve it takes. */
  quote: ServiceOfferQuote
  /** When delivery would be due if the agent had booked when Avow checked, in unix seconds. */
  deliverBy: bigint
}

/** An offer the agent's mandate doesn't allow yet. */
export interface OfferNeedingApproval extends OfferMatch {
  /**
   * The first thing the mandate check refuses the offer for. It may not be the only one, so a
   * change the administrator approves can bring up another.
   */
  need: ApprovalNeed
}

/** One group of results, in ranking order, and whether more fitted than the group lists. */
export interface OfferGroup<T extends OfferMatch> {
  offers: T[]
  more: boolean
}

/** Avow's answer to a search. */
export interface OfferSearchResult {
  /** The search it answers, with what it left out filled in. */
  search: OfferSearch
  ranking: typeof OFFER_RANKING
  /** When Avow checked the offers against the agent's mandate and funds, in unix seconds. */
  checkedAt: bigint
  /** The mandate the offers were checked against, as `mandateHash` gives it. */
  mandate: Hex
  /** The offers the agent's mandate allows now. */
  eligible: OfferGroup<OfferMatch>
  /** The offers it doesn't allow yet, which list only when the search asked for them. */
  needingApproval: OfferGroup<OfferNeedingApproval>
}

const words = (query: string | null) =>
  query === null ? [] : query.toLowerCase().split(/\s+/).filter(Boolean)

/**
 * Whether an offer version fits a search at `now`, leaving the agent's mandate aside. It's in the
 * search's currency, its item has every word of the query, it takes the quantity, its total for
 * that quantity is within the budget, and booked at `now` it delivers by the search's deadline. An
 * offer whose delivery falls exactly on the deadline fits at `now` and no later, so a search with
 * a deadline is best booked straight away.
 */
export function offerFits(search: OfferSearch, version: ServiceOfferVersion, now: bigint): boolean {
  if (serviceOfferProblem(version) !== null || version.currency !== search.currency) return false
  const text = `${version.item.name} ${version.item.summary}`.toLowerCase()
  if (!words(search.query).every((w) => text.includes(w))) return false
  let quote: ServiceOfferQuote
  try {
    quote = serviceOfferQuote(version, search.quantity)
  } catch {
    return false
  }
  if (quote.total > search.budget) return false
  return search.deliverBy === null || now + version.rules.leadTime <= search.deliverBy
}

/**
 * An offer priced for a search, as Avow lists it. Throws for a version that doesn't fit the search
 * at `checkedAt`, or a supplier name that's blank or longer than `SERVICE_NAME_MAX`.
 */
export function offerMatch(
  search: OfferSearch,
  version: ServiceOfferVersion,
  supplierName: string,
  checkedAt: bigint,
): OfferMatch {
  if (!offerFits(search, version, checkedAt))
    throw new RangeError("The offer doesn't fit the search")
  if (!isFilled(supplierName, SERVICE_NAME_MAX))
    throw new RangeError("The supplier's name is blank")
  return {
    id: offerVersionId(version),
    version,
    supplier: { name: supplierName, sandbox: true },
    quote: serviceOfferQuote(version, search.quantity),
    deliverBy: checkedAt + version.rules.leadTime,
  }
}

/** Orders offers by `OFFER_RANKING`, returning a new array. */
export function rankOffers<T extends OfferMatch>(offers: readonly T[]): T[] {
  return [...offers].sort((a, b) => {
    if (a.quote.total !== b.quote.total) return a.quote.total < b.quote.total ? -1 : 1
    if (a.deliverBy !== b.deliverBy) return a.deliverBy < b.deliverBy ? -1 : 1
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

const groupOf = <T extends OfferMatch>(offers: readonly T[]): OfferGroup<T> => ({
  offers: rankOffers(offers).slice(0, OFFER_RESULTS_MAX),
  more: offers.length > OFFER_RESULTS_MAX,
})

/**
 * Avow's answer to a search from the offers its mandate check sorted, each built with
 * `offerMatch` at `checkedAt`. Each group is ranked and cut to `OFFER_RESULTS_MAX`, and offers
 * needing approval are dropped unless the search asked for them.
 */
export function offerSearchResult(input: {
  search: OfferSearch
  checkedAt: bigint
  mandate: Hex
  eligible: readonly OfferMatch[]
  needingApproval: readonly OfferNeedingApproval[]
}): OfferSearchResult {
  return {
    search: input.search,
    ranking: OFFER_RANKING,
    checkedAt: input.checkedAt,
    mandate: input.mandate,
    eligible: groupOf(input.eligible),
    needingApproval: input.search.needingApproval
      ? groupOf(input.needingApproval)
      : { offers: [], more: false },
  }
}

const sameMatch = (search: OfferSearch, checkedAt: bigint, m: OfferMatch) => {
  if (!offerFits(search, m.version, checkedAt)) return false
  const quote = serviceOfferQuote(m.version, search.quantity)
  return (
    m.id === offerVersionId(m.version) &&
    m.deliverBy === checkedAt + m.version.rules.leadTime &&
    m.quote.total === quote.total &&
    m.quote.lateCancellation === quote.lateCancellation &&
    m.quote.noShow === quote.noShow &&
    m.quote.reserve === quote.reserve &&
    isFilled(m.supplier.name, SERVICE_NAME_MAX)
  )
}

const ranked = (offers: readonly OfferMatch[]) =>
  rankOffers(offers).every((m, i) => m === offers[i])

const groupProblem = (group: OfferGroup<OfferMatch>) =>
  (group.more && group.offers.length !== OFFER_RESULTS_MAX) || !ranked(group.offers)

/**
 * What's inconsistent in Avow's answer, in words, or null when nothing is. Every offer fits the
 * search the answer echoes at the time it was checked, with the id, price, charges, reserve and
 * delivery that search gives it. Each group keeps to the ranking and the limit, and says it has
 * more only when it's full. No version lists twice, and offers needing approval list only when the
 * search asked for them.
 */
export function offerSearchResultProblem(result: OfferSearchResult): string | null {
  const { search, checkedAt, eligible, needingApproval } = result
  if (
    eligible.offers.length > OFFER_RESULTS_MAX ||
    needingApproval.offers.length > OFFER_RESULTS_MAX
  ) {
    return `A group lists more than ${OFFER_RESULTS_MAX} offers.`
  }
  const all = [...eligible.offers, ...needingApproval.offers]
  if (!all.every((m) => sameMatch(search, checkedAt, m))) {
    return "An offer doesn't match the search it answers."
  }
  if (new Set(all.map((m) => m.id)).size !== all.length) return 'An offer is listed twice.'
  if (!search.needingApproval && (needingApproval.offers.length > 0 || needingApproval.more)) {
    return "Offers needing approval are listed though the search didn't ask for them."
  }
  if (groupProblem(eligible) || groupProblem(needingApproval)) {
    return "A group isn't in the ranking's order, or says it has more when it isn't full."
  }
  return null
}

/**
 * What stops an agent relying on Avow's answer, in words, or null when nothing does. The answer is
 * to the search the agent sent, against the mandate it holds now, and was checked within
 * `API_REQUEST_MAX_VALIDITY` of `now` by the agent's clock.
 */
export function offerSearchAnswerProblem(
  sent: OfferSearch,
  result: OfferSearchResult,
  held: { mandate: Hex; now: bigint },
): string | null {
  const s = result.search
  const same =
    s.query === sent.query &&
    s.budget === sent.budget &&
    s.currency === sent.currency &&
    s.quantity === sent.quantity &&
    s.deliverBy === sent.deliverBy &&
    s.needingApproval === sent.needingApproval
  if (!same) return 'The answer is to another search.'
  if (result.mandate !== held.mandate.toLowerCase()) {
    return 'The answer was checked against another mandate.'
  }
  const gap =
    result.checkedAt > held.now ? result.checkedAt - held.now : held.now - result.checkedAt
  if (gap > API_REQUEST_MAX_VALIDITY) return "The answer wasn't checked just now."
  return null
}

/** A search as JSON. Words, quantity, deadline and the group needing approval may be left out. */
export const offerSearchJson = z.strictObject({
  query: z.string().max(OFFER_QUERY_MAX).nullable().optional(),
  budget: u256,
  currency: z.enum(CURRENCIES),
  quantity: z.number().int().min(1).max(SERVICE_QUANTITY_MAX).optional(),
  deliverBy: u64.nullable().optional(),
  needingApproval: z.boolean().optional(),
})

const searchOf = (data: z.output<typeof offerSearchJson>): OfferSearch | null => {
  if (data.budget === 0n) return null
  const query = data.query?.trim()
  return {
    query: query ? query : null,
    budget: data.budget,
    currency: data.currency,
    quantity: data.quantity ?? 1,
    deliverBy: data.deliverBy ?? null,
    needingApproval: data.needingApproval ?? false,
  }
}

/**
 * Reads a search from JSON. Words left out, null, empty or only whitespace all read as no words,
 * which lists every offer, and the quantity defaults to 1. A budget of nothing is refused.
 */
export function parseOfferSearch(json: unknown): Parsed<OfferSearch> {
  const parsed = offerSearchJson.safeParse(json)
  const search = parsed.success ? searchOf(parsed.data) : null
  return search ? { ok: true, value: search } : { ok: false, reason: 'message.invalid' }
}

const offerMatchJson = z.strictObject({
  id: bytes32,
  version: serviceOfferVersionJson,
  supplier: z.strictObject({
    name: z.string().min(1).max(SERVICE_NAME_MAX),
    sandbox: z.literal(true),
  }),
  quote: z.strictObject({ total: u256, lateCancellation: u256, noShow: u256, reserve: u256 }),
  deliverBy: u64,
})

const groupJson = <T extends z.ZodType>(offer: T) =>
  z.strictObject({ offers: z.array(offer).max(OFFER_RESULTS_MAX), more: z.boolean() })

/** Avow's answer to a search as JSON, with amounts and times as decimal strings. */
export const offerSearchResultJson = z.strictObject({
  search: offerSearchJson,
  ranking: z.literal(OFFER_RANKING),
  checkedAt: u64,
  mandate: bytes32,
  eligible: groupJson(offerMatchJson),
  needingApproval: groupJson(offerMatchJson.extend({ need: z.enum(APPROVAL_NEEDS) })),
})

/**
 * Reads Avow's answer to a search from JSON, refusing one whose shape is wrong or that
 * `offerSearchResultProblem` finds inconsistent, which includes a version `serviceOfferProblem`
 * refuses. Whether it
 * answers the search the agent sent is `offerSearchAnswerProblem`'s to say.
 */
export function parseOfferSearchResult(json: unknown): Parsed<OfferSearchResult> {
  const parsed = offerSearchResultJson.safeParse(json)
  if (!parsed.success) return { ok: false, reason: 'message.invalid' }
  const search = searchOf(parsed.data.search)
  if (search === null) return { ok: false, reason: 'message.invalid' }
  const result: OfferSearchResult = { ...parsed.data, search }
  return offerSearchResultProblem(result) === null
    ? { ok: true, value: result }
    : { ok: false, reason: 'message.invalid' }
}
