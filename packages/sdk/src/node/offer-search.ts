import {
  formatUsd,
  OFFER_QUERY_MAX,
  type OfferMatch,
  type OfferNeedingApproval,
  quotedText,
  SERVICE_QUANTITY_MAX,
} from '@avow-finance/spec'
import type { OfferSearchInput, OfferSearchOutcome } from '../sandbox/offer-search.js'

/**
 * A search of Avow's directory in the units a person or a model gives it, dollars and a date, and
 * what the terminal and the MCP server both say about the answer. The SDK's `searchOffers` sends
 * the search and checks the answer, and this only reads what was asked and words what came back.
 */

/** What a search's inputs are called, as the MCP tool takes them. */
export interface SearchInput {
  query?: unknown
  /** Dollars for the whole booking. */
  budget?: unknown
  quantity?: unknown
  /** The latest delivery will do, as an ISO 8601 date or time. */
  deliver_by?: unknown
  needing_approval?: unknown
}

/** The most a budget takes, in dollars, which is the most an offer's price takes too. */
const MOST_DOLLARS = 1_000_000_000

/** A search read from what a person or a model gave, or why it can't be sent. */
export function readSearchInput(input: SearchInput): OfferSearchInput | { error: string } {
  const { query, budget, quantity, deliver_by: deliverBy } = input
  if (query !== undefined && query !== null && typeof query !== 'string') {
    return { error: 'The words to search for are text.' }
  }
  if (typeof query === 'string' && query.length > OFFER_QUERY_MAX) {
    return { error: `Search with at most ${OFFER_QUERY_MAX} characters of words.` }
  }
  const micros = typeof budget === 'number' ? Math.round(budget * 1_000_000) : Number.NaN
  if (
    typeof budget !== 'number' ||
    !(budget > 0 && budget <= MOST_DOLLARS) ||
    Math.abs(budget * 1_000_000 - micros) > 1e-3
  ) {
    return {
      error:
        'Give the most you would pay for the whole booking in dollars, above zero and to six decimals at most.',
    }
  }
  const units = quantity === undefined ? 1 : quantity
  if (
    typeof units !== 'number' ||
    !Number.isInteger(units) ||
    units < 1 ||
    units > SERVICE_QUANTITY_MAX
  ) {
    return { error: `The quantity is a whole number of units from 1 to ${SERVICE_QUANTITY_MAX}.` }
  }
  let by: bigint | null = null
  if (deliverBy !== undefined && deliverBy !== null) {
    const at = typeof deliverBy === 'string' ? Date.parse(deliverBy) : Number.NaN
    if (!Number.isFinite(at) || at < 0) {
      return { error: 'Give the latest delivery will do as an ISO 8601 date or time.' }
    }
    by = BigInt(Math.floor(at / 1000))
  }
  const needing = input.needing_approval
  if (needing !== undefined && typeof needing !== 'boolean') {
    return { error: 'needing_approval is true or false.' }
  }
  return {
    query: typeof query === 'string' ? query : null,
    budget: BigInt(micros),
    quantity: units,
    deliverBy: by,
    needingApproval: needing ?? false,
  }
}

/** The flags `offer search` takes, each with the input it sets and whether it's a number. */
const SEARCH_FLAGS: Record<string, [keyof SearchInput, 'text' | 'number' | 'switch']> = {
  '--query': ['query', 'text'],
  '--budget': ['budget', 'number'],
  '--quantity': ['quantity', 'number'],
  '--deliver-by': ['deliver_by', 'text'],
  '--needing-approval': ['needing_approval', 'switch'],
}

/** What `offer search` was given, read from its flags, or why it can't run. */
export function readSearchArgs(args: readonly string[]): OfferSearchInput | { error: string } {
  const input: SearchInput = {}
  for (let i = 0; i < args.length; i++) {
    const flag = args[i] as string
    const known = Object.hasOwn(SEARCH_FLAGS, flag) ? SEARCH_FLAGS[flag] : undefined
    if (!known) return { error: `offer search doesn't take ${flag}` }
    if (known[1] === 'switch') {
      input[known[0]] = true
      continue
    }
    const value = args[++i]
    if (value === undefined || value.startsWith('--')) return { error: `${flag} needs a value` }
    if (known[1] === 'number' && !/^[0-9]+(\.[0-9]+)?$/.test(value)) {
      return { error: `${flag} takes a number` }
    }
    input[known[0]] = known[1] === 'number' ? Number(value) : value
  }
  if (input.budget === undefined) return { error: 'offer search needs --budget, in dollars' }
  return readSearchInput(input)
}

const iso = (seconds: bigint) => new Date(Number(seconds) * 1000).toISOString()

/**
 * One offer as a line. The item's and the supplier's names are what the supplier wrote, so each
 * shows in quotes after a label by the spec's `quotedText`, which writes any character that could
 * end the quotes, break the line or reorder it as its code point, even in an answer that skipped
 * the parser. The supplier is always called a sandbox business.
 */
function offerLine(m: OfferMatch | OfferNeedingApproval, quantity: number): string {
  const units = `${quantity} unit${quantity === 1 ? '' : 's'}`
  return [
    `${m.id}, item ${quotedText(m.version.item.name)} from sandbox business ${quotedText(m.supplier.name)} (${m.version.supplier}), which no check has verified.`,
    `${units} cost ${formatUsd(m.quote.total)} and reserve ${formatUsd(m.quote.reserve)}, with delivery due by ${iso(m.deliverBy)} if booked when Avow checked.`,
    ...('need' in m ? [`Your mandate refuses it now with ${m.need}.`] : []),
  ].join(' ')
}

/** What a search found, in sentences a person or a model can act on. */
export function searchSentences(outcome: OfferSearchOutcome): string[] {
  if (!outcome.ok) return [outcome.notice]
  const { search, eligible, needingApproval, checkedAt } = outcome.result
  const more = (group: { more: boolean }) =>
    group.more ? ['More fitted than these, so narrow the search to see the rest.'] : []
  return [
    eligible.offers.length === 0
      ? `Avow found no listed offer your mandate allows for this search, checked at ${iso(checkedAt)}.`
      : `Avow found ${eligible.offers.length} listed offer${eligible.offers.length === 1 ? '' : 's'} your mandate allowed when it checked at ${iso(checkedAt)}, cheapest first.`,
    ...eligible.offers.map((m) => offerLine(m, search.quantity)),
    ...more(eligible),
    ...(search.needingApproval
      ? [
          needingApproval.offers.length === 0
            ? 'None fits that your mandate refuses for a reason your administrator could change.'
            : `These ${needingApproval.offers.length} fit, and your mandate doesn't allow them yet. Ask your person before relying on one.`,
          ...needingApproval.offers.map((m) => offerLine(m, search.quantity)),
          ...more(needingApproval),
        ]
      : []),
    'A result grants nothing. Booking an offer checks your mandate and funds again, and Avow refuses a version replaced or withdrawn since.',
  ]
}
