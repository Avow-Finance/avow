import {
  type ChainedTerms,
  JOB_CATEGORY,
  SERVICE_CATEGORY,
  type SellerCategory,
  type ServiceOfferVersion,
  saleFacts,
  type Terms,
} from '@avow-finance/spec'
import type { Address, Hex } from 'viem'
import {
  type CountedSale,
  DAY,
  holdSale,
  ledgerFor,
  type SellerStanding,
} from './seller-mandate.js'
import { isSeconds, readQuoted, readSaleCounts } from './service-quoted.js'
import { inTurn, isRecord, readJson, type SandboxStore, write } from './store.js'

/**
 * Everything a selling agent quoted, as its seller's mandate counts it. A mandate's limits hold
 * across everything the seller sells, so its ledger reads every sale the folder quoted: the
 * services in the services file and the jobs in `job-sales`, which every way the SDK sells a job
 * records. Every hold and every record runs in the store's one turn, so a service and a job quoted
 * at once can't both pass the same limit.
 */

/** One job sale as `job-sales` keeps it, or null for one it can't read, which it drops. */
function readJobSale(v: unknown): Omit<CountedSale, 'category'> | null {
  if (!isRecord(v) || typeof v.item !== 'string' || typeof v.accepted !== 'boolean') return null
  if (!isSeconds(v.at) || !isSeconds(v.until)) return null
  const counts = readSaleCounts(v)
  if (!counts) return null
  return { item: v.item, at: BigInt(v.at), until: BigInt(v.until), accepted: v.accepted, ...counts }
}

/**
 * The job sales kept, by order id. A sale older than a day no longer counts toward the day's units,
 * so it's dropped unless it was accepted and isn't due yet, which still counts as outstanding.
 */
async function jobSales(store: SandboxStore, now: bigint): Promise<Record<string, CountedSale>> {
  const text = await store.read('job-sales')
  const json = text ? readJson(text, 'job-sales') : {}
  const sales: Record<string, CountedSale> = {}
  for (const [orderId, v] of Object.entries(isRecord(json.sales) ? json.sales : {})) {
    const sale = readJobSale(v)
    if (!sale) continue
    const owed = sale.accepted && sale.deliverBy > now
    if (sale.at > now - DAY || owed) sales[orderId] = { category: JOB_CATEGORY, ...sale }
  }
  return sales
}

/** One sale the ledger counts, named by its kind and its order, so the sale it checks is left out. */
interface Apart {
  category: SellerCategory
  orderId: string
}

/**
 * Every sale the folder quoted that the ledger counts, apart from the one being checked. A service
 * quoted before the agent counted sales has no counts, and is left out.
 */
async function everySale(store: SandboxStore, apart: Apart, now: bigint): Promise<CountedSale[]> {
  const text = await store.read('services')
  const services = readQuoted(text ? readJson(text, 'services') : {}, now).flatMap((q) =>
    q.sale && !(apart.category === SERVICE_CATEGORY && q.orderId === apart.orderId)
      ? [
          {
            category: SERVICE_CATEGORY,
            item: q.item,
            at: q.at,
            until: q.until,
            accepted: q.accepted,
            ...q.sale,
          },
        ]
      : [],
  )
  const jobs = Object.entries(await jobSales(store, now)).flatMap(([orderId, s]) =>
    apart.category === JOB_CATEGORY && orderId === apart.orderId ? [] : [s],
  )
  return [...services, ...jobs]
}

/** A sale to hold to the seller's mandate: the order, the exact terms its quote signs, and who. */
export interface HeldSale {
  orderId: string
  terms: Terms | ChainedTerms
  /** The offer a service's terms book, or null for a job, which is sold from none. */
  offer: ServiceOfferVersion | null
  buyer: string
  signingKey: Address
}

/**
 * Throws a refusal when the mandate in force doesn't allow this sale, counting every other sale the
 * folder quoted. It doesn't take the store's turn, so call it from inside one: from a change that
 * also takes the sale's place, or through `holdInTurn`.
 */
export async function holdToMandate(
  store: SandboxStore,
  standing: SellerStanding,
  sale: HeldSale,
  now: bigint,
): Promise<void> {
  if (!standing.inForce) return
  const facts = saleFacts(sale.terms)
  if (!facts) throw new Error("The order's terms aren't a service's or a job's.")
  const sales = await everySale(store, { category: facts.category, orderId: sale.orderId }, now)
  holdSale(
    standing,
    {
      terms: sale.terms,
      offer: sale.offer,
      buyer: sale.buyer,
      signingKey: sale.signingKey,
      ledger: ledgerFor(standing, facts.category, facts.item, sales, now),
    },
    now,
  )
}

/** Holds a sale to the mandate in its own turn, as before an acceptance. */
export const holdInTurn = (
  store: SandboxStore,
  standing: SellerStanding,
  sale: HeldSale,
  now: bigint,
): Promise<void> => inTurn(store, () => holdToMandate(store, standing, sale, now))

/**
 * Holds a job the agent is about to quote to the mandate in force, and records it in `job-sales`,
 * in one turn. It answers with the hash of the mandate the quote names, or null when none is in
 * force. A job quoted again keeps the time it was first quoted. It reads nothing from Avow, so read
 * the standing first.
 */
export function holdJobQuote(
  store: SandboxStore,
  standing: SellerStanding,
  sale: Omit<HeldSale, 'offer'>,
  now: bigint,
): Promise<Hex | null> {
  return inTurn(store, async () => {
    await holdToMandate(store, standing, { ...sale, offer: null }, now)
    const facts = saleFacts(sale.terms)
    if (!facts || facts.category !== JOB_CATEGORY)
      throw new Error("The order's terms aren't a job's.")
    const sales = await jobSales(store, now)
    const record: CountedSale = {
      category: JOB_CATEGORY,
      item: facts.item,
      units: facts.units,
      price: facts.price,
      deliverBy: facts.deliverBy,
      at: sales[sale.orderId]?.at ?? now,
      until: sale.terms.remedies.acceptBy,
      accepted: false,
    }
    await write(store, 'job-sales', { sales: { ...sales, [sale.orderId]: record } })
    return standing.inForce ? standing.chain.current.hash : null
  })
}

/** Marks a job accepted, which then counts as outstanding until it's due. */
export function jobAccepted(store: SandboxStore, orderId: string, now: bigint): Promise<void> {
  return inTurn(store, async () => {
    const sales = await jobSales(store, now)
    const sale = sales[orderId]
    if (!sale || sale.accepted) return
    await write(store, 'job-sales', { sales: { ...sales, [orderId]: { ...sale, accepted: true } } })
  })
}
