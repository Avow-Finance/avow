import { type Address, isAddress, isAddressEqual } from 'viem'
import { isChainedTerms } from './dependencies.js'
import { BPS, COUNTRY_CODE } from './fields.js'
import { JOB, JOB_CATEGORY } from './job.js'
import type { MandateCheck } from './mandate.js'
import type { TermsProfile } from './profiles.js'
import type { ReasonCode } from './reasons.js'
import { coversSale, type SaleContent, saleContentProblem } from './sale-approval.js'
import {
  type SellerCategory,
  type SellerMandate,
  type SellingLimit,
  sellerMandateProblem,
  sellingLimitFor,
} from './seller-mandate.js'
import {
  BUSINESS_ID_MAX,
  offerVersionFields,
  SERVICE,
  SERVICE_ACCEPT_WITHIN,
  SERVICE_CATEGORY,
  type ServiceOfferVersion,
  serviceOfferProblem,
  serviceOfferQuote,
  servicePrice,
  serviceTermsMatchOffer,
} from './service.js'
import { SERVICE_ORDER_CLOCK_SKEW } from './service-order.js'
import { validateChainedTerms, validateTerms } from './terms.js'
import { isSoundText } from './text.js'
import type { ChainedTerms, RemedyCharge, Terms } from './types.js'

/**
 * The seller's mandate check. `checkSellerMandate` reads a sale against the mandate its seller's
 * agent acts under, and `sellerOfferProblem` reads an offer before anyone orders. Both are pure
 * and never throw, so a seller's own agent and Avow can run the same code on the same inputs.
 * Whatever they're given that they can't read, they refuse.
 * The SDK's selling agent calls them before it lists, quotes or accepts, and Avow doesn't yet. The
 * lock belongs to the buyer and never reads a seller's mandate, and
 * the signing key moves no money, so no chain will hold a seller to these limits.
 *
 * The limits are the seller's own. A reason these checks give is for the seller's agent, and
 * `buyerFacingReason` gives what a buyer hears in its place.
 *
 * A limit on a length of time is held exactly wherever one clock measures both of its ends. A
 * service's lead time and free-cancellation window are lengths its offer states, so they meet the
 * mandate's with nothing to spare. A job's delivery deadline is measured from the clock of whoever
 * runs the check. Only the moment a service's terms are built from comes from another clock, the
 * buyer's, and it may run `SERVICE_ORDER_CLOCK_SKEW` ahead and no more.
 */

/** What a seller's mandate reads of a sale, whichever template its terms use. */
export interface SaleFacts {
  category: SellerCategory
  /** The service's name or the job's kind of work. */
  item: string
  /** The units sold, which is one for a job. */
  units: number
  /** The whole price, in micros. */
  price: bigint
  deliverBy: bigint
}

/**
 * What a seller's mandate reads of a sale's terms, or null for terms under a template version 1
 * doesn't cover. It takes terms `validateTerms` or `validateChainedTerms` passes, and whoever keeps
 * the capacity ledger reads the same facts to count a sale.
 */
export function saleFacts(terms: Terms | ChainedTerms): SaleFacts | null {
  // Version 1 terms have no template.
  if (!('template' in terms)) return null
  if (terms.template === SERVICE) {
    return {
      category: SERVICE_CATEGORY,
      item: terms.subject.item.name,
      units: terms.subject.quantity,
      price: servicePrice(terms),
      deliverBy: terms.subject.delivery.by,
    }
  }
  if (terms.template === JOB) {
    return {
      category: JOB_CATEGORY,
      item: terms.subject.work.kind,
      units: 1,
      price: terms.consideration.amount,
      deliverBy: terms.subject.deliverBy,
    }
  }
  return null
}

/**
 * Why a sale's terms aren't sound on their own, or null when they are, by the rules a buyer's
 * mandate check holds terms to. Job terms that name no compute are `dependency.required`, so a
 * job is read from its version 3 terms. Terms so malformed that reading them fails, or whose price,
 * deadlines or charges aren't whole amounts, are `terms.invalid`. The arbiter and the day-90 share
 * are Avow's to hold to its own when it approves the reserve.
 */
function termsProblem(terms: Terms | ChainedTerms, profile: TermsProfile): ReasonCode | null {
  try {
    const unsound = isChainedTerms(terms)
      ? validateChainedTerms(terms, profile)
      : validateTerms(terms, profile)
    // Version 1 terms have no template, and no mandate reads them.
    if (unsound || !('template' in terms)) return unsound
    const { acceptBy, freeCancelBy, charges } = terms.remedies
    const read: unknown[] = [terms.consideration.amount, acceptBy, freeCancelBy]
    for (const c of charges) read.push(c.amount, c.earliest)
    return read.every((v) => typeof v === 'bigint') ? null : 'terms.invalid'
  } catch {
    return 'terms.invalid'
  }
}

/** What Avow's records say of the business on the other side of a sale. */
export interface SaleCounterparty {
  businessId: string
  /** The country the business declared, as an ISO 3166-1 alpha-2 code, or null when unknown. */
  country: string | null
  /** Whether it passed Avow's business check. On testnet that check is simulated. */
  passedBusinessCheck: boolean
}

function counterpartyAllowed(m: SellerMandate, buyer: SaleCounterparty): boolean {
  if (m.buyers.length > 0 && !m.buyers.includes(buyer.businessId)) return false
  if (m.excludedBuyers.includes(buyer.businessId)) return false
  if (m.excludedCountries.length > 0) {
    // Anything but a country code is an unknown country, which a mandate that excludes any refuses.
    const known = typeof buyer.country === 'string' && COUNTRY_CODE.test(buyer.country)
    if (!known || m.excludedCountries.includes(buyer.country as string)) return false
  }
  return !m.requiresBusinessCheck || buyer.passedBusinessCheck === true
}

const chargeOf = (charges: readonly RemedyCharge[], kind: RemedyCharge['kind']): bigint =>
  charges.find((c) => c.kind === kind)?.amount ?? 0n

/** Whether a charge is at least `bps` of a price, with nothing lost to rounding. */
const atLeast = (charge: bigint, bps: number, price: bigint) => charge * BPS >= BigInt(bps) * price

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/** Who is acting under a mandate and when, as either check is told it. */
interface Standing {
  /** The key that signed the seller's agreement to the terms, or the request to list the offer. */
  signingKey: Address
  /** Whether the administrator revoked the mandate, by the caller's own records. */
  revoked: boolean
  now: bigint
}

/**
 * Why a mandate can't be acted under at all: what the check was told is malformed
 * (`message.invalid`), or the mandate isn't well formed, has ended, was revoked or binds another
 * key.
 */
function standingProblem(m: SellerMandate, s: Standing): ReasonCode | null {
  if (typeof s.now !== 'bigint' || s.now < 0n || typeof s.revoked !== 'boolean') {
    return 'message.invalid'
  }
  if (typeof s.signingKey !== 'string' || !isAddress(s.signingKey)) return 'message.invalid'
  const malformed = sellerMandateProblem(m)
  if (malformed) return malformed
  if (m.expiry <= s.now) return 'seller_mandate.expired'
  if (s.revoked) return 'seller_mandate.revoked'
  if (!isAddressEqual(s.signingKey, m.signingKey)) return 'seller_mandate.key_mismatch'
  return null
}

/** What the capacity ledger holds for a signing key, apart from the sale being checked. */
export interface SellerLedger {
  /**
   * The units of every sale agreed this UTC day, and still able to bind the seller or already
   * binding it, that the same line of limits governs. `sellingLimitFor` gives the line for a
   * sale's category and item, which `saleFacts` reads from its terms.
   */
  unitsToday: number
  /** The agreed price of every such sale not yet delivered, whichever line governs it, in micros. */
  outstanding: bigint
}

const isLedger = (l: unknown): l is SellerLedger =>
  isObject(l) &&
  Number.isSafeInteger(l.unitsToday) &&
  (l.unitsToday as number) >= 0 &&
  typeof l.outstanding === 'bigint' &&
  l.outstanding >= 0n

export interface SellerMandateCheckInput extends Standing {
  mandate: SellerMandate
  /** The sale's terms: a service's, or a job's version 3 terms. */
  terms: Terms | ChainedTerms
  /**
   * The offer version a service's terms book, which they have to be exactly the terms of, so a
   * sale is on the offer's own terms and nothing in it was moved. Null for a job, which books no
   * offer.
   */
  offer: ServiceOfferVersion | null
  buyer: SaleCounterparty
  ledger: SellerLedger
  /**
   * A sale the administrator approved under this mandate, or null for none. A sale a person has to
   * decide passes only when it is exactly this one, and a job never does, since no job is approved
   * this way yet. The check reads only what it's handed. The caller hands it an approval that is
   * approved, within `SALE_APPROVAL_LASTS` of its approval, and either unused or used by this same
   * sale, so a sale checked when it's agreed and again when its reserve is approved passes both
   * times. The caller marks the approval used by this sale in the same step that records the
   * sale, so no second sale is made on it. A value that isn't a well-formed sale is refused.
   */
  approvedSale: SaleContent | null
  /** The profile the terms have to be sound under, as for a buyer's mandate check. */
  profile: TermsProfile
}

/**
 * Why a line of limits and the mandate's lengths and charges don't allow an offer version, or null
 * when they do. The unit price is at or above the line's floor, the lead time is within the
 * delivery horizon, each charge's share is at or above the mandate's lowest, and free cancellation
 * lasts no longer than the mandate's longest. Each is compared exactly, since an offer states them
 * as amounts, shares and lengths of time, with no clock in them.
 */
function offerLimitProblem(
  m: SellerMandate,
  limit: SellingLimit,
  v: ServiceOfferVersion,
): ReasonCode | null {
  if (v.unitPrice < limit.minUnitPrice) return 'seller_mandate.under_price_floor'
  const r = v.rules
  if (r.leadTime > m.maxDeliveryHorizon) return 'seller_mandate.over_delivery_horizon'
  if (
    r.lateCancellationBps < m.minLateCancellationBps ||
    r.noShowBps < m.minNoShowBps ||
    r.freeCancelWindow > m.maxFreeCancelWindow
  ) {
    return 'seller_mandate.charges_not_allowed'
  }
  return null
}

/**
 * Why a job's terms go past a line's floor or the mandate's horizon and charges, or null when they
 * don't. The horizon runs from `now`, on the clock of whoever runs the check, to the delivery
 * deadline, and is held exactly. Each charge is at least its share of the price, and a no-show can
 * be reported by the delivery deadline, since a charge nobody can report in time is no charge.
 *
 * A job's free cancellation ends when work starts, and whoever agrees the job agrees when that
 * is, up to its delivery. The mandate's longest free cancellation is for a service and doesn't
 * read a job, so nothing here bounds how long a job's buyer can cancel at no charge.
 */
function jobLimitProblem(
  m: SellerMandate,
  limit: SellingLimit,
  sale: SaleFacts,
  charges: readonly RemedyCharge[],
  now: bigint,
): ReasonCode | null {
  if (sale.price < limit.minUnitPrice) return 'seller_mandate.under_price_floor'
  if (sale.deliverBy - now > m.maxDeliveryHorizon) return 'seller_mandate.over_delivery_horizon'
  const noShow = charges.find((c) => c.kind === 'noShow')
  if (
    !atLeast(chargeOf(charges, 'lateCancellation'), m.minLateCancellationBps, sale.price) ||
    !atLeast(noShow?.amount ?? 0n, m.minNoShowBps, sale.price) ||
    (noShow !== undefined && noShow.earliest > sale.deliverBy)
  ) {
    return 'seller_mandate.charges_not_allowed'
  }
  return null
}

/**
 * Reads a sale against the seller's mandate its agent acts under. The caller checks the mandate's
 * signature first, and brings whether it was revoked and what the ledger holds. Counting the
 * ledger and recording the sale in it have to be one step wherever sales can arrive at once.
 *
 * The buyer is checked before anything about the sale, so a business the mandate won't deal with
 * hears that and learns nothing else. A service's terms have to be exactly the ones its offer
 * builds, from a moment no more than `SERVICE_ORDER_CLOCK_SKEW` ahead of `now`. So its price for
 * each unit is the offer's, whatever the quantity, and a job's is its whole price. A sale inside
 * every limit and above the approval rule's amount comes back as `needs_human`, for the caller to
 * hold until the administrator approves that sale.
 */
export function checkSellerMandate(input: SellerMandateCheckInput): MandateCheck {
  try {
    return readSale(input)
  } catch {
    // Every value is checked before it's read, and one that still fails to read is refused.
    return { result: 'denied', reason: 'message.invalid' }
  }
}

function readSale(input: SellerMandateCheckInput): MandateCheck {
  const deny = (reason: ReasonCode): MandateCheck => ({ result: 'denied', reason })
  if (!isObject(input)) return deny('message.invalid')
  const { mandate: m, terms, offer, buyer, ledger, now } = input

  const standing = standingProblem(m, input)
  if (standing) return deny(standing)
  if (!isObject(buyer) || !isSoundText(buyer.businessId, BUSINESS_ID_MAX) || !isLedger(ledger)) {
    return deny('message.invalid')
  }
  if (!isObject(input.profile) || typeof input.profile.minContestWindow !== 'bigint') {
    return deny('message.invalid')
  }
  if (input.approvedSale !== null && saleContentProblem(input.approvedSale) !== null) {
    return deny('message.invalid')
  }
  if (!counterpartyAllowed(m, buyer)) return deny('counterparty.not_eligible')

  const unsound = termsProblem(terms, input.profile)
  if (unsound) return deny(unsound)
  const sale = saleFacts(terms)
  if (!sale) return deny('seller_mandate.template_not_covered')
  if (terms.currency !== m.currency) return deny('seller_mandate.currency_not_allowed')
  const limit = sellingLimitFor(m, sale.category, sale.item)
  if (!limit) return deny('seller_mandate.item_not_allowed')

  let past: ReasonCode | null
  if (terms.template === SERVICE) {
    // A service is sold from an offer, and a job from none.
    // The offer is the mandate's business's own, as at listing.
    if (!isObject(offer) || serviceOfferProblem(offer) !== null) return deny('message.invalid')
    if (offer.supplier !== m.businessId) return deny('message.invalid')
    if (!serviceTermsMatchOffer(terms, offer)) return deny('order.terms_changed')
    // The offer's lead time back from the delivery deadline is the moment the terms were built
    // from, which the buyer's order named on the buyer's clock.
    const builtAt = sale.deliverBy - offer.rules.leadTime
    if (builtAt > now + SERVICE_ORDER_CLOCK_SKEW) return deny('message.invalid')
    // Terms whose supplier can no longer accept are a sale nobody can make.
    if (terms.remedies.acceptBy <= now) return deny('message.expired')
    past = offerLimitProblem(m, limit, offer)
  } else {
    if (offer !== null) return deny('message.invalid')
    past = jobLimitProblem(m, limit, sale, terms.remedies.charges, now)
  }
  if (past) return deny(past)
  if (sale.price > m.maxOrderValue) return deny('seller_mandate.over_order_value')
  if (sale.units > limit.maxUnitsPerOrder) return deny('seller_mandate.over_units_per_order')

  if (ledger.unitsToday + sale.units > limit.maxUnitsPerDay) {
    return deny('seller_mandate.over_daily_units')
  }
  if (ledger.outstanding + sale.price > m.maxOutstanding) {
    return deny('seller_mandate.over_outstanding')
  }

  const rule = m.approvalRule
  if (rule.kind === 'always' || (rule.kind === 'above' && sale.price > rule.amount)) {
    // A person decides this sale, and it passes only as the exact sale a person approved. Every
    // limit above held it first, so an approval never lifts one.
    // The terms are exactly the ones this offer version builds, so the version and the units are
    // the whole sale.
    if (offer !== null) {
      const content = {
        signingKey: m.signingKey,
        buyer: buyer.businessId,
        offer,
        units: sale.units,
      }
      if (coversSale(input.approvedSale, content)) return { result: 'approved', reason: 'approved' }
    }
    return { result: 'needs_human', reason: 'approval.human_required' }
  }
  return { result: 'approved', reason: 'approved' }
}

/**
 * The content of a service's sale, as a person would approve it, or null where there's none to
 * approve: terms that aren't a service's, terms that aren't exactly the ones this offer version
 * builds, or a sale whose content `saleContentProblem` refuses. A selling agent asks for approval
 * of exactly this, and the check passes a sale a person has to decide only when its content is the
 * one approved.
 */
export function saleContentOf(
  terms: Terms | ChainedTerms,
  offer: ServiceOfferVersion,
  sale: { signingKey: Address; buyer: string },
): SaleContent | null {
  try {
    if (!('template' in terms) || terms.template !== SERVICE) return null
    const facts = saleFacts(terms)
    if (!facts || !serviceTermsMatchOffer(terms, offer)) return null
    // A plain copy, read once, so what's returned is what was checked.
    const content: SaleContent = structuredClone({
      signingKey: sale.signingKey.toLowerCase() as Address,
      buyer: sale.buyer,
      offer: offerVersionFields(offer),
      units: facts.units,
    })
    return saleContentProblem(content) === null ? content : null
  } catch {
    return null
  }
}

/**
 * Why a seller's mandate doesn't let its agent list an offer version, or null when it does. The
 * offer is the mandate's business's, in its currency, for an item it may sell, and within the
 * limits `checkSellerMandate` holds an offer to. Its largest booking is within the units and the
 * value one order may come to. So every booking the offer invites is one the check would pass on
 * these counts, before it reads the buyer, the ledger or the approval rule. An offer binds nobody,
 * and this refuses early what the check would refuse at the sale.
 */
export function sellerOfferProblem(
  input: Standing & { mandate: SellerMandate; version: ServiceOfferVersion },
): ReasonCode | null {
  try {
    return readOffer(input)
  } catch {
    return 'message.invalid'
  }
}

function readOffer(
  input: Standing & { mandate: SellerMandate; version: ServiceOfferVersion },
): ReasonCode | null {
  if (!isObject(input)) return 'message.invalid'
  const { mandate: m, version: v } = input
  const standing = standingProblem(m, input)
  if (standing) return standing
  // An offer that names another business isn't this mandate's to judge.
  if (!isObject(v) || serviceOfferProblem(v) !== null || v.supplier !== m.businessId) {
    return 'message.invalid'
  }
  // A price so small that one unit's charges round to nothing builds no terms, and this throws.
  serviceOfferQuote(v, 1)
  if (v.currency !== m.currency) return 'seller_mandate.currency_not_allowed'
  const limit = sellingLimitFor(m, SERVICE_CATEGORY, v.item.name)
  if (!limit) return 'seller_mandate.item_not_allowed'
  const past = offerLimitProblem(m, limit, v)
  if (past) return past
  if (v.rules.maxPerBooking > limit.maxUnitsPerOrder) return 'seller_mandate.over_units_per_order'
  if (v.unitPrice * BigInt(v.rules.maxPerBooking) > m.maxOrderValue) {
    return 'seller_mandate.over_order_value'
  }
  return null
}

/**
 * The longest before its acceptance deadline that Avow approves a reserve for a sale, in seconds.
 * It's the time a service's terms give its supplier to accept.
 */
export const SALE_ACCEPT_WITHIN_MAX = SERVICE_ACCEPT_WITHIN

/**
 * Why Avow won't approve a buyer's reserve for a sale yet, or null when it will. A sale whose
 * supplier could still accept more than `SALE_ACCEPT_WITHIN_MAX` after `now`, by the clock of
 * whoever approves, is `approval.acceptance_too_far`, and its buyer asks again closer to the
 * deadline. The rule is exact, with nothing to spare for another clock. It bounds how long a
 * reserve can still be accepted after its seller's mandate ends or is revoked, since the lock
 * takes an acceptance until that deadline whatever the mandate says by then. A job can still run
 * for days after its supplier accepts. Whether the deadline has already passed is the reserve
 * check's own to say.
 */
export function saleApprovalProblem(
  terms: { remedies: { acceptBy: bigint } },
  now: bigint,
): ReasonCode | null {
  const acceptBy = isObject(terms) && isObject(terms.remedies) ? terms.remedies.acceptBy : null
  if (typeof acceptBy !== 'bigint' || typeof now !== 'bigint') return 'message.invalid'
  return acceptBy - now > SALE_ACCEPT_WITHIN_MAX ? 'approval.acceptance_too_far' : null
}

/**
 * The answers of the seller's mandate check a buyer hears as they are. A buyer acts on hearing
 * that its seller won't deal with it. `approval.human_required` isn't here, since Avow takes no
 * request to approve one sale yet, so a buyer told to wait would wait for nothing. It joins this
 * list once Avow takes that request.
 */
export const BUYER_HEARS = [
  'approved',
  'counterparty.not_eligible',
] as const satisfies readonly ReasonCode[]

export type BuyerFacingReason = (typeof BUYER_HEARS)[number] | 'supplier.not_authorized'

/**
 * What a buyer hears for an answer the seller's mandate check gave. Every answer outside
 * `BUYER_HEARS` becomes `supplier.not_authorized`, which names no limit, so a reason added to the
 * check later reaches no buyer until someone lists it there. The amounts a mandate sets stay with
 * the seller. A buyer that varies its orders can still infer roughly where a limit sits from which
 * of them are refused.
 */
export function buyerFacingReason(reason: ReasonCode): BuyerFacingReason {
  const heard = BUYER_HEARS.find((r) => r === reason)
  return heard ?? 'supplier.not_authorized'
}
