import type { SellerMandateTerms, SellingLimit } from '@avow-finance/spec'

/** One limit of a seller's mandate, in words a card or page can show. */
export interface SellerLimitWords {
  label: string
  value: string
}

const dollars = (micros: bigint) =>
  `$${(Number(micros) / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 6 })}`

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

function lineWords(l: SellingLimit): SellerLimitWords {
  const job = l.category === 'compute-job'
  const label = l.item ?? (job ? 'Any other job' : 'Any other service')
  const price = l.minUnitPrice === 0n ? 'Any price' : `From ${dollars(l.minUnitPrice)}`
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
  return rule.kind === 'always' ? 'Every sale' : `Sales over ${dollars(rule.amount)}`
}

/**
 * Every limit a seller's mandate's terms set, in the order a person reads them: what the agent may
 * sell, how much it may promise, how far ahead, on what charges, to whom, when a person decides,
 * and when its authority ends. Nothing is left out, so a card built from these shows exactly what
 * a signature would grant.
 */
export function sellerMandateWords(t: SellerMandateTerms): SellerLimitWords[] {
  return [
    ...t.limits.map(lineWords),
    { label: 'Most for one order', value: dollars(t.maxOrderValue) },
    { label: 'Most promised and not yet delivered', value: dollars(t.maxOutstanding) },
    { label: 'Longest until delivery', value: duration(t.maxDeliveryHorizon) },
    { label: 'Lowest late-cancellation charge', value: percent(t.minLateCancellationBps) },
    { label: 'Lowest no-show charge', value: percent(t.minNoShowBps) },
    { label: 'Longest free cancellation for a service', value: duration(t.maxFreeCancelWindow) },
    { label: 'Buyers', value: buyersWords(t) },
    { label: 'A person decides', value: personWords(t.approvalRule) },
    { label: 'Ends', value: new Date(Number(t.expiry) * 1000).toISOString() },
  ]
}
