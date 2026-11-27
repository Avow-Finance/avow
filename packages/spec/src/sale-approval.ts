import { type Hex, zeroHash } from 'viem'
import { z } from 'zod'
import { canonicalJson } from './canonical.js'
import { BUSINESS_ID, isCount, LOWER_BYTES32 } from './fields.js'
import { JOB_CATEGORY, JOB_KIND_MAX } from './job.js'
import { bytes32, u256 } from './json-fields.js'
import { SELLER_CATEGORIES, type SellerCategory } from './seller-mandate.js'
import { SERVICE_NAME_MAX, SERVICE_QUANTITY_MAX } from './service.js'
import { isPlainText } from './text.js'
import { CURRENCIES, type Currency } from './types.js'

/**
 * One sale as a person approves it, when a seller's mandate hands the sale to a person: who buys,
 * what, how many and for how much. It names no deadline and no terms hash, so an approval doesn't
 * have to land inside the few minutes a sale's supplier has to accept. The buyer's next order with
 * this same content is the sale that was approved, and every limit of the mandate still holds it.
 */
export interface SaleContent {
  /** The buyer's business id. */
  buyer: string
  category: SellerCategory
  /** The service's name or the job's kind of work, as the seller's agent named it. */
  item: string
  /** The id of the offer version a service is sold from, or null for a job, which books no offer. */
  offer: Hex | null
  /** The units sold, which is one for a job. */
  units: number
  /** The whole price, in micros. */
  price: bigint
  currency: Currency
}

/**
 * How long an approved sale can still be made, in seconds from its approval. It is made once, and
 * an approval nobody used by then lapses.
 */
export const SALE_APPROVAL_LASTS = 86_400n

const KEYS = [
  'buyer',
  'category',
  'item',
  'offer',
  'units',
  'price',
  'currency',
] as const satisfies readonly (keyof SaleContent)[]

function isSaleContent(v: unknown): v is SaleContent {
  if (typeof v !== 'object' || v === null) return false
  const c = v as Record<string, unknown>
  if (Object.keys(c).length !== KEYS.length || !KEYS.every((k) => Object.hasOwn(c, k))) return false
  const { buyer, category, item, offer, units, price } = c
  if (typeof buyer !== 'string' || !BUSINESS_ID.test(buyer)) return false
  if (!(SELLER_CATEGORIES as readonly unknown[]).includes(category)) return false
  const job = category === JOB_CATEGORY
  // An agent names what it sells and a person reads the name on the card they sign.
  if (!isPlainText(item, job ? JOB_KIND_MAX : SERVICE_NAME_MAX)) return false
  if (job) {
    if (offer !== null || units !== 1) return false
  } else {
    if (typeof offer !== 'string' || !LOWER_BYTES32.test(offer) || offer === zeroHash) return false
    if (!isCount(units, SERVICE_QUANTITY_MAX)) return false
  }
  if (typeof price !== 'bigint' || price < 1n || price >= 2n ** 256n) return false
  return (CURRENCIES as readonly unknown[]).includes(c.currency)
}

/**
 * Checks a sale's content on its own, and gives `message.invalid` for one that isn't well formed.
 * It never throws. A service names the offer version it's sold from and at least one unit, a job
 * names no offer and is one unit, the buyer is named by its id, the item's name is plain text, and
 * the price is above zero.
 */
export function saleContentProblem(content: SaleContent): 'message.invalid' | null {
  try {
    return isSaleContent(content) ? null : 'message.invalid'
  } catch {
    // A value that throws when read is no sale.
    return 'message.invalid'
  }
}

/**
 * Whether a sale is exactly the one a person approved: the same buyer, item, offer version, units,
 * price and currency. It is false when either isn't well formed, and false for no approval at all.
 */
export function coversSale(approved: SaleContent | null, sale: SaleContent): boolean {
  if (approved === null) return false
  if (saleContentProblem(approved) !== null || saleContentProblem(sale) !== null) return false
  try {
    return canonicalJson(approved) === canonicalJson(sale)
  } catch {
    return false
  }
}

/** A sale's content as JSON, held to `saleContentProblem`. */
export const saleContentJson = z
  .strictObject({
    buyer: z.string(),
    category: z.enum(SELLER_CATEGORIES),
    item: z.string(),
    offer: bytes32.nullable(),
    units: z.number(),
    price: u256,
    currency: z.enum(CURRENCIES),
  })
  .refine((c) => saleContentProblem(c) === null, 'a well-formed sale')
