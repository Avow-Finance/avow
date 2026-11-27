import { z } from 'zod'
import { parseServiceOfferVersion, type ServiceOfferVersion } from './service.js'
import { isPlainText } from './text.js'
import type { Parsed } from './wire.js'

/**
 * Avow's test sellers, labelled test businesses that sell simple services through the sandbox at
 * any hour, so a newly connected agent has something real to order. The sandbox's screen lists
 * them in the deployment file it publishes, and an agent reads the list to order from one without
 * knowing its business ID. Every one is a test business, nothing it sells is delivered or billed,
 * and nothing about it is verified.
 */

/** How every test business is labelled wherever one shows. */
export const TEST_BUSINESS_LABEL = 'test business'

/** What every test business's name ends with, so it reads as a test wherever it shows. */
export const TEST_BUSINESS_SUFFIX = ` (${TEST_BUSINESS_LABEL})`

/** What every item a test business sells starts with. */
export const TEST_ITEM_PREFIX = 'Test '

/** The most test sellers a deployment lists, and the most offers one seller lists. */
export const TEST_SELLERS_MAX = 10

/** A test business is never called verified, whatever else it says. */
const callsVerified = (text: string) => /verif/i.test(text)

/** One test seller, with the sandbox business it sells for, its name and its offers, whole. */
export interface TestSeller {
  businessId: string
  /** Ends "(test business)". */
  name: string
  /** The versions it published, each one a buyer's agent orders from as it is. */
  offers: ServiceOfferVersion[]
}

const listJson = z
  .array(
    z.strictObject({
      businessId: z.string().regex(/^sandbox-[0-9a-f]{40}$/),
      name: z.string(),
      offers: z.array(z.unknown()).min(1).max(TEST_SELLERS_MAX),
    }),
  )
  .max(TEST_SELLERS_MAX)

/**
 * Whether one seller keeps the rules. Its name is plain text that ends "(test business)", and each
 * offer is a version the service template takes, published under the seller's own business, for
 * an item whose name starts "Test". Nothing in it says verified.
 */
function keepsRules(s: TestSeller): boolean {
  const named =
    isPlainText(s.name, 80) &&
    s.name.endsWith(TEST_BUSINESS_SUFFIX) &&
    s.name.length > TEST_BUSINESS_SUFFIX.length
  const offersFit = s.offers.every(
    (o) => o.supplier === s.businessId && o.item.name.startsWith(TEST_ITEM_PREFIX),
  )
  const words = [s.name, ...s.offers.flatMap((o) => [o.item.name, o.item.summary])]
  return named && offersFit && !words.some(callsVerified)
}

/**
 * Reads the deployment file's list of test sellers. It refuses the whole list when any seller in
 * it breaks a rule, or when it names one business twice, so an agent never shows a seller that
 * isn't labelled as a test business.
 */
export function parseTestSellers(json: unknown): Parsed<TestSeller[]> {
  const parsed = listJson.safeParse(json)
  if (!parsed.success) return { ok: false, reason: 'message.invalid' }
  const sellers: TestSeller[] = []
  for (const entry of parsed.data) {
    const offers: ServiceOfferVersion[] = []
    for (const o of entry.offers) {
      const version = parseServiceOfferVersion(o)
      if (!version.ok) return { ok: false, reason: 'message.invalid' }
      offers.push(version.value)
    }
    const seller = { businessId: entry.businessId, name: entry.name, offers }
    if (!keepsRules(seller)) return { ok: false, reason: 'message.invalid' }
    sellers.push(seller)
  }
  if (new Set(sellers.map((s) => s.businessId)).size !== sellers.length) {
    return { ok: false, reason: 'message.invalid' }
  }
  return { ok: true, value: sellers }
}
