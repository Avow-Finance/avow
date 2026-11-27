import type { Address } from 'viem'
import { z } from 'zod'
import { BUSINESS_ID, isCount, LOWER_ADDRESS } from './fields.js'
import { address } from './json-fields.js'
import {
  offerVersionId,
  SERVICE_NAME_MAX,
  SERVICE_TEXT_MAX,
  type ServiceOfferVersion,
  serviceOfferProblem,
  serviceOfferQuote,
  serviceOfferVersionJson,
} from './service.js'
import { isPlainText } from './text.js'

/**
 * One sale of a service as a person approves it, when a seller's mandate hands the sale to a
 * person: which key sells, who buys, the whole offer version and how many units. The offer version
 * is carried whole, so the person reads its price, its charges and its delivery, and nothing stands
 * in for them. The price is the offer's price for each unit times the units.
 *
 * It names no deadline and no terms hash. A service's supplier has minutes to accept, and an
 * approval over one set of terms would have to land inside them. The buyer's next order of these
 * units from this version is the sale that was approved, and every limit of the mandate still
 * holds it.
 *
 * A job has no offer version, so no job is approved this way yet, and one a person has to decide
 * stays with the person.
 */
export interface SaleContent {
  /** The signing key that would make the sale, which the seller's mandate binds. */
  signingKey: Address
  /** The buyer's business id. */
  buyer: string
  /** The offer version the service is sold from. */
  offer: ServiceOfferVersion
  units: number
}

/**
 * How long an approved sale can still be made, in seconds from its approval. It is made once, and
 * an approval nobody used by then lapses. Whoever records sales keeps both, since the check reads
 * only the approval it's handed.
 */
export const SALE_APPROVAL_LASTS = 86_400n

const KEYS: readonly string[] = [
  'signingKey',
  'buyer',
  'offer',
  'units',
] satisfies readonly (keyof SaleContent)[]

function isSaleContent(v: unknown): v is SaleContent {
  if (typeof v !== 'object' || v === null) return false
  const c = v as Record<string, unknown>
  if (Object.keys(c).length !== KEYS.length || !KEYS.every((k) => Object.hasOwn(c, k))) return false
  const { signingKey, buyer, units } = c
  const offer = c.offer as ServiceOfferVersion
  if (typeof signingKey !== 'string' || !LOWER_ADDRESS.test(signingKey)) return false
  if (typeof buyer !== 'string' || !BUSINESS_ID.test(buyer)) return false
  if (serviceOfferProblem(offer) !== null) return false
  // A business is named by its id, and no business approves a sale to itself.
  if (!BUSINESS_ID.test(offer.supplier) || offer.supplier === buyer) return false
  // The seller's agent wrote these, and a person reads them on the card they sign.
  if (!isPlainText(offer.item.name, SERVICE_NAME_MAX)) return false
  if (!isPlainText(offer.item.summary, SERVICE_TEXT_MAX)) return false
  if (!isPlainText(offer.rules.evidence, SERVICE_TEXT_MAX)) return false
  if (!isCount(units, offer.rules.maxPerBooking)) return false
  // A price so small its charges round to nothing builds no terms, so it is no sale.
  serviceOfferQuote(offer, units)
  return true
}

/**
 * A plain copy of a value, read once. What's checked is then what's compared, whatever the value
 * would answer on a second read.
 */
const readOnce = (v: unknown): unknown => structuredClone(v)

/**
 * Checks a sale's content on its own, and gives `message.invalid` for one that isn't well formed.
 * It never throws. The offer version passes `serviceOfferProblem`, its supplier and the buyer are
 * named by their ids and differ, the units are from one to the most the version takes in a
 * booking, and the item's name, its summary and what counts as delivery are plain text. An offer
 * whose words aren't plain can be listed and sold, and can't be put to a person this way.
 */
export function saleContentProblem(content: SaleContent): 'message.invalid' | null {
  try {
    return isSaleContent(readOnce(content)) ? null : 'message.invalid'
  } catch {
    // A value that can't be read plainly, or whose offer builds no terms, is no sale.
    return 'message.invalid'
  }
}

/** What a sale comes to, the offer's price for each unit times the units, in micros. */
export const salePrice = (sale: SaleContent): bigint =>
  serviceOfferQuote(sale.offer, sale.units).total

/**
 * Whether a sale is exactly the one a person approved: the same signing key, buyer, offer version
 * and units. It is false when either isn't well formed, and false for no approval at all.
 */
export function coversSale(approved: SaleContent | null, sale: SaleContent): boolean {
  if (approved === null) return false
  try {
    const [a, b] = [readOnce(approved), readOnce(sale)]
    if (!isSaleContent(a) || !isSaleContent(b)) return false
    return (
      a.signingKey === b.signingKey &&
      a.buyer === b.buyer &&
      a.units === b.units &&
      offerVersionId(a.offer) === offerVersionId(b.offer)
    )
  } catch {
    return false
  }
}

/** A sale's content as JSON, held to `saleContentProblem`. */
export const saleContentJson = z
  .strictObject({
    signingKey: address,
    buyer: z.string(),
    offer: serviceOfferVersionJson,
    units: z.number(),
  })
  .refine((c) => saleContentProblem(c) === null, 'a well-formed sale')
