import { type Address, type Hex, hashTypedData, isAddressEqual, zeroHash } from 'viem'
import { z } from 'zod'
import { APPROVAL_RULE_CODES, type AvowDomain, domain, type Signed } from './eip712.js'
import { JOB, JOB_CATEGORY, validateJob } from './job.js'
import { address, bytes32, u64, u256 } from './json-fields.js'
import type { MandateCheck } from './mandate.js'
import { OPEN_TERMS, type OpenTerm } from './negotiation.js'
import { businessIdJson } from './order-wire.js'
import type { ReasonCode } from './reasons.js'
import {
  SERVICE,
  SERVICE_CATEGORY,
  SERVICE_NAME_MAX,
  SERVICE_QUANTITY_MAX,
  type ServiceOfferVersion,
  serviceOfferProblem,
  servicePrice,
  validateService,
} from './service.js'
import { SERVICE_ORDER_CLOCK_SKEW } from './service-order.js'
import { isFilled } from './text.js'
import {
  type ApprovalRule,
  type ChainedTerms,
  CURRENCIES,
  type Currency,
  type RemedyCharge,
  type Terms,
} from './types.js'
import { MESSAGE_VERSIONS } from './version.js'
import { approvalRuleJson, type Parsed, parseSigned } from './wire.js'

/**
 * A seller's mandate is the authority a business's administrator signs for one selling agent, bound
 * to that agent's signing key the way a buyer's mandate is bound to its agent key. It says what the
 * agent may sell and at what price, how much it may promise, how far ahead, on what charges, to
 * whom, and until when. The business account's root key signs it under the business's own lock.
 *
 * This module holds the message, its signed form and the check. `checkSellerMandate` is pure, so a
 * seller's own agent and Avow run the same code on the same inputs, and `sellerOfferProblem` is the
 * same check for an offer before anything is ordered. Those two are a seller's mandate's enforcing
 * layers. The lock belongs to the buyer and never reads a seller's mandate, and the signing key
 * moves no money, so no chain holds a seller to these limits.
 *
 * The limits are the seller's own. A reason this check gives is for the seller's agent, and
 * `buyerFacingReason` gives the one code a buyer hears in its place.
 *
 * Version 1 covers sales of `service/1` and `job/1`. A mandate binds one signing key and hands no
 * authority on to another agent.
 */

/** The mandate categories a seller's mandate can name, one for each template it covers. */
export const SELLER_CATEGORIES = [SERVICE_CATEGORY, JOB_CATEGORY] as const
export type SellerCategory = (typeof SELLER_CATEGORIES)[number]

/** The most lines of selling limits one mandate holds. */
export const SELLER_LIMITS_MAX = 50

/** The most businesses or countries one of a mandate's counterparty lists names. */
export const SELLER_LIST_MAX = 200

/** The most units a mandate can allow in a day, the largest count its signed form carries. */
export const SELLER_UNITS_MAX = 2 ** 32 - 1

/**
 * What the agent may sell of one item. An item is a service's name or a job's kind of work, and a
 * job counts as one unit whose price is the job's price.
 */
export interface SellingLimit {
  category: SellerCategory
  /**
   * The item this line is for, or null for every item in the category that has no line of its
   * own. A mandate with no line for an item and no such line for its category doesn't let the
   * agent sell it.
   */
  item: string | null
  /**
   * The lowest price for each unit, in micros, as the order's whole price divided by its units and
   * rounded down. Zero sets no floor.
   */
  minUnitPrice: bigint
  /** The most units in one order. */
  maxUnitsPerOrder: number
  /** The most units agreed in one day, across every order for this line. */
  maxUnitsPerDay: number
}

/** What one selling agent may promise for its business, signed by the business's administrator. */
export interface SellerMandate {
  mandateId: Hex
  businessId: string
  /** The business's account, whose root key signs the mandate. */
  account: Address
  /** The agent's signing key, which the business registered to quote and accept with. */
  signingKey: Address
  currency: Currency
  /** What the agent may sell, with a line for each item or category. */
  limits: readonly SellingLimit[]
  /** The most one order may come to, in micros. */
  maxOrderValue: bigint
  /**
   * The most the agent may have promised and not yet delivered, as the agreed price of every sale
   * from the moment it's agreed until it's delivered, in micros.
   */
  maxOutstanding: bigint
  /** The longest from agreement to the delivery deadline, in seconds. */
  maxDeliveryHorizon: bigint
  /** The lowest late-cancellation charge the agent may offer, as basis points of the price. */
  minLateCancellationBps: number
  /** The lowest no-show charge the agent may offer, as basis points of the price. */
  minNoShowBps: number
  /** The longest the agent may let a buyer cancel at no charge, in seconds from agreement. */
  maxFreeCancelWindow: bigint
  /** The only businesses the agent may sell to, by business id. Empty puts no such limit. */
  buyers: readonly string[]
  /** Businesses the agent may never sell to. */
  excludedBuyers: readonly string[]
  /**
   * Countries the agent may not sell into, as ISO 3166-1 alpha-2 codes. While any is named, a
   * buyer whose country isn't known is refused too.
   */
  excludedCountries: readonly string[]
  /** Whether a buyer has to have passed Avow's business check, which is simulated on testnet. */
  requiresBusinessCheck: boolean
  /**
   * The terms the agent may move when it bargains. Version 1 takes none, so every sale is on the
   * offer's own terms.
   */
  negotiable: readonly OpenTerm[]
  /** When a person decides a sale in place of the agent, by the order's whole price in micros. */
  approvalRule: ApprovalRule
  expiry: bigint
  nonce: bigint
  /** The hash of the seller's mandate this one replaces, for the same signing key, or null. */
  replaces: Hex | null
}

export const SELLER_MANDATE_TYPES = {
  SellingLimit: [
    { name: 'category', type: 'string' },
    { name: 'item', type: 'string' },
    { name: 'minUnitPrice', type: 'uint256' },
    { name: 'maxUnitsPerOrder', type: 'uint32' },
    { name: 'maxUnitsPerDay', type: 'uint32' },
  ],
  SellerMandate: [
    { name: 'mandateId', type: 'bytes32' },
    { name: 'businessId', type: 'string' },
    { name: 'account', type: 'address' },
    { name: 'signingKey', type: 'address' },
    { name: 'currency', type: 'string' },
    { name: 'limits', type: 'SellingLimit[]' },
    { name: 'maxOrderValue', type: 'uint256' },
    { name: 'maxOutstanding', type: 'uint256' },
    { name: 'maxDeliveryHorizon', type: 'uint64' },
    { name: 'minLateCancellationBps', type: 'uint16' },
    { name: 'minNoShowBps', type: 'uint16' },
    { name: 'maxFreeCancelWindow', type: 'uint64' },
    { name: 'buyers', type: 'string[]' },
    { name: 'excludedBuyers', type: 'string[]' },
    { name: 'excludedCountries', type: 'string[]' },
    { name: 'requiresBusinessCheck', type: 'bool' },
    { name: 'negotiable', type: 'string[]' },
    { name: 'approvalRule', type: 'uint8' },
    { name: 'approvalAbove', type: 'uint256' },
    { name: 'expiry', type: 'uint64' },
    { name: 'nonce', type: 'uint256' },
    { name: 'replaces', type: 'bytes32' },
  ],
} as const

/**
 * A seller's mandate's EIP-712 typed data, under the selling business's own lock. A line for every
 * other item signs an empty item name, and a mandate that replaces none signs a zero hash, which
 * `sellerMandateProblem` refuses as values of their own, so each mandate signs one way.
 */
export function sellerMandateTypedData(m: SellerMandate, d: AvowDomain) {
  return {
    domain: domain(d, MESSAGE_VERSIONS.SellerMandate),
    types: SELLER_MANDATE_TYPES,
    primaryType: 'SellerMandate' as const,
    message: {
      mandateId: m.mandateId,
      businessId: m.businessId,
      account: m.account,
      signingKey: m.signingKey,
      currency: m.currency,
      limits: m.limits.map((l) => ({
        category: l.category,
        item: l.item ?? '',
        minUnitPrice: l.minUnitPrice,
        maxUnitsPerOrder: l.maxUnitsPerOrder,
        maxUnitsPerDay: l.maxUnitsPerDay,
      })),
      maxOrderValue: m.maxOrderValue,
      maxOutstanding: m.maxOutstanding,
      maxDeliveryHorizon: m.maxDeliveryHorizon,
      minLateCancellationBps: m.minLateCancellationBps,
      minNoShowBps: m.minNoShowBps,
      maxFreeCancelWindow: m.maxFreeCancelWindow,
      buyers: [...m.buyers],
      excludedBuyers: [...m.excludedBuyers],
      excludedCountries: [...m.excludedCountries],
      requiresBusinessCheck: m.requiresBusinessCheck,
      negotiable: [...m.negotiable],
      approvalRule: APPROVAL_RULE_CODES[m.approvalRule.kind],
      approvalAbove: m.approvalRule.kind === 'above' ? m.approvalRule.amount : 0n,
      expiry: m.expiry,
      nonce: m.nonce,
      replaces: m.replaces ?? zeroHash,
    },
  }
}

/**
 * A seller's mandate's hash, which the business account's root key signs and a sale's record
 * names. It includes the domain, so a mandate for one lock or chain can't stand in for another.
 */
export function sellerMandateHash(m: SellerMandate, d: AvowDomain): Hex {
  return hashTypedData(sellerMandateTypedData(m, d))
}

const whole = (n: unknown, max: number) =>
  Number.isSafeInteger(n) && (n as number) >= 1 && (n as number) <= max
const share = (bps: unknown) =>
  Number.isSafeInteger(bps) && (bps as number) >= 0 && (bps as number) <= 10_000
const amount = (v: unknown, least: bigint) => typeof v === 'bigint' && v >= least
const distinct = (list: readonly string[]) => new Set(list).size === list.length
const isCategory = (v: unknown): v is SellerCategory =>
  (SELLER_CATEGORIES as readonly unknown[]).includes(v)

function limitProblem(l: SellingLimit): boolean {
  if (typeof l !== 'object' || l === null || !isCategory(l.category)) return true
  if (l.item !== null && !isFilled(l.item, SERVICE_NAME_MAX)) return true
  if (!amount(l.minUnitPrice, 0n)) return true
  if (!whole(l.maxUnitsPerOrder, SERVICE_QUANTITY_MAX)) return true
  return !whole(l.maxUnitsPerDay, SELLER_UNITS_MAX) || l.maxUnitsPerDay < l.maxUnitsPerOrder
}

const ids = (list: unknown): list is string[] =>
  Array.isArray(list) &&
  list.length <= SELLER_LIST_MAX &&
  list.every((id) => businessIdJson.safeParse(id).success) &&
  distinct(list)

/**
 * Checks a seller's mandate on its own, and gives `seller_mandate.invalid` for one that isn't well
 * formed. It names at least one line of limits and no item twice. Each line allows at least one
 * unit an order and no fewer a day. An order's most is above zero and within what may be
 * outstanding, the delivery horizon is above zero, and each charge floor is a share from 0 to 100%.
 * No business is both allowed and excluded, each country is a two-letter code, and no term is open
 * to bargaining, since version 1 sells on fixed terms. Every field has its declared type, so a
 * mandate that passes hashes one way only.
 */
export function sellerMandateProblem(m: SellerMandate): ReasonCode | null {
  const bad = 'seller_mandate.invalid' as const
  if (typeof m !== 'object' || m === null) return bad
  if (!businessIdJson.safeParse(m.businessId).success) return bad
  if (!(CURRENCIES as readonly unknown[]).includes(m.currency)) return bad
  if (!Array.isArray(m.limits) || m.limits.length < 1 || m.limits.length > SELLER_LIMITS_MAX) {
    return bad
  }
  if (m.limits.some(limitProblem)) return bad
  // A line is found by its category and item, so two lines for one pair would leave it unsaid
  // which applies. As JSON, a line for every other item stays apart from an item named "null".
  if (!distinct(m.limits.map((l) => JSON.stringify([l.category, l.item])))) return bad
  if (!amount(m.maxOrderValue, 1n) || !amount(m.maxOutstanding, m.maxOrderValue)) return bad
  if (!amount(m.maxDeliveryHorizon, 1n) || !amount(m.maxFreeCancelWindow, 0n)) return bad
  if (!share(m.minLateCancellationBps) || !share(m.minNoShowBps)) return bad
  if (!ids(m.buyers) || !ids(m.excludedBuyers)) return bad
  if (m.buyers.some((id) => m.excludedBuyers.includes(id))) return bad
  if (
    !Array.isArray(m.excludedCountries) ||
    m.excludedCountries.length > SELLER_LIST_MAX ||
    !m.excludedCountries.every((c) => typeof c === 'string' && /^[A-Z]{2}$/.test(c)) ||
    !distinct(m.excludedCountries)
  ) {
    return bad
  }
  if (typeof m.requiresBusinessCheck !== 'boolean') return bad
  if (!Array.isArray(m.negotiable) || m.negotiable.length > 0) return bad
  const rule = m.approvalRule
  if (typeof rule !== 'object' || rule === null || !Object.hasOwn(APPROVAL_RULE_CODES, rule.kind)) {
    return bad
  }
  if (rule.kind === 'above' && !amount(rule.amount, 0n)) return bad
  if (!amount(m.expiry, 0n) || !amount(m.nonce, 0n)) return bad
  if (m.replaces !== null && (!/^0x[0-9a-f]{64}$/.test(m.replaces) || m.replaces === zeroHash)) {
    return bad
  }
  return null
}

/**
 * The line of a mandate's limits that governs an item: the item's own line, or failing that the
 * category's line for every other item, or null when the mandate lets the agent sell neither.
 */
export function sellingLimitFor(
  mandate: Pick<SellerMandate, 'limits'>,
  category: string,
  item: string,
): SellingLimit | null {
  const inCategory = mandate.limits.filter((l) => l.category === category)
  return inCategory.find((l) => l.item === item) ?? inCategory.find((l) => l.item === null) ?? null
}

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
 * What a seller's mandate reads of a sale's terms, or the reason it can't read them. Terms under a
 * template version 1 doesn't cover give `seller_mandate.template_not_covered`, and terms their own
 * template refuses give that template's reason.
 */
export function saleFacts(terms: Terms | ChainedTerms): Parsed<SaleFacts> {
  if (terms.template === SERVICE) {
    const problem = validateService(terms)
    if (problem) return { ok: false, reason: problem }
    return {
      ok: true,
      value: {
        category: SERVICE_CATEGORY,
        item: terms.subject.item.name,
        units: terms.subject.quantity,
        price: servicePrice(terms),
        deliverBy: terms.subject.delivery.by,
      },
    }
  }
  if (terms.template === JOB) {
    const problem = validateJob(terms)
    if (problem) return { ok: false, reason: problem }
    return {
      ok: true,
      value: {
        category: JOB_CATEGORY,
        item: terms.subject.work.kind,
        units: 1,
        price: terms.consideration.amount,
        deliverBy: terms.subject.deliverBy,
      },
    }
  }
  return { ok: false, reason: 'seller_mandate.template_not_covered' }
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
    if (buyer.country === null || m.excludedCountries.includes(buyer.country)) return false
  }
  return !m.requiresBusinessCheck || buyer.passedBusinessCheck
}

const chargeOf = (charges: readonly RemedyCharge[], kind: RemedyCharge['kind']): bigint =>
  charges.find((c) => c.kind === kind)?.amount ?? 0n

const BPS = 10_000n

/** Whether a charge is at least `bps` of a price, with nothing lost to rounding. */
const atLeast = (charge: bigint, bps: number, price: bigint) => charge * BPS >= BigInt(bps) * price

/** The standing of a mandate before any sale is read: well formed, in force and this key's. */
function standingProblem(
  m: SellerMandate,
  r: { signingKey: Address; revoked: boolean; now: bigint },
): ReasonCode | null {
  const malformed = sellerMandateProblem(m)
  if (malformed) return malformed
  if (m.expiry <= r.now) return 'seller_mandate.expired'
  if (r.revoked) return 'seller_mandate.revoked'
  if (!isAddressEqual(r.signingKey, m.signingKey)) return 'seller_mandate.key_mismatch'
  return null
}

export interface SellerMandateCheckInput {
  mandate: SellerMandate
  /** The key that signed the seller's agreement to the terms. */
  signingKey: Address
  /** The sale's terms, which the caller has checked are the ones the offer builds. */
  terms: Terms | ChainedTerms
  buyer: SaleCounterparty
  /**
   * What the capacity ledger holds for this signing key apart from this sale: the units agreed
   * today under the line that governs the item, and the agreed price of every sale not yet
   * delivered, in micros.
   */
  ledger: { unitsToday: number; outstanding: bigint }
  revoked: boolean
  now: bigint
}

/**
 * The seller's mandate check, which Avow runs when a seller agrees to terms and again before it
 * approves the buyer's reserve, and a seller's agent runs before it signs. It's pure, and the
 * caller checks the mandate's signature first.
 *
 * The delivery horizon and the free-cancellation window count from `now`, with
 * `SERVICE_ORDER_CLOCK_SKEW` to spare, since an order's terms are built on another clock. The price
 * floor is on the whole price divided by the units, so no discount on quantity gets under it. A
 * sale above the approval rule's amount comes back as `needs_human`, for the caller to hold until
 * the administrator approves that sale.
 */
export function checkSellerMandate(input: SellerMandateCheckInput): MandateCheck {
  const { mandate: m, terms, now } = input
  const deny = (reason: ReasonCode): MandateCheck => ({ result: 'denied', reason })

  const standing = standingProblem(m, input)
  if (standing) return deny(standing)
  const sale = saleFacts(terms)
  if (!sale.ok) return deny(sale.reason)
  const { category, item, units, price, deliverBy } = sale.value
  if (terms.currency !== m.currency) return deny('seller_mandate.currency_not_allowed')
  const limit = sellingLimitFor(m, category, item)
  if (!limit) return deny('seller_mandate.item_not_allowed')

  if (price / BigInt(units) < limit.minUnitPrice) return deny('seller_mandate.under_price_floor')
  if (price > m.maxOrderValue) return deny('seller_mandate.over_order_value')
  if (units > limit.maxUnitsPerOrder) return deny('seller_mandate.over_units_per_order')
  if (deliverBy - now > m.maxDeliveryHorizon + SERVICE_ORDER_CLOCK_SKEW) {
    return deny('seller_mandate.over_delivery_horizon')
  }
  const { charges, freeCancelBy } = terms.remedies
  if (
    !atLeast(chargeOf(charges, 'lateCancellation'), m.minLateCancellationBps, price) ||
    !atLeast(chargeOf(charges, 'noShow'), m.minNoShowBps, price) ||
    freeCancelBy - now > m.maxFreeCancelWindow + SERVICE_ORDER_CLOCK_SKEW
  ) {
    return deny('seller_mandate.charges_not_allowed')
  }
  if (!counterpartyAllowed(m, input.buyer)) return deny('counterparty.not_eligible')

  const { unitsToday, outstanding } = input.ledger
  if (unitsToday + units > limit.maxUnitsPerDay) return deny('seller_mandate.over_daily_units')
  if (outstanding + price > m.maxOutstanding) return deny('seller_mandate.over_outstanding')

  const rule = m.approvalRule
  if (rule.kind === 'always' || (rule.kind === 'above' && price > rule.amount)) {
    return { result: 'needs_human', reason: 'approval.human_required' }
  }
  return { result: 'approved', reason: 'approved' }
}

/**
 * Why a seller's mandate doesn't let its agent list an offer version, or null when it does. The
 * offer is the mandate's business's, in its currency, for an item it may sell, at or above the
 * item's floor and within one order's most. One booking takes no more units than one order may,
 * the lead time is within the delivery horizon, and the charges and free cancellation keep to the
 * mandate's. An offer binds nobody, so this refuses early what the check would refuse at the sale.
 */
export function sellerOfferProblem(input: {
  mandate: SellerMandate
  signingKey: Address
  version: ServiceOfferVersion
  revoked: boolean
  now: bigint
}): ReasonCode | null {
  const { mandate: m, version: v } = input
  const standing = standingProblem(m, input)
  if (standing) return standing
  // An offer that names another business isn't this mandate's to judge.
  if (serviceOfferProblem(v) !== null || v.supplier !== m.businessId) return 'message.invalid'
  if (v.currency !== m.currency) return 'seller_mandate.currency_not_allowed'
  const limit = sellingLimitFor(m, SERVICE_CATEGORY, v.item.name)
  if (!limit) return 'seller_mandate.item_not_allowed'
  if (v.unitPrice < limit.minUnitPrice) return 'seller_mandate.under_price_floor'
  if (v.unitPrice > m.maxOrderValue) return 'seller_mandate.over_order_value'
  const r = v.rules
  if (r.maxPerBooking > limit.maxUnitsPerOrder) return 'seller_mandate.over_units_per_order'
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

/** A reason only the seller's own agent and administrators hear, since it tells of a limit. */
export type SellerMandateReason = Extract<ReasonCode, `seller_mandate.${string}`>

const isSellerMandateReason = (reason: ReasonCode): reason is SellerMandateReason =>
  reason.startsWith('seller_mandate.')

/**
 * The reason a buyer hears for a refusal the seller's mandate check gave. Every reason that tells
 * of the seller's mandate or one of its limits becomes `supplier.not_authorized`, which names
 * none. Any other reason passes through as it is.
 */
export function buyerFacingReason(reason: ReasonCode): Exclude<ReasonCode, SellerMandateReason> {
  return isSellerMandateReason(reason) ? 'supplier.not_authorized' : reason
}

const unitsJson = z.number().int()

/** A seller's mandate as JSON, with amounts and times as decimal strings and nothing else in it. */
export const sellerMandateJson = z.strictObject({
  mandateId: bytes32,
  businessId: businessIdJson,
  account: address,
  signingKey: address,
  currency: z.enum(CURRENCIES),
  limits: z
    .array(
      z.strictObject({
        category: z.enum(SELLER_CATEGORIES),
        item: z.string().min(1).max(SERVICE_NAME_MAX).nullable(),
        minUnitPrice: u256,
        maxUnitsPerOrder: unitsJson,
        maxUnitsPerDay: unitsJson,
      }),
    )
    .min(1)
    .max(SELLER_LIMITS_MAX),
  maxOrderValue: u256,
  maxOutstanding: u256,
  maxDeliveryHorizon: u64,
  minLateCancellationBps: z.number().int(),
  minNoShowBps: z.number().int(),
  maxFreeCancelWindow: u64,
  buyers: z.array(businessIdJson).max(SELLER_LIST_MAX),
  excludedBuyers: z.array(businessIdJson).max(SELLER_LIST_MAX),
  excludedCountries: z.array(z.string()).max(SELLER_LIST_MAX),
  requiresBusinessCheck: z.boolean(),
  negotiable: z.array(z.enum(OPEN_TERMS)),
  approvalRule: approvalRuleJson,
  expiry: u64,
  nonce: u256,
  replaces: bytes32.nullable(),
})

/**
 * Reads a signed seller's mandate from JSON, checking its envelope against the chain and, when
 * given, the selling business's lock. One `sellerMandateProblem` refuses reads as
 * `seller_mandate.invalid`. The signature is the caller's to check, against the business account.
 */
export function parseSellerMandate(
  json: unknown,
  expected: { chainId: number; lock?: Address },
): Parsed<Signed<SellerMandate>> {
  const signed = parseSigned(json, 'SellerMandate', sellerMandateJson, expected)
  if (!signed.ok) return signed
  const problem = sellerMandateProblem(signed.value.message)
  return problem ? { ok: false, reason: problem } : signed
}
