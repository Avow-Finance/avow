import type { Address, Hex } from 'viem'
import { z } from 'zod'
import { canonicalJson } from './canonical.js'
import type { TermsAgreement } from './eip712.js'
import { bytes32, hexBytes, sameHex as same, u64 } from './json-fields.js'
import { type JobBuyer, jobBuyerJson, MAILBOX_INBOX_MAX } from './mailbox.js'
import { type OrderStage, orderStagesJson, readOrNull } from './order-wire.js'
import type { ReasonCode } from './reasons.js'
import {
  offerVersionId,
  SERVICE_ACCEPT_WITHIN,
  SERVICE_CATEGORY,
  SERVICE_QUANTITY_MAX,
  type ServiceOfferVersion,
  type ServiceTerms,
  serviceOfferQuote,
  serviceOfferTerms,
  serviceOfferVersionJson,
  soundOfferVersion,
} from './service.js'
import { termsHash } from './terms.js'
import { orderIdJson } from './test-customer.js'
import { serviceTermsJson, termsAgreementJson, toWire } from './wire.js'

/**
 * A service order, which is to carry one booking of a supplier's offer between two businesses'
 * agents through Avow's sandbox mailbox, wherever each agent runs. It takes the four steps a job
 * order takes, each signed by the key that sends it.
 *
 * 1. The buyer's agent sends the offer version it wants, how many units, and the moment the terms
 *    are built from. Nothing is reserved.
 * 2. The supplier's agent reads the order from its inbox, checks the version is one it published,
 *    and sends the terms `serviceOfferTerms` builds from the order with its signed agreement.
 * 3. The buyer's agent checks the quote against its own order, funds the commitment under its
 *    mandate, and tells the mailbox, which reads the reserve on chain.
 * 4. The supplier's agent accepts on chain with its own signing key, and tells the mailbox, which
 *    reads the acceptance on chain.
 *
 * A service order has paths and a shape of its own, so a reader that knows only job orders never
 * meets one. This module holds the messages and what each side can check for itself. Avow's
 * testnet sandbox serves the paths.
 */

/** How far ahead of a reader's clock an order's build moment may be, in seconds. */
export const SERVICE_ORDER_CLOCK_SKEW = 60n

/**
 * How long before the supplier's deadline to accept an order has to lapse, in seconds. A reserve
 * funded at the order's last moment still leaves the supplier this long to accept it.
 */
export const SERVICE_ORDER_ACCEPT_MARGIN = 5n * 60n

/**
 * Whether something that stands until `expiry` leaves the supplier its time to accept terms built
 * at `builtAt`. The terms give the supplier `SERVICE_ACCEPT_WITHIN` from the build moment, so a
 * reserve funded at the last moment still leaves it `SERVICE_ORDER_ACCEPT_MARGIN`.
 */
export const leavesTimeToAccept = (expiry: bigint, builtAt: bigint): boolean =>
  expiry + SERVICE_ORDER_ACCEPT_MARGIN <= builtAt + SERVICE_ACCEPT_WITHIN

/** What a buyer's agent sends to order units of a business's offer. */
export interface ServiceOrderRequest {
  orderId: string
  /** The commitment id the buyer chose, which the quote's agreement has to name. */
  commitmentId: Hex
  /**
   * The offer version ordered, whole. It names the supplier the order is for, and the supplier
   * checks it against the versions it published.
   */
  offer: ServiceOfferVersion
  /** How many units are ordered. */
  quantity: number
  /** The moment the terms are built from, in unix seconds. Every time in them counts from it. */
  builtAt: bigint
  /** When the order lapses unless it's funded, in unix seconds. */
  expiry: bigint
}

/**
 * The supplier's answer to a service order: the terms, the salt they hash under, and its signing
 * key's agreement to that hash for the order's commitment.
 */
export interface ServiceQuote {
  terms: ServiceTerms
  salt: Hex
  agreement: TermsAgreement
  supplierSignature: Hex
}

interface ServiceOrderBase extends ServiceOrderRequest {
  buyer: JobBuyer
  requestedAt: bigint
}

/** A service order as the mailbox answers it, to either side or to either business's console. */
export type ServiceOrder = ServiceOrderBase & OrderStage<ServiceQuote>

/** What the terms' arbiter and day-90 share come from, which Avow's approvals name. */
export interface ServiceSettlement {
  arbiter: Address
  day90SupplierShareBps: number
}

/**
 * Why an order can't be taken at `now`, or null when it can. Its offer has to be one the template
 * takes, in a quantity the offer takes. Its times have to leave the supplier room to accept: the
 * terms give the supplier `SERVICE_ACCEPT_WITHIN` from the build moment, so the order lapses
 * `SERVICE_ORDER_ACCEPT_MARGIN` before that.
 *
 * It can't tell whether the supplier ever published the offer. A buyer can write any offer it
 * likes under a supplier's name, so the supplier checks that with `publishedOffer` before it
 * quotes, and nothing is agreed until it does.
 */
export function serviceOrderProblem(order: ServiceOrderRequest, now: bigint): ReasonCode | null {
  if (order.builtAt > now + SERVICE_ORDER_CLOCK_SKEW) return 'message.invalid'
  if (order.expiry <= now) return 'message.expired'
  if (order.expiry <= order.builtAt) return 'message.invalid'
  if (!leavesTimeToAccept(order.expiry, order.builtAt)) return 'message.validity_too_long'
  try {
    // Hashing and pricing the offer refuse a version its rules refuse, text that can't be
    // written canonically, and a quantity the version doesn't take.
    offerVersionId(order.offer)
    serviceOfferQuote(order.offer, order.quantity)
  } catch {
    return 'terms.template_invalid'
  }
  return null
}

/**
 * The version among those a supplier published that an order's offer is, or null when it's none
 * of them. The supplier's agent runs it on every order before it quotes, since the offer in an
 * order is the buyer's copy and the buyer could have written anything.
 */
export function publishedOffer(
  order: Pick<ServiceOrderRequest, 'offer'>,
  published: readonly ServiceOfferVersion[],
): ServiceOfferVersion | null {
  let ordered: Hex
  try {
    ordered = offerVersionId(order.offer)
  } catch {
    return null
  }
  return published.find((version) => offerVersionId(version) === ordered) ?? null
}

/** Terms with their arbiter in lower case, as the wire carries an address. */
const onWire = (terms: ServiceTerms) =>
  canonicalJson(
    toWire({
      ...terms,
      resolution: {
        ...terms.resolution,
        arbiter: terms.resolution.arbiter.toLowerCase(),
      },
    }),
  )

/**
 * Why a supplier's agreement isn't to these terms for this booking, or null when it is. It has to
 * carry the hash of the terms under the salt given, name the commitment and the supplier, and be
 * for a service. Given the buyer, it has to name the buyer's business and mandate too. It never
 * throws, and it leaves the supplier's signature and the agreement's expiry to its callers.
 */
export function serviceAgreementProblem(
  booking: {
    commitmentId: Hex
    supplier: string
    buyer?: Pick<JobBuyer, 'businessId' | 'mandateHash'>
  },
  terms: ServiceTerms,
  quote: Pick<ServiceQuote, 'salt' | 'agreement'>,
): ReasonCode | null {
  const { agreement } = quote
  try {
    if (!same(agreement.termsHash, termsHash(terms, quote.salt))) return 'terms.hash_mismatch'
  } catch {
    // A salt the hash refuses or text that can't be written canonically hashes to nothing.
    return 'order.terms_changed'
  }
  if (!same(agreement.commitmentId, booking.commitmentId)) return 'order.commitment_mismatch'
  if (agreement.category !== SERVICE_CATEGORY) return 'terms.category_mismatch'
  if (agreement.supplierBusinessId !== booking.supplier) return 'agreement.parties_mismatch'
  if (
    booking.buyer &&
    (agreement.buyerBusinessId !== booking.buyer.businessId ||
      !same(agreement.mandateHash, booking.buyer.mandateHash))
  ) {
    return 'agreement.parties_mismatch'
  }
  return null
}

/**
 * Why a quote doesn't answer its order, or null when it does. The quote's terms have to be the
 * ones `serviceOfferTerms` builds from the order, with nothing moved. Its agreement has to be for
 * a service, name the order's commitment and the offer's supplier, and carry the hash of those
 * terms under the quote's salt. Given the buyer, it has to name the buyer's business and mandate
 * too.
 *
 * It leaves two checks to others. The buyer's agent checks the agreement's expiry and its own
 * authority when it commits, and Avow checks the supplier's signature when it approves the
 * reserve. It never throws, whatever a quote that parsed holds.
 */
export function serviceQuoteProblem(
  order: Pick<ServiceOrderRequest, 'offer' | 'quantity' | 'builtAt' | 'commitmentId'> & {
    buyer?: Pick<JobBuyer, 'businessId' | 'mandateHash'>
  },
  quote: ServiceQuote,
  settlement: ServiceSettlement,
): ReasonCode | null {
  try {
    const expected = serviceOfferTerms(order.offer, order.quantity, order.builtAt, settlement)
    if (onWire(expected) !== onWire(quote.terms)) return 'order.terms_changed'
  } catch {
    // An offer the template refuses or text that can't be written canonically means the quote
    // isn't for these terms.
    return 'order.terms_changed'
  }
  return serviceAgreementProblem(
    {
      commitmentId: order.commitmentId,
      supplier: order.offer.supplier,
      ...(order.buyer ? { buyer: order.buyer } : {}),
    },
    quote.terms,
    quote,
  )
}

export const serviceOrderRequestJson = z
  .strictObject({
    orderId: orderIdJson,
    commitmentId: bytes32,
    offer: serviceOfferVersionJson,
    quantity: z.number().int().positive().max(SERVICE_QUANTITY_MAX),
    builtAt: u64,
    expiry: u64,
  })
  // An offer the template's rules refuse is refused where the order is read.
  .refine((order) => soundOfferVersion(order.offer) !== null)

export const serviceQuoteJson = z.strictObject({
  terms: serviceTermsJson,
  salt: bytes32,
  agreement: termsAgreementJson,
  supplierSignature: hexBytes,
})

const held = {
  ...serviceOrderRequestJson.shape,
  buyer: jobBuyerJson,
  requestedAt: u64,
}

export const serviceOrderJson = orderStagesJson(held, serviceQuoteJson)

/** An order as the mailbox answers it has to carry an offer the template takes, as a request does. */
const heldOrderJson = serviceOrderJson.refine((order) => soundOfferVersion(order.offer) !== null)

export const parseServiceOrderRequest = readOrNull(
  serviceOrderRequestJson as unknown as z.ZodType<ServiceOrderRequest>,
)
export const parseServiceQuote = readOrNull(serviceQuoteJson as unknown as z.ZodType<ServiceQuote>)
export const parseServiceOrder = readOrNull(heldOrderJson as unknown as z.ZodType<ServiceOrder>)
export const parseServiceInbox = readOrNull(
  z.strictObject({
    orders: z.array(heldOrderJson).max(MAILBOX_INBOX_MAX),
  }) as unknown as z.ZodType<{ orders: ServiceOrder[] }>,
)
