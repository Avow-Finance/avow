import { formatUsd, type SellerMandateTerms, type SellingLimit } from '@avow-finance/spec'

/** One limit of a seller's mandate, in words a card or page can show. */
export interface SellerLimitWords {
  label: string
  value: string
}

const count = (n: bigint, unit: string) => `${n} ${unit}${n === 1n ? '' : 's'}`

/** A length of time in the largest unit that states it exactly. */
function duration(seconds: bigint): string {
  if (seconds === 0n) return 'None'
  if (seconds % 86_400n === 0n) return count(seconds / 86_400n, 'day')
  if (seconds % 3_600n === 0n) return count(seconds / 3_600n, 'hour')
  if (seconds % 60n === 0n) return count(seconds / 60n, 'minute')
  return count(seconds, 'second')
}

const percent = (bps: number) => `${bps / 100}%`

/**
 * One line of limits. An agent writes an item's name, so the name shows in quotes after a label the
 * card wrote, and can't pass for a row of the card's own.
 */
function lineWords(l: SellingLimit): SellerLimitWords {
  const job = l.category === 'compute-job'
  const kind = job ? 'job' : 'service'
  const label = l.item === null ? `Any other ${kind}` : `The ${kind} "${l.item}"`
  const price = l.minUnitPrice === 0n ? 'Any price' : `From ${formatUsd(l.minUnitPrice)}`
  const value = job
    ? `${price} a job, up to ${l.maxUnitsPerDay} a day`
    : `${price} a unit, up to ${l.maxUnitsPerOrder} an order and ${l.maxUnitsPerDay} a day`
  return { label, value }
}

/**
 * Who the agent may sell to. On testnet a country is the one a business declared and every
 * business check is simulated, and the words say so wherever either shows.
 */
function buyersWords(t: SellerMandateTerms): string {
  const who =
    t.buyers.length > 0
      ? `Only ${t.buyers.join(', ')}`
      : t.excludedBuyers.length > 0
        ? `Any business except ${t.excludedBuyers.join(', ')}`
        : 'Any business'
  const where =
    t.excludedCountries.length > 0
      ? `, with a self-declared country other than ${t.excludedCountries.join(', ')}`
      : ''
  const checked = t.requiresBusinessCheck ? ", that passed Avow's simulated business check" : ''
  return `${who}${where}${checked}`
}

function personWords(rule: SellerMandateTerms['approvalRule']): string {
  if (rule.kind === 'never') return 'No sale'
  return rule.kind === 'always' ? 'Every sale' : `Sales over ${formatUsd(rule.amount)}`
}

/** When the authority ends, or the bare second for a time no calendar reads. */
function endWords(expiry: bigint): string {
  const at = new Date(Number(expiry) * 1000)
  return Number.isNaN(at.getTime()) ? `Second ${expiry}` : at.toISOString()
}

type Rows = SellerLimitWords | SellerLimitWords[] | null

/**
 * The words for each term, by the term's own name. Every term has an entry, so a term added to a
 * seller's mandate fails to compile here until it has words. One entry may state several terms that
 * read as one, and the others it covers give none. They are written in the order a person reads
 * them: which key, what it sells, how much, on what charges, to whom, and until when.
 */
const TERM_WORDS: { [K in keyof SellerMandateTerms]: (t: SellerMandateTerms) => Rows } = {
  signingKey: (t) => ({ label: 'Signing key', value: t.signingKey }),
  limits: (t) => t.limits.map(lineWords),
  currency: (t) => ({ label: 'Sells in', value: t.currency }),
  maxOrderValue: (t) => ({ label: 'Most for one order', value: formatUsd(t.maxOrderValue) }),
  maxOutstanding: (t) => ({
    label: 'Most promised and not yet delivered',
    value: formatUsd(t.maxOutstanding),
  }),
  maxDeliveryHorizon: (t) => ({
    label: 'Longest until delivery',
    value: duration(t.maxDeliveryHorizon),
  }),
  minLateCancellationBps: (t) => ({
    label: 'Lowest late-cancellation charge',
    value: percent(t.minLateCancellationBps),
  }),
  minNoShowBps: (t) => ({ label: 'Lowest no-show charge', value: percent(t.minNoShowBps) }),
  maxFreeCancelWindow: (t) => ({
    label: 'Longest free cancellation for a service',
    value: duration(t.maxFreeCancelWindow),
  }),
  buyers: (t) => ({ label: 'Buyers', value: buyersWords(t) }),
  excludedBuyers: () => null,
  excludedCountries: () => null,
  requiresBusinessCheck: () => null,
  negotiable: (t) => ({
    label: 'Terms it may bargain over',
    value: t.negotiable.length > 0 ? t.negotiable.join(', ') : 'None',
  }),
  approvalRule: (t) => ({ label: 'A person decides', value: personWords(t.approvalRule) }),
  expiry: (t) => ({ label: 'Ends', value: endWords(t.expiry) }),
}

/**
 * Every term a seller's mandate would set, in words. No term is left out, so a card built from
 * these shows what a signature would grant. Nothing enforces a seller's mandate yet, and a card
 * that shows these before Avow does has to say so.
 */
export function sellerMandateWords(t: SellerMandateTerms): SellerLimitWords[] {
  return Object.values(TERM_WORDS).flatMap((words) => words(t) ?? [])
}
