import { z } from 'zod'
import {
  parseServiceOfferVersion,
  SERVICE_NAME_MAX,
  SERVICE_TEXT_MAX,
  type ServiceOfferVersion,
} from './service.js'
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

/** The most test sellers a deployment lists. */
export const TEST_SELLERS_MAX = 10

/** The most offers one test seller lists. */
export const TEST_SELLER_OFFERS_MAX = 10

/** The longest name a test seller has, "(test business)" included. */
export const TEST_SELLER_NAME_MAX = 80

/**
 * Words a test seller's text may not hold, since each would make a test business read as checked
 * or vouched for. Avow writes the list itself, so this is a backstop, and it refuses these words
 * and nothing more.
 */
export const TEST_SELLER_REFUSED_WORDS = [
  'verif',
  'certif',
  'kyb',
  'kyc',
  'vett',
  'audit',
  'accredit',
  'approved',
  'checked',
  'trusted',
  'guarant',
  'licensed',
  'insured',
  'endorsed',
  'validated',
] as const

/**
 * The words of text as the word check reads them. Each is lower case, with five stand-ins read as
 * the letters they pass for, 0 as o, 1, l and | as i, and 3 as e, and with everything in it that
 * isn't a letter left out, so "Ve-rified" and "K.Y.B." read whole. Words are what spaces part, and
 * a run of single letters reads as one word, so "V e r i f i e d" reads whole too.
 */
function wordsOf(text: string): string[] {
  const words: string[] = []
  let run = ''
  for (const part of text.toLowerCase().split(' ')) {
    const word = part
      .replace(/0/g, 'o')
      .replace(/[1l|]/g, 'i')
      .replace(/3/g, 'e')
      .replace(/[^a-z]/g, '')
    if (word.length === 1) {
      run += word
      continue
    }
    if (run !== '') words.push(run)
    run = ''
    if (word !== '') words.push(word)
  }
  if (run !== '') words.push(run)
  return words
}

/**
 * Whether one word, as `wordsOf` reads it, holds a refused word. A refused word of three letters or
 * fewer, such as kyb, counts only as the whole word, so "Risky" and "Sky" pass. A longer one counts
 * anywhere in the word, so "Vetted" and "approved-by" are refused. A refused word is read with any
 * l in it as an i, since the check reads every l as one.
 */
const holdsRefused = (word: string): boolean =>
  TEST_SELLER_REFUSED_WORDS.some((refused) => {
    const read = refused.replace(/l/g, 'i')
    return refused.length <= 3 ? word === read : word.includes(read)
  })

/**
 * Whether text may show for a test seller. It's plain printable ASCII on one line, of up to `max`
 * characters with no space at either end, and none of its words, as `wordsOf` reads them, holds a
 * refused word. Avow writes the list itself, so the word check is a backstop, and it refuses those
 * words and nothing more.
 */
export function isTestSellerText(text: string, max: number): boolean {
  if (!/^[\x20-\x7e]+$/.test(text) || !isPlainText(text, max)) return false
  return !wordsOf(text).some(holdsRefused)
}

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
      offers: z.array(z.unknown()).min(1).max(TEST_SELLER_OFFERS_MAX),
    }),
  )
  .max(TEST_SELLERS_MAX)

/**
 * Whether one seller keeps the rules. Its name ends "(test business)", and each offer is a version
 * the service template takes, published under the seller's own business, for an item whose name
 * starts "Test". Its name and each offer's item name, summary and evidence are test seller text,
 * which is everything an agent shows of it.
 */
function keepsRules(s: TestSeller): boolean {
  const named =
    isTestSellerText(s.name, TEST_SELLER_NAME_MAX) &&
    s.name.endsWith(TEST_BUSINESS_SUFFIX) &&
    s.name.length > TEST_BUSINESS_SUFFIX.length
  return (
    named &&
    s.offers.every(
      (o) =>
        o.supplier === s.businessId &&
        o.item.name.startsWith(TEST_ITEM_PREFIX) &&
        isTestSellerText(o.item.name, SERVICE_NAME_MAX) &&
        isTestSellerText(o.item.summary, SERVICE_TEXT_MAX) &&
        isTestSellerText(o.rules.evidence, SERVICE_TEXT_MAX),
    )
  )
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
