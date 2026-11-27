import {
  checkSellerMandate,
  type ReasonCode,
  type SaleCounterparty,
  SERVICE_CATEGORY,
  type SellerLedger,
  type SellerMandateChain,
  type ServiceOfferVersion,
  sellerOfferProblem,
  sellingLimitFor,
  TESTNET_DEMO_PROFILE,
  type Terms,
} from '@avow-finance/spec'
import type { Address, Hex } from 'viem'

/**
 * A selling agent's own reading of its seller's mandate, and the checks it holds itself to before
 * it lists an offer or quotes a sale. A seller's mandate is the authority its business's
 * administrator signed for its signing key. Avow doesn't enforce a seller's limits yet, and no lock
 * or keychain holds a seller to them, so this agent's own SDK is the only thing that does.
 */

/** A day, in seconds, which a sale's ledger and an offer's capacity count over. */
export const DAY = 86_400n

/** What every word about a seller's mandate ends with, until Avow enforces one. */
export const SELLER_LIMITS_UNENFORCED = "Avow doesn't enforce seller limits yet."

/** What a selling agent is told when no seller's mandate is in force for its signing key. */
export const NO_SELLER_MANDATE = `No seller's mandate is in force for this agent's signing key, so its key is its only limit and it sells as it did before. ${SELLER_LIMITS_UNENFORCED}`

/** What a selling agent is told when it acts under a seller's mandate. */
export const sellerMandateNotice = (hash: Hex) =>
  `This agent checked the sale against its seller's mandate ${hash}, which its own SDK holds it to. ${SELLER_LIMITS_UNENFORCED}`

/**
 * Where a selling agent stands. With no mandate in force it sells as it did before, and says so.
 * With one, it acts under its newest mandate, read as one chain the business account signed.
 */
export type SellerStanding =
  | { inForce: false; notice: string }
  | { inForce: true; chain: SellerMandateChain; notice: string }

/** What a refusal is about: an offer or a sale the mandate doesn't allow, or mandates that don't read. */
export type RefusalOf = 'offer' | 'sale' | 'chain'

const REFUSED: Record<RefusalOf, string> = {
  offer: "The seller's mandate doesn't allow this offer",
  sale: "The seller's mandate doesn't allow this sale",
  chain: "This agent couldn't read its seller's mandates, so it doesn't sell",
}

/** A refusal by the agent's own seller's mandate, with the spec's reason for it. */
export class SellerMandateRefusal extends Error {
  readonly reason: ReasonCode
  readonly of: RefusalOf
  constructor(reason: ReasonCode, of: RefusalOf) {
    super(`${REFUSED[of]} (${reason}). ${SELLER_LIMITS_UNENFORCED}`)
    this.name = 'SellerMandateRefusal'
    this.reason = reason
    this.of = of
  }
}

/** Throws a refusal when the mandate in force doesn't let the agent list this offer version. */
export function holdOffer(
  standing: SellerStanding,
  version: ServiceOfferVersion,
  signingKey: Address,
  now: bigint,
): void {
  if (!standing.inForce) return
  const reason = sellerOfferProblem({
    mandate: standing.chain.current.signed.message,
    version,
    signingKey,
    revoked: false,
    now,
  })
  if (reason) throw new SellerMandateRefusal(reason, 'offer')
}

/** One sale this agent quoted, as its ledger counts it. */
export interface CountedSale {
  item: string
  units: number
  /** The whole price, in micros. */
  price: bigint
  /** When the sale was quoted, in unix seconds. */
  at: bigint
  /** The last moment the agent can accept it, in unix seconds. */
  until: bigint
  /** When the terms say the service is delivered by, in unix seconds. */
  deliverBy: bigint
  accepted: boolean
}

/**
 * What the ledger holds for a sale under the mandate, from the sales this agent quoted apart from
 * the one being checked. `unitsToday` counts the units of every sale quoted this UTC day that the
 * same line of limits governs and that can still bind the seller or already does. `outstanding`
 * counts the price of every sale that can still bind the seller, or binds it and isn't due yet.
 * The agent reads only its own folder, so a sale another agent made with the same key isn't here.
 */
export function ledgerFor(
  standing: Extract<SellerStanding, { inForce: true }>,
  item: string,
  sales: readonly CountedSale[],
  now: bigint,
): SellerLedger {
  const m = standing.chain.current.signed.message
  const line = sellingLimitFor(m, SERVICE_CATEGORY, item)
  const dayStart = now - (now % DAY)
  const binding = (s: CountedSale) => s.accepted || s.until > now
  let unitsToday = 0
  let outstanding = 0n
  for (const s of sales) {
    if (!binding(s)) continue
    const sameLine = line !== null && sellingLimitFor(m, SERVICE_CATEGORY, s.item) === line
    if (sameLine && s.at >= dayStart) unitsToday += s.units
    if (!s.accepted || s.deliverBy > now) outstanding += s.price
  }
  return { unitsToday, outstanding }
}

/**
 * Throws a refusal when the mandate in force doesn't let the agent agree to these terms. Avow's
 * records of the buyer aren't open to a selling agent yet, so the buyer's country is unknown and it
 * counts as not having passed a business check, which a mandate that excludes any country or
 * requires a check refuses. Avow takes no request to approve one sale yet, so a sale a person
 * would have to approve is refused too.
 */
export function holdSale(
  standing: SellerStanding,
  sale: {
    terms: Terms
    offer: ServiceOfferVersion
    buyer: string
    signingKey: Address
    ledger: SellerLedger
  },
  now: bigint,
): void {
  if (!standing.inForce) return
  const buyer: SaleCounterparty = {
    businessId: sale.buyer,
    country: null,
    passedBusinessCheck: false,
  }
  const verdict = checkSellerMandate({
    mandate: standing.chain.current.signed.message,
    terms: sale.terms,
    offer: sale.offer,
    buyer,
    ledger: sale.ledger,
    approvedSale: null,
    profile: TESTNET_DEMO_PROFILE,
    signingKey: sale.signingKey,
    revoked: false,
    now,
  })
  if (verdict.result !== 'approved') throw new SellerMandateRefusal(verdict.reason, 'sale')
}
