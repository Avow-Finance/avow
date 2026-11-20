import type { Address, Hex } from 'viem'
import { z } from 'zod'
import { canonicalJson } from './canonical.js'
import type { TermsAgreement } from './eip712.js'
import { bytes32, hexBytes, u64, u256 } from './json-fields.js'
import {
  type JobBuyer,
  jobBuyerJson,
  MAILBOX_INBOX_MAX,
  MAILBOX_ORDER_LIFETIME_MAX,
  type MailboxReserve,
} from './mailbox.js'
import type { ReasonCode } from './reasons.js'
import {
  SERVICE_ACCEPT_WITHIN,
  type ServiceOfferVersion,
  type ServiceTerms,
  serviceOfferQuote,
  serviceOfferTerms,
  serviceOfferVersionJson,
} from './service.js'
import { termsHash } from './terms.js'
import { orderIdJson } from './test-customer.js'
import { serviceTermsJson, termsAgreementJson, toWire } from './wire.js'

/**
 * A service order, which carries one booking of a supplier's offer between two businesses' agents
 * through Avow's sandbox mailbox, wherever each agent runs. It takes the same four steps a job
 * order does, each signed by the key that sends it.
 *
 * 1. The buyer's agent sends the offer version it wants, how many units, and the moment the terms
 *    are built from. Nothing is reserved.
 * 2. The supplier's agent reads the order from its inbox, checks the version is its own, and sends
 *    the terms `serviceOfferTerms` builds from the order with its signed agreement to them.
 * 3. The buyer's agent checks the quote against its own order, funds the commitment under its
 *    mandate, and tells the mailbox, which reads the reserve on chain.
 * 4. The supplier's agent accepts on chain with its own signing key, and tells the mailbox, which
 *    reads the acceptance on chain.
 *
 * A service order has paths and a shape of its own, so a reader that knows only job orders never
 * meets one. Both sides build the terms from the same three things the order carries, so neither
 * has to take the other's word for a price or a deadline.
 */

/** How far ahead of a reader's clock an order's build moment may be, in seconds. */
export const SERVICE_ORDER_CLOCK_SKEW = 60n

/** What a buyer's agent sends to order units of another business's offer. */
export interface ServiceOrderRequest {
  orderId: string
  /** The commitment id the buyer chose, which the quote's agreement has to name. */
  commitmentId: Hex
  supplierBusinessId: string
  /** The offer version ordered, whole, so the supplier can check it against its own. */
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
export type ServiceOrder =
  | (ServiceOrderBase & { status: 'requested' })
  | (ServiceOrderBase & { status: 'expired'; quote: ServiceQuote | null })
  | (ServiceOrderBase & { status: 'quoted'; quote: ServiceQuote })
  | (ServiceOrderBase & { status: 'reserved'; quote: ServiceQuote; reserve: MailboxReserve })
  | (ServiceOrderBase & {
      status: 'accepted'
      quote: ServiceQuote
      reserve: MailboxReserve
      /** The acceptance's transaction when the supplier's agent saw it land, or null. */
      acceptedIn: Hex | null
    })

/** What the terms' arbiter and day-90 share come from, which Avow's approvals name. */
export interface ServiceSettlement {
  arbiter: Address
  day90SupplierShareBps: number
}

/**
 * Why an order can't be taken at `now`, or null when it can. The offer has to be the ordered
 * business's own, and one it could sell in that quantity. The order's times have to leave the
 * supplier room to accept: the terms give it `SERVICE_ACCEPT_WITHIN` from the build moment, so an
 * order that could still be funded after that would reserve money nobody can accept.
 */
export function serviceOrderProblem(order: ServiceOrderRequest, now: bigint): ReasonCode | null {
  if (order.builtAt > now + SERVICE_ORDER_CLOCK_SKEW) return 'message.invalid'
  if (order.expiry <= now) return 'message.expired'
  if (order.expiry <= order.builtAt) return 'message.invalid'
  if (
    order.expiry - order.builtAt > MAILBOX_ORDER_LIFETIME_MAX ||
    order.expiry >= order.builtAt + SERVICE_ACCEPT_WITHIN
  ) {
    return 'message.validity_too_long'
  }
  if (order.offer.supplier !== order.supplierBusinessId) return 'order.supplier_mismatch'
  try {
    // Pricing the order refuses a version its rules refuse and a quantity it doesn't take.
    serviceOfferQuote(order.offer, order.quantity)
  } catch {
    return 'terms.template_invalid'
  }
  return null
}

/**
 * The terms a service order books, which both sides build for themselves. Throws for an order
 * `serviceOrderProblem` refuses on its offer or its quantity.
 */
export const serviceOrderTerms = (
  order: Pick<ServiceOrderRequest, 'offer' | 'quantity' | 'builtAt'>,
  settlement: ServiceSettlement,
): ServiceTerms => serviceOfferTerms(order.offer, order.quantity, order.builtAt, settlement)

/**
 * Why a quote doesn't answer its order, or null when it does. The quote's terms have to be the
 * ones the order builds, with nothing moved, its agreement has to name the order's commitment, and
 * the agreement's hash has to be the hash of those terms under the quote's salt. The supplier's
 * signature over the agreement is Avow's to check when it approves the reserve.
 */
export function serviceQuoteProblem(
  order: Pick<ServiceOrderRequest, 'offer' | 'quantity' | 'builtAt' | 'commitmentId'>,
  quote: ServiceQuote,
  settlement: ServiceSettlement,
): ReasonCode | null {
  let expected: ServiceTerms
  try {
    expected = serviceOrderTerms(order, settlement)
  } catch {
    return 'terms.template_invalid'
  }
  if (canonicalJson(toWire(expected)) !== canonicalJson(toWire(quote.terms))) {
    return 'order.terms_changed'
  }
  if (quote.agreement.commitmentId.toLowerCase() !== order.commitmentId.toLowerCase()) {
    return 'order.commitment_mismatch'
  }
  if (quote.agreement.termsHash.toLowerCase() !== termsHash(quote.terms, quote.salt)) {
    return 'terms.hash_mismatch'
  }
  return null
}

const businessIdJson = z.string().min(1).max(100)

export const serviceOrderRequestJson = z.strictObject({
  orderId: orderIdJson,
  commitmentId: bytes32,
  supplierBusinessId: businessIdJson,
  offer: serviceOfferVersionJson,
  quantity: z.number().int().positive(),
  builtAt: u64,
  expiry: u64,
})

export const serviceQuoteJson = z.strictObject({
  terms: serviceTermsJson,
  salt: bytes32,
  agreement: termsAgreementJson,
  supplierSignature: hexBytes,
})

const reserveJson = z.strictObject({ fundedIn: bytes32.nullable(), amount: u256, acceptBy: u64 })

const base = { ...serviceOrderRequestJson.shape, buyer: jobBuyerJson, requestedAt: u64 }

export const serviceOrderJson = z.discriminatedUnion('status', [
  z.strictObject({ ...base, status: z.literal('requested') }),
  z.strictObject({ ...base, status: z.literal('expired'), quote: serviceQuoteJson.nullable() }),
  z.strictObject({ ...base, status: z.literal('quoted'), quote: serviceQuoteJson }),
  z.strictObject({
    ...base,
    status: z.literal('reserved'),
    quote: serviceQuoteJson,
    reserve: reserveJson,
  }),
  z.strictObject({
    ...base,
    status: z.literal('accepted'),
    quote: serviceQuoteJson,
    reserve: reserveJson,
    acceptedIn: bytes32.nullable(),
  }),
])

const read =
  <T>(schema: z.ZodType<T>) =>
  (json: unknown): T | null => {
    const parsed = schema.safeParse(json)
    return parsed.success ? parsed.data : null
  }

export const parseServiceOrderRequest = read(
  serviceOrderRequestJson as unknown as z.ZodType<ServiceOrderRequest>,
)
export const parseServiceQuote = read(serviceQuoteJson as unknown as z.ZodType<ServiceQuote>)
export const parseServiceOrder = read(serviceOrderJson as unknown as z.ZodType<ServiceOrder>)
export const parseServiceInbox = read(
  z.strictObject({
    orders: z.array(serviceOrderJson).max(MAILBOX_INBOX_MAX),
  }) as unknown as z.ZodType<{ orders: ServiceOrder[] }>,
)
