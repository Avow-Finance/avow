import { formatUsd, type SaleContent, salePrice } from '@avow-finance/spec'

/** One fact of a sale a person is asked to approve, in words a card or page can show. */
export interface SaleWords {
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

type Offer = SaleContent['offer']

/**
 * The words for each rule of the offer version sold from, by the rule's own name. Every rule has an
 * entry, so a rule added to an offer fails to compile here until it has words.
 */
const RULE_WORDS: { [K in keyof Offer['rules']]: (o: Offer) => SaleWords | null } = {
  evidence: (o) => ({ label: 'Counts as delivered when', value: `"${o.rules.evidence}"` }),
  leadTime: (o) => ({ label: 'Delivered within', value: duration(o.rules.leadTime) }),
  maxPerBooking: () => null,
  dailyCapacity: () => null,
  freeCancelWindow: (o) => ({
    label: 'Buyer cancels at no charge for',
    value: duration(o.rules.freeCancelWindow),
  }),
  lateCancellationBps: (o) => ({
    label: 'Late-cancellation charge',
    value: percent(o.rules.lateCancellationBps),
  }),
  noShowBps: (o) => ({ label: 'No-show charge', value: percent(o.rules.noShowBps) }),
  payment: (o) => ({
    label: 'Paid',
    value: `By ${o.rules.payment.route}, within ${duration(o.rules.payment.dueAfterDelivery)} of delivery`,
  }),
}

/**
 * The words for each part of a sale, by the part's own name, with none left out. The seller's
 * agent wrote the item's name, its summary and what counts as delivery, so each shows in quotes
 * after words the card wrote. The first row says what a signature does, so nobody takes one sale
 * for a change to the agent's limits.
 */
const SALE_WORDS: { [K in keyof SaleContent]: (s: SaleContent) => SaleWords[] } = {
  signingKey: (s) => [{ label: 'Sold by the key', value: s.signingKey }],
  buyer: (s) => [{ label: 'Buyer', value: s.buyer }],
  offer: (s) => [
    { label: 'Sells', value: `${s.units} of the service "${s.offer.item.name}"` },
    { label: 'Described as', value: `"${s.offer.item.summary}"` },
    { label: 'Price for each', value: `${formatUsd(s.offer.unitPrice)} ${s.offer.currency}` },
    { label: 'Total', value: `${formatUsd(salePrice(s))} ${s.offer.currency}` },
    ...Object.values(RULE_WORDS).flatMap((words) => words(s.offer) ?? []),
  ],
  units: () => [],
}

/** What approving one sale does, which is the same for every sale. */
export const SALE_APPROVAL_WORDS = 'This one sale, once, within a day. No limit changes.'

/** Every part of a sale a person is asked to approve, in words. */
export function saleWords(s: SaleContent): SaleWords[] {
  return [
    { label: 'Approves', value: SALE_APPROVAL_WORDS },
    ...Object.values(SALE_WORDS).flatMap((words) => words(s)),
  ]
}
