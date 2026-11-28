import {
  type AvowDomain,
  type Currency,
  type OfferSearch,
  type OfferSearchResult,
  offerSearchAnswerProblem,
  parseOfferSearch,
  parseOfferSearchResult,
  SANDBOX_PATHS,
  toWire,
} from '@avow-finance/spec'
import type { Hex } from 'viem'
import type { AgentKey } from '../agent.js'
import { AvowApiError, agentRequestKey, avowRequests } from '../http.js'

/**
 * A buying agent's search of Avow's directory of offers, from its own side. The agent signs an
 * `OfferSearch` with its enrolled key under its business's lock, and Avow answers with the listed
 * offers that fit, those the agent's current mandate allows first. The agent reads the answer with
 * the spec's parser, and takes it only once it answers the search it sent, under the mandate it
 * holds, checked just now. A result grants nothing.
 */

/** What an agent searches for, in micros of the currency and unix seconds, as the spec has it. */
export interface OfferSearchInput {
  /** Words every listed item has to hold in its name or summary. Left out, any item fits. */
  query?: string | null
  /** The most the agent will pay for the whole booking, in micros of `currency`. */
  budget: bigint
  /** `USD` when left out, the one currency an offer takes today. */
  currency?: Currency
  /** How many units the agent would book, 1 when left out. */
  quantity?: number
  /** The latest the agent needs delivery, in unix seconds, or null when any time will do. */
  deliverBy?: bigint | null
  /** Whether to list the offers the agent's mandate doesn't allow yet. False when left out. */
  needingApproval?: boolean
}

/** What a search came to. */
export type OfferSearchOutcome =
  | { ok: true; result: OfferSearchResult }
  | { ok: false; reason: 'offer.listing_unavailable'; notice: string }

/** What an agent is told when the sandbox it talks to answers no search. */
export const OFFER_SEARCH_UNSERVED =
  "This Avow sandbox doesn't list offers yet, so a search finds nothing. Ask the supplier's agent to hand over its offer, or read the test sellers' offers."

/**
 * Whether Avow's refusal says the sandbox lists no offers, which is a deployment that holds no
 * seller's mandates or one that doesn't serve the listing routes yet. Listing, reading listings and
 * searching all hear it the same way.
 */
export const listsNothing = (error: unknown): boolean =>
  error instanceof AvowApiError &&
  error.definite &&
  (error.reason === 'offer.listing_unavailable' ||
    (error.status === 404 &&
      error.reason === 'request.invalid' &&
      /no such route/i.test(error.message)))

/**
 * The search an input asks for, read the way Avow reads it, so a search Avow would refuse is
 * refused here before anything is signed. Blank words read as none, and a budget of nothing, a
 * quantity out of range or words longer than `OFFER_QUERY_MAX` throw a `RangeError`.
 */
export function offerSearchOf(input: OfferSearchInput): OfferSearch {
  const read = parseOfferSearch(
    toWire({
      query: input.query ?? null,
      budget: input.budget,
      currency: input.currency ?? 'USD',
      quantity: input.quantity ?? 1,
      deliverBy: input.deliverBy ?? null,
      needingApproval: input.needingApproval ?? false,
    }),
  )
  if (!read.ok) {
    throw new RangeError(
      'The search needs a budget above nothing, a whole number of units from 1 up, and at most 200 characters of words.',
    )
  }
  return read.value
}

/**
 * Sends a search, signed by the agent's key, and answers with Avow's result once it holds up. The
 * answer has to parse and be consistent by the spec, and `offerSearchAnswerProblem` has to find it
 * answers this search under the mandate the agent holds now. Avow may have read a mandate the
 * administrator signed since the agent last read its own, so a mismatch reads the agent's mandate
 * afresh once before it throws. A sandbox that lists no offers answers `{ ok: false }` with a
 * notice. Any other refusal throws as it came.
 */
export async function searchOffers(p: {
  apiUrl: string
  agentKey: AgentKey
  domain: AvowDomain
  send: typeof fetch
  search: OfferSearch
  /** The hash of the mandate the agent acts under, read afresh when `fresh` is true. */
  heldMandate: (fresh: boolean) => Promise<Hex>
  now: () => bigint
}): Promise<OfferSearchOutcome> {
  const ask = avowRequests({
    baseUrl: p.apiUrl,
    key: agentRequestKey(p.agentKey),
    retryFor: 30n,
    fetch: p.send,
  })
  let result: OfferSearchResult
  try {
    result = await ask({
      domain: p.domain,
      path: SANDBOX_PATHS.offerSearch,
      body: p.search,
      read: parseOfferSearchResult,
    })
  } catch (error) {
    if (listsNothing(error)) {
      return { ok: false, reason: 'offer.listing_unavailable', notice: OFFER_SEARCH_UNSERVED }
    }
    throw error
  }
  const problemUnder = async (fresh: boolean) =>
    offerSearchAnswerProblem(p.search, result, {
      mandate: await p.heldMandate(fresh),
      now: p.now(),
    })
  const problem = (await problemUnder(false)) && (await problemUnder(true))
  if (problem) throw new Error(`Avow's answer to the search can't be used: ${problem}`)
  return { ok: true, result }
}
