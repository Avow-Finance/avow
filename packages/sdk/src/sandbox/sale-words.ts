import { formatUsd, SALE_APPROVAL_LASTS, type SaleContent, salePrice } from '@avow-finance/spec'
import { duration, percent, span } from './words.js'

/** One fact of a sale a person is asked to approve, in words a card or page can show. */
export interface SaleWords {
  label: string
  value: string
}

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
  payment: (o) => {
    const due = o.rules.payment.dueAfterDelivery
    const when = due === 0n ? 'at delivery' : `within ${span(due)} of delivery`
    return { label: 'Paid', value: `By ${o.rules.payment.route}, ${when}` }
  },
}

/**
 * The words for each part of a sale, by the part's own name. The seller's agent wrote the item's
 * name, its summary and what counts as delivery, so each shows in quotes after words the card
 * wrote. The most one booking takes and the offer's capacity for a day have no row, since neither
 * changes what this sale is, and the version's id still binds them.
 */
const SALE_WORDS: { [K in keyof SaleContent]: (s: SaleContent) => SaleWords[] } = {
  signingKey: (s) => [{ label: 'Sold by the key', value: s.signingKey }],
  buyer: (s) => [{ label: 'Buyer', value: s.buyer }],
  offer: (s) => [
    { label: 'Sold by', value: s.offer.supplier },
    { label: 'Sells', value: `${s.units} of the service "${s.offer.item.name}"` },
    { label: 'Described as', value: `"${s.offer.item.summary}"` },
    { label: 'Price for each', value: `${formatUsd(s.offer.unitPrice)} ${s.offer.currency}` },
    { label: 'Total', value: `${formatUsd(salePrice(s))} ${s.offer.currency}` },
    ...Object.values(RULE_WORDS).flatMap((words) => words(s.offer) ?? []),
  ],
  units: () => [],
}

/**
 * What approving one sale does, which is the same for every sale. It leads the card, so nobody
 * takes one sale for a change to the agent's limits.
 */
export const SALE_APPROVAL_WORDS = `This one sale, once, within ${span(SALE_APPROVAL_LASTS)}. No limit changes.`

/** Every part of a sale a person is asked to approve, in words. */
export function saleWords(s: SaleContent): SaleWords[] {
  return [
    { label: 'Approves', value: SALE_APPROVAL_WORDS },
    ...Object.values(SALE_WORDS).flatMap((words) => words(s)),
  ]
}
