import type { Hex } from 'viem'
import { DAY } from './seller-mandate.js'
import { isRecord } from './store.js'

/**
 * The quotes a seller keeps in its services file, read back to the types they were written from.
 * The services file and the seller's ledger both read them here, so they read them one way.
 */

/**
 * An order this business quoted. It holds a place in its item's capacity until the supplier can no
 * longer accept it, and for the rest of the day once the supplier has.
 */
export interface Quoted {
  orderId: string
  item: string
  at: bigint
  /** The last moment the supplier can accept the order, in unix seconds. */
  until: bigint
  accepted: boolean
  /** The terms hash of each agreement this agent signed for the order. */
  hashes: Hex[]
  /**
   * What the sale comes to, as the seller's mandate counts it: its units, its whole price in micros
   * and when it's delivered by. Null for a quote kept before the agent counted sales, which a
   * mandate's ledger then leaves out, and which is dropped a day after it was made.
   */
  sale: { units: number; price: bigint; deliverBy: bigint } | null
}

const isSeconds = (v: unknown): v is string => typeof v === 'string' && /^[0-9]{1,15}$/.test(v)
const isHash = (v: unknown): v is Hex => typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v)

/** What a sale comes to as a seller's mandate counts it, or null for counts that don't read. */
export function readSaleCounts(
  s: unknown,
): { units: number; price: bigint; deliverBy: bigint } | null {
  return isRecord(s) &&
    Number.isSafeInteger(s.units) &&
    (s.units as number) >= 0 &&
    typeof s.price === 'string' &&
    /^[0-9]{1,78}$/.test(s.price) &&
    isSeconds(s.deliverBy)
    ? { units: s.units as number, price: BigInt(s.price), deliverBy: BigInt(s.deliverBy) }
    : null
}

/**
 * The quotes the services file keeps. A quote older than a day no longer takes a place, so it's
 * dropped the next time the file is kept, unless it was accepted and isn't due yet, which a
 * seller's mandate still counts as outstanding.
 */
export function readQuoted(json: Record<string, unknown>, now: bigint): Quoted[] {
  const since = now - DAY
  return (Array.isArray(json.quoted) ? json.quoted : []).flatMap((q: unknown): Quoted[] => {
    if (!isRecord(q) || typeof q.orderId !== 'string' || typeof q.item !== 'string') return []
    if (!isSeconds(q.at) || !isSeconds(q.until) || typeof q.accepted !== 'boolean') return []
    const hashes = Array.isArray(q.hashes) ? q.hashes.filter(isHash) : []
    const at = BigInt(q.at)
    const sale = readSaleCounts(q.sale)
    const owed = q.accepted && sale !== null && sale.deliverBy > now
    return at > since || owed
      ? [
          {
            orderId: q.orderId,
            item: q.item,
            at,
            until: BigInt(q.until),
            accepted: q.accepted,
            hashes,
            sale,
          },
        ]
      : []
  })
}
