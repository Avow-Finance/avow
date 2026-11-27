import { type Address, type Hex, hashTypedData, zeroHash } from 'viem'
import { z } from 'zod'
import { canonicalJson } from './canonical.js'
import { APPROVAL_RULE_CODES, type AvowDomain, domain, type Signed } from './eip712.js'
import {
  BUSINESS_ID,
  COUNTRY_CODE,
  isCount,
  isShare,
  LOWER_ADDRESS,
  LOWER_BYTES32,
} from './fields.js'
import { JOB_CATEGORY, JOB_KIND_MAX } from './job.js'
import { address, bytes32, u64, u256 } from './json-fields.js'
import { OPEN_TERMS, type OpenTerm } from './negotiation.js'
import type { ReasonCode } from './reasons.js'
import {
  BUSINESS_ID_MAX,
  SERVICE_CATEGORY,
  SERVICE_NAME_MAX,
  SERVICE_QUANTITY_MAX,
} from './service.js'
import { isPlainText, isSoundText } from './text.js'
import { type ApprovalRule, CURRENCIES, type Currency } from './types.js'
import { MESSAGE_VERSIONS } from './version.js'
import { approvalRuleJson, type Parsed, parseSigned } from './wire.js'

/**
 * A seller's mandate is the authority a business's administrator signs for one selling agent, bound
 * to that agent's signing key the way a buyer's mandate is bound to its agent key. It says what the
 * agent may sell and at what price, how much it may promise, how far ahead, on what charges, to
 * whom, and until when. The business account's root key signs it under the business's own lock.
 *
 * This module holds the message, what makes one well formed, its signed form and its JSON.
 * `checkSellerMandate` reads a sale against one, `sellerMandateChainProblem` follows the mandates
 * that replace one another, and a `SellerMandateRevocation` ends them. Nothing in this package
 * stores a mandate or a revocation, and a caller that does brings the result to the check.
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
   * agent sell it. An agent names its own items, so a line for an item can only loosen what the
   * category's line for every other item allows, never tighten it.
   */
  item: string | null
  /**
   * The lowest price for each unit, in micros, as the order's whole price divided by its units and
   * rounded down. Zero sets no floor.
   */
  minUnitPrice: bigint
  /** The most units in one order, which is one for a job. */
  maxUnitsPerOrder: number
  /** The most units agreed in one UTC day, across every order this line governs. */
  maxUnitsPerDay: number
}

/** What one selling agent may promise for its business, signed by the business's administrator. */
export interface SellerMandate {
  /**
   * 32 random bytes that name this mandate. A sale's record shows a buyer the mandate's hash, and
   * the bytes keep anyone from finding the limits behind that hash by guessing them.
   */
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
  /**
   * The longest the agent may let a buyer of a service cancel at no charge, in seconds from
   * agreement. A job's free cancellation always ends when work starts, so this doesn't read a job.
   */
  maxFreeCancelWindow: bigint
  /** The only businesses the agent may sell to, by business id. Empty puts no such limit. */
  buyers: readonly string[]
  /** Businesses the agent may never sell to, which a mandate names only when `buyers` is empty. */
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
  /**
   * When a person decides a sale in place of the agent, by the order's whole price in micros. An
   * `above` rule's amount is more than zero and under `maxOrderValue`, since `always` and `never`
   * say the rest.
   */
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
 * `sellerMandateProblem` refuses as values of their own. It takes a mandate `sellerMandateProblem`
 * passes, and may throw for one it refuses.
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

const uint = (v: unknown, bits: number, least = 0n): v is bigint =>
  typeof v === 'bigint' && v >= least && v < 2n ** BigInt(bits)
const isCategory = (v: unknown): v is SellerCategory =>
  (SELLER_CATEGORIES as readonly unknown[]).includes(v)
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/** Whether an object holds exactly these keys, so nothing unsigned rides along with a mandate. */
const holdsOnly = (value: object, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((k) => Object.hasOwn(value, k))

/**
 * Whether a value is a list of at most `max` strings that each pass, in strictly ascending order
 * by code unit. A set written in one order has one hash, and nothing in it repeats.
 */
const ascendingList = (list: unknown, max: number, each: (v: unknown) => boolean): boolean =>
  Array.isArray(list) &&
  list.length <= max &&
  // `Array.from` turns a hole into undefined, which no rule passes.
  Array.from(list).every((v, i) => each(v) && (i === 0 || (list[i - 1] as string) < (v as string)))

const LIMIT_KEYS = SELLER_MANDATE_TYPES.SellingLimit.map((f) => f.name)
// The approval rule signs as two fields and travels as one.
const MANDATE_KEYS = SELLER_MANDATE_TYPES.SellerMandate.map((f) => f.name).filter(
  (name) => name !== 'approvalAbove',
)

/**
 * The fields that say which mandate this is and whose. Every other field is a term, the signing key
 * among them, since which key may sell is part of what an administrator grants.
 */
const IDENTITY_KEYS = [
  'mandateId',
  'businessId',
  'account',
  'nonce',
  'replaces',
] as const satisfies readonly (keyof SellerMandate)[]

/** The latest a seller's mandate may end, which is the last second of the year 9999. */
export const SELLER_EXPIRY_MAX = 253_402_300_799n

/**
 * What a seller's mandate grants: the key that may sell and every limit on what it sells, apart
 * from which mandate it is and whose. A selling agent asks for these, and the administrator signs a
 * mandate that carries exactly them.
 */
export type SellerMandateTerms = Omit<SellerMandate, (typeof IDENTITY_KEYS)[number]>

const TERMS_KEYS = MANDATE_KEYS.filter((k) => !(IDENTITY_KEYS as readonly string[]).includes(k))

/** Whether one line of limits is well formed on its own, under the mandate's most for an order. */
function isLimit(l: unknown, maxOrderValue: bigint): l is SellingLimit {
  if (!isObject(l) || !holdsOnly(l, LIMIT_KEYS) || !isCategory(l.category)) return false
  const job = l.category === JOB_CATEGORY
  // An agent writes an item's name and a person reads it on the card they sign, so it reads plainly.
  if (l.item !== null && !isPlainText(l.item, job ? JOB_KIND_MAX : SERVICE_NAME_MAX)) return false
  // A floor above the most an order may come to would be a line that sells nothing.
  if (!uint(l.minUnitPrice, 256) || l.minUnitPrice > maxOrderValue) return false
  if (!isCount(l.maxUnitsPerOrder, job ? 1 : SERVICE_QUANTITY_MAX)) return false
  return isCount(l.maxUnitsPerDay, SELLER_UNITS_MAX) && l.maxUnitsPerDay >= l.maxUnitsPerOrder
}

/** Whether line `a` comes strictly before line `b`: by category, then every other item, then by item. */
function comesBefore(a: SellingLimit, b: SellingLimit): boolean {
  if (a.category !== b.category) return a.category < b.category
  if (a.item === null || b.item === null) return a.item === null && b.item !== null
  return a.item < b.item
}

/** Whether a line for an item allows at least what its category's line for every other item does. */
const loosens = (named: SellingLimit, any: SellingLimit) =>
  named.minUnitPrice <= any.minUnitPrice &&
  named.maxUnitsPerOrder >= any.maxUnitsPerOrder &&
  named.maxUnitsPerDay >= any.maxUnitsPerDay

/**
 * Whether an approval rule is well formed under the mandate's most for an order. An `above` rule's
 * amount is from one micro to just under that most, since zero is `always` by another name and an
 * amount no order can pass is `never`.
 */
function isApprovalRule(rule: unknown, maxOrderValue: bigint): rule is ApprovalRule {
  if (!isObject(rule)) return false
  if (rule.kind === 'above') {
    if (!holdsOnly(rule, ['kind', 'amount']) || !uint(rule.amount, 256, 1n)) return false
    return rule.amount < maxOrderValue
  }
  return (rule.kind === 'never' || rule.kind === 'always') && holdsOnly(rule, ['kind'])
}

/**
 * Checks a seller's mandate on its own, and gives `seller_mandate.invalid` for one that isn't well
 * formed. It never throws, whatever it's given, and a mandate that passes hashes without throwing
 * and in one way only. So it holds exactly the fields the signed form names, each of its declared
 * type and within what that form can carry, with text that is well-formed Unicode and addresses and
 * hashes in lower case. An item's name reads on one line with no hidden mark in it, and a business
 * in a list is named by its id.
 *
 * It names at least one line of limits. Lines come in order, by category, then the line for every
 * other item, then by item, so no item has two. A line's floor is within one order's most, it
 * allows at least one unit an order and no fewer a day, and a job's line allows one. A line for an
 * item allows at least what its category's line for every other item does, since an agent that
 * names its own items could step around a tighter one. An order's most is above zero and within
 * what may be outstanding, and the delivery horizon is above zero. Each charge floor is a share
 * from 0 to 100%. Each list of businesses and countries is in ascending order, and a mandate that
 * names the only buyers excludes none. No term is open to bargaining, since version 1 sells on
 * fixed terms. It ends after the start of 1970 and by the end of the year 9999.
 */
export function sellerMandateProblem(m: SellerMandate): ReasonCode | null {
  try {
    return identityIsSound(m) ? null : 'seller_mandate.invalid'
  } catch {
    // A value that throws when read is no mandate.
    return 'seller_mandate.invalid'
  }
}

function identityIsSound(v: unknown): boolean {
  if (!isObject(v) || !holdsOnly(v, MANDATE_KEYS)) return false
  if (typeof v.mandateId !== 'string' || !LOWER_BYTES32.test(v.mandateId)) return false
  if (!isSoundText(v.businessId, BUSINESS_ID_MAX)) return false
  if (typeof v.account !== 'string' || !LOWER_ADDRESS.test(v.account)) return false
  if (!uint(v.nonce, 256)) return false
  const { replaces } = v
  if (replaces !== null) {
    if (typeof replaces !== 'string' || !LOWER_BYTES32.test(replaces)) return false
    if (replaces === zeroHash) return false
  }
  return termsAreSound(v)
}

/**
 * Checks what a selling agent asks for, before any mandate carries it, by the rules
 * `sellerMandateProblem` holds a mandate's terms to. It gives `seller_mandate.invalid` for terms
 * that aren't well formed, or that hold anything but a mandate's terms.
 */
export function sellerMandateTermsProblem(terms: SellerMandateTerms): ReasonCode | null {
  const v: unknown = terms
  try {
    if (isObject(v) && holdsOnly(v, TERMS_KEYS) && termsAreSound(v)) return null
  } catch {
    // A value that throws when read is no terms.
  }
  return 'seller_mandate.invalid'
}

/** Whether the terms among a value's fields are well formed, whatever other fields it holds. */
function termsAreSound(v: Record<string, unknown>): boolean {
  if (typeof v.signingKey !== 'string' || !LOWER_ADDRESS.test(v.signingKey)) return false
  if (!(CURRENCIES as readonly unknown[]).includes(v.currency)) return false

  const { maxOrderValue, limits } = v
  if (!uint(maxOrderValue, 256, 1n) || !uint(v.maxOutstanding, 256, maxOrderValue)) return false
  if (!Array.isArray(limits) || limits.length < 1 || limits.length > SELLER_LIMITS_MAX) return false
  const lines = Array.from(limits)
  if (!lines.every((l): l is SellingLimit => isLimit(l, maxOrderValue))) return false
  if (!lines.every((l, i) => i === 0 || comesBefore(lines[i - 1] as SellingLimit, l))) return false
  for (const named of lines) {
    const any = lines.find((l) => l.category === named.category && l.item === null)
    if (named.item !== null && any && !loosens(named, any)) return false
  }

  if (!uint(v.maxDeliveryHorizon, 64, 1n) || !uint(v.maxFreeCancelWindow, 64)) return false
  if (!isShare(v.minLateCancellationBps) || !isShare(v.minNoShowBps)) return false
  const businessId = (id: unknown) => typeof id === 'string' && BUSINESS_ID.test(id)
  const { buyers, excludedBuyers } = v
  if (!ascendingList(buyers, SELLER_LIST_MAX, businessId)) return false
  if (!ascendingList(excludedBuyers, SELLER_LIST_MAX, businessId)) return false
  if ((buyers as unknown[]).length > 0 && (excludedBuyers as unknown[]).length > 0) return false
  const country = (c: unknown) => typeof c === 'string' && COUNTRY_CODE.test(c)
  if (!ascendingList(v.excludedCountries, SELLER_LIST_MAX, country)) return false
  if (typeof v.requiresBusinessCheck !== 'boolean') return false
  const { negotiable, expiry } = v
  if (!Array.isArray(negotiable) || negotiable.length > 0) return false
  if (!isApprovalRule(v.approvalRule, maxOrderValue)) return false
  return uint(expiry, 64, 1n) && expiry <= SELLER_EXPIRY_MAX
}

/** The terms a seller's mandate carries, without the fields that say which mandate it is and whose. */
export function sellerMandateTermsOf(m: SellerMandate): SellerMandateTerms {
  const terms: Record<string, unknown> = { ...m }
  for (const key of IDENTITY_KEYS) delete terms[key]
  return terms as unknown as SellerMandateTerms
}

/**
 * Whether a well-formed mandate carries exactly the well-formed terms given, with nothing moved,
 * added or left out, for the same signing key. It is false for a mandate or terms that aren't well
 * formed, so two malformed values never pass as equal.
 */
export function carriesSellerMandateTerms(m: SellerMandate, terms: SellerMandateTerms): boolean {
  if (sellerMandateProblem(m) !== null || sellerMandateTermsProblem(terms) !== null) return false
  try {
    return canonicalJson(sellerMandateTermsOf(m)) === canonicalJson(terms)
  } catch {
    return false
  }
}

/**
 * The line of a mandate's limits that governs an item: the item's own line, or failing that the
 * category's line for every other item, or null when the mandate lets the agent sell neither. An
 * item is matched by its exact name, so one spelled any other way falls to the category's line.
 */
export function sellingLimitFor(
  mandate: Pick<SellerMandate, 'limits'>,
  category: string,
  item: string,
): SellingLimit | null {
  const inCategory = mandate.limits.filter((l) => l.category === category)
  return inCategory.find((l) => l.item === item) ?? inCategory.find((l) => l.item === null) ?? null
}

/**
 * A seller's mandate as JSON, with amounts and times as decimal strings and nothing else in it.
 * It reads each field's type, and `sellerMandateProblem` holds every rule about its value.
 */
export const sellerMandateJson = z.strictObject({
  mandateId: bytes32,
  businessId: z.string(),
  account: address,
  signingKey: address,
  currency: z.enum(CURRENCIES),
  limits: z
    .array(
      z.strictObject({
        category: z.enum(SELLER_CATEGORIES),
        item: z.string().nullable(),
        minUnitPrice: u256,
        maxUnitsPerOrder: z.number(),
        maxUnitsPerDay: z.number(),
      }),
    )
    .max(SELLER_LIMITS_MAX)
    .readonly(),
  maxOrderValue: u256,
  maxOutstanding: u256,
  maxDeliveryHorizon: u64,
  minLateCancellationBps: z.number(),
  minNoShowBps: z.number(),
  maxFreeCancelWindow: u64,
  buyers: z.array(z.string()).max(SELLER_LIST_MAX).readonly(),
  excludedBuyers: z.array(z.string()).max(SELLER_LIST_MAX).readonly(),
  excludedCountries: z.array(z.string()).max(SELLER_LIST_MAX).readonly(),
  requiresBusinessCheck: z.boolean(),
  negotiable: z.array(z.enum(OPEN_TERMS)).readonly(),
  approvalRule: approvalRuleJson,
  expiry: u64,
  nonce: u256,
  replaces: bytes32.nullable(),
})

/**
 * A seller's mandate's terms as JSON, which is the mandate's own without its identity fields. The
 * fields left out come from the one list of them, so the type and the JSON can't drift apart.
 */
export const sellerMandateTermsJson = sellerMandateJson.omit(
  Object.fromEntries(IDENTITY_KEYS.map((k) => [k, true])) as {
    [K in (typeof IDENTITY_KEYS)[number]]: true
  },
)

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
