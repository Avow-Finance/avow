import { type ChainedTerms, JOB_CATEGORY, saleFacts, type Terms } from '@avow-finance/spec'
import type { Address, Hex } from 'viem'
import {
  type CountedSale,
  DAY,
  holdSale,
  ledgerFor,
  type SellerStanding,
} from './seller-mandate.js'
import { inTurn, isRecord, readJson, type SandboxStore, write } from './store.js'

/**
 * The jobs a selling agent quoted, which its seller's mandate counts. Every way the SDK sells a job,
 * the mailbox and the job demo alike, holds the sale to the mandate here and records it here, so
 * one ledger counts every job the folder quoted. A service is counted in the services file, apart
 * from jobs.
 */

const isSeconds = (v: unknown): v is string => typeof v === 'string' && /^[0-9]{1,15}$/.test(v)

/** One job sale as the file keeps it, or null for one it can't read, which it drops. */
function readSale(v: unknown): CountedSale | null {
  if (!isRecord(v) || typeof v.item !== 'string' || typeof v.accepted !== 'boolean') return null
  if (!Number.isSafeInteger(v.units) || (v.units as number) < 0) return null
  if (typeof v.price !== 'string' || !/^[0-9]{1,78}$/.test(v.price)) return null
  if (!isSeconds(v.at) || !isSeconds(v.until) || !isSeconds(v.deliverBy)) return null
  return {
    item: v.item,
    units: v.units as number,
    price: BigInt(v.price),
    at: BigInt(v.at),
    until: BigInt(v.until),
    deliverBy: BigInt(v.deliverBy),
    accepted: v.accepted,
  }
}

/**
 * The job sales kept, by order id. A sale older than a day no longer counts toward the day's units,
 * so it's dropped unless it was accepted and isn't due yet, which still counts as outstanding.
 */
async function kept(store: SandboxStore, now: bigint): Promise<Record<string, CountedSale>> {
  const text = await store.read('job-sales')
  const json = text ? readJson(text, 'job-sales') : {}
  const sales: Record<string, CountedSale> = {}
  for (const [orderId, v] of Object.entries(isRecord(json.sales) ? json.sales : {})) {
    const sale = readSale(v)
    if (!sale) continue
    const owed = sale.accepted && sale.deliverBy > now
    if (sale.at > now - DAY || owed) sales[orderId] = sale
  }
  return sales
}

/** A job sale to hold to the seller's mandate: the order, the exact terms the quote signs, and who. */
export interface JobSale {
  orderId: string
  terms: Terms | ChainedTerms
  buyer: string
  signingKey: Address
}

/** Throws a refusal when the mandate in force doesn't allow this job, counting every other one. */
function hold(
  standing: SellerStanding,
  sale: JobSale,
  sales: Record<string, CountedSale>,
  now: bigint,
) {
  if (!standing.inForce) return
  const facts = saleFacts(sale.terms)
  if (!facts) throw new Error("The order's terms aren't a job's.")
  const others = Object.entries(sales).flatMap(([id, s]) => (id === sale.orderId ? [] : [s]))
  holdSale(
    standing,
    {
      terms: sale.terms,
      offer: null,
      buyer: sale.buyer,
      signingKey: sale.signingKey,
      ledger: ledgerFor(standing, JOB_CATEGORY, facts.item, others, now),
    },
    now,
  )
}

/**
 * Holds a job the agent is about to quote to the mandate in force, and records it, in one change,
 * so two jobs at once can't both pass the same limit. It answers with the hash of the mandate the
 * quote names, or null when none is in force. A job quoted again keeps the time it was first
 * quoted. It reads nothing from Avow, so read the standing first.
 */
export function holdJobQuote(
  store: SandboxStore,
  standing: SellerStanding,
  sale: JobSale,
  now: bigint,
): Promise<Hex | null> {
  return inTurn(store, async () => {
    const sales = await kept(store, now)
    hold(standing, sale, sales, now)
    const facts = saleFacts(sale.terms)
    if (!facts) throw new Error("The order's terms aren't a job's.")
    const record: CountedSale = {
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

/**
 * Holds a quoted job to the newest mandate again before the agent accepts it, since the mandate
 * may have changed, ended or been revoked since the quote.
 */
export function holdJobAcceptance(
  store: SandboxStore,
  standing: SellerStanding,
  sale: JobSale,
  now: bigint,
): Promise<void> {
  return inTurn(store, async () => hold(standing, sale, await kept(store, now), now))
}

/** Marks a job accepted, which then counts as outstanding until it's due. */
export function jobAccepted(store: SandboxStore, orderId: string, now: bigint): Promise<void> {
  return inTurn(store, async () => {
    const sales = await kept(store, now)
    const sale = sales[orderId]
    if (!sale || sale.accepted) return
    await write(store, 'job-sales', { sales: { ...sales, [orderId]: { ...sale, accepted: true } } })
  })
}
