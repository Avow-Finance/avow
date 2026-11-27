import {
  type AvowDomain,
  checkSellerMandate,
  parseSellerMandates,
  type ReasonCode,
  SANDBOX_PATHS,
  type SaleCounterparty,
  SERVICE_CATEGORY,
  type SellerLedger,
  type SellerMandateChain,
  type ServiceOfferVersion,
  type SignatureCheck,
  sellerMandateChainProblem,
  sellerOfferProblem,
  sellingLimitFor,
  TESTNET_DEMO_PROFILE,
  type Terms,
} from '@avow-finance/spec'
import type { Address, Hex } from 'viem'
import { AvowApiError, type avowRequests } from '../http.js'

/**
 * A selling agent's own reading of its seller's mandate, and the checks it holds itself to before
 * it lists an offer or quotes a sale. A seller's mandate is the authority its business's
 * administrator signed for its signing key. Avow doesn't enforce a seller's limits yet, and no lock
 * or keychain holds a seller to them, so this agent's own SDK is the only thing that does.
 */

/** What a selling agent is told when no seller's mandate is in force for its signing key. */
export const NO_SELLER_MANDATE =
  "No seller's mandate is in force for this agent's signing key, so its key is its only limit and it sells as it did before. Avow doesn't enforce seller limits yet."

/** What a selling agent is told when it acts under a seller's mandate. */
export const sellerMandateNotice = (hash: Hex) =>
  `This agent checked the sale against its seller's mandate ${hash}, which its own SDK holds it to. Avow doesn't enforce seller limits yet.`

/**
 * Where a selling agent stands. With no mandate in force it sells as it did before, and says so.
 * With one, it acts under its newest mandate, read as one chain the business account signed.
 */
export type SellerStanding =
  | { inForce: false; notice: string }
  | { inForce: true; chain: SellerMandateChain; notice: string }

/** A sale or an offer the seller's mandate doesn't allow, with the spec's reason for it. */
export class SellerMandateRefusal extends Error {
  readonly reason: ReasonCode
  constructor(reason: ReasonCode, what: string) {
    super(`The seller's mandate doesn't allow ${what} (${reason})`)
    this.name = 'SellerMandateRefusal'
    this.reason = reason
  }
}

/**
 * Reads every seller's mandate the agent's signing key has held from Avow, signed by that key, and
 * checks they link into one chain the business account signed, with no revocation of the key. A
 * 404 means Avow holds no mandate for the key, or doesn't serve the route yet, and either way none
 * is in force. A chain that doesn't read as one, or a revoked key, throws a refusal with the
 * spec's reason, and anything else that fails throws as it came, so the agent never sells under a
 * mandate it couldn't read.
 */
export async function readSellerStanding(r: {
  asSupplier: ReturnType<typeof avowRequests>
  domain: AvowDomain
  agent: { businessId: string; account: Address; signingKey: Address }
  isAccountSignature: SignatureCheck
}): Promise<SellerStanding> {
  const expected = { chainId: r.domain.chainId, lock: r.domain.verifyingContract }
  const served = await r
    .asSupplier({
      domain: r.domain,
      path: SANDBOX_PATHS.sellerMandates,
      body: {},
      read: (json) => parseSellerMandates(json, expected),
    })
    .catch((error: unknown) => {
      if (error instanceof AvowApiError && error.definite && error.status === 404) return null
      throw error
    })
  if (served === null) return { inForce: false, notice: NO_SELLER_MANDATE }
  const chain = await sellerMandateChainProblem(
    served,
    { domain: r.domain, ...r.agent },
    r.isAccountSignature,
  )
  if (!chain.ok) throw new SellerMandateRefusal(chain.reason, 'this agent to sell')
  return {
    inForce: true,
    chain: chain.value,
    notice: sellerMandateNotice(chain.value.current.hash),
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
  if (reason) throw new SellerMandateRefusal(reason, 'this offer')
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

const DAY = 86_400n

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
  if (verdict.result !== 'approved') throw new SellerMandateRefusal(verdict.reason, 'this sale')
}
