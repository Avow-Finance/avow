import { formatUsd, type SaleContent } from '@avow-finance/spec'

/** One fact of a sale a person is asked to approve, in words a card or page can show. */
export interface SaleWords {
  label: string
  value: string
}

/**
 * The words for each part of a sale, by the part's own name. Every part has an entry, so a part
 * added to a sale's content fails to compile here until it has words. One entry may state parts
 * that read as one, and the others it covers give none. An agent names the item, so its name shows
 * in quotes after words the card wrote.
 */
const SALE_WORDS: { [K in keyof SaleContent]: (s: SaleContent) => SaleWords | null } = {
  buyer: (s) => ({ label: 'Buyer', value: s.buyer }),
  category: () => null,
  item: (s) => ({
    label: 'Sells',
    value:
      s.category === 'compute-job'
        ? `The job "${s.item}"`
        : `${s.units} of the service "${s.item}"`,
  }),
  offer: (s) => (s.offer === null ? null : { label: 'Offer version', value: s.offer }),
  units: () => null,
  price: (s) => ({ label: 'Total', value: formatUsd(s.price) }),
  currency: (s) => ({ label: 'Paid in', value: s.currency }),
}

/** Every part of a sale a person is asked to approve, in words, with none left out. */
export function saleWords(s: SaleContent): SaleWords[] {
  return Object.values(SALE_WORDS).flatMap((words) => words(s) ?? [])
}
