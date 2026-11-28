import { dollars, type OfferSearch, offerMatch, offerSearchResult } from '@avow-finance/spec'
import { describe, expect, it } from 'vitest'
import { OFFER_SEARCH_UNSERVED } from '../sandbox/offer-search.js'
import { listedTranscript } from '../test/offer-search.js'
import { readSearchArgs, readSearchInput, searchSentences } from './offer-search.js'

describe('a search as a person or a model gives it', () => {
  it('reads dollars, a date and the rest into the units the spec takes', () => {
    expect(
      readSearchInput({
        query: 'transcript',
        budget: 120.5,
        quantity: 2,
        deliver_by: '2027-01-02T00:00:00Z',
        needing_approval: true,
      }),
    ).toEqual({
      query: 'transcript',
      budget: 120_500_000n,
      quantity: 2,
      deliverBy: 1_798_848_000n,
      needingApproval: true,
    })
    expect(readSearchInput({ budget: 10 })).toEqual({
      query: null,
      budget: dollars(10),
      quantity: 1,
      deliverBy: null,
      needingApproval: false,
    })
  })

  it('refuses a budget, quantity, date or words it would have to guess at', () => {
    for (const budget of [undefined, 0, -1, 1.0000001, '10', 2_000_000_000]) {
      expect(readSearchInput({ budget }), String(budget)).toHaveProperty('error')
    }
    for (const quantity of [0, 1.5, '2', 100_000_000]) {
      expect(readSearchInput({ budget: 10, quantity }), String(quantity)).toHaveProperty('error')
    }
    expect(readSearchInput({ budget: 10, deliver_by: 'soon' })).toHaveProperty('error')
    expect(readSearchInput({ budget: 10, query: 3 })).toHaveProperty('error')
    expect(readSearchInput({ budget: 10, query: 'x'.repeat(201) })).toHaveProperty('error')
    expect(readSearchInput({ budget: 10, needing_approval: 'yes' })).toHaveProperty('error')
  })

  it('reads the same from the flags of offer search', () => {
    expect(
      readSearchArgs([
        '--budget',
        '100',
        '--query',
        'audio',
        '--needing-approval',
        '--quantity',
        '3',
      ]),
    ).toEqual({
      query: 'audio',
      budget: dollars(100),
      quantity: 3,
      deliverBy: null,
      needingApproval: true,
    })
    expect(readSearchArgs([])).toEqual({ error: 'offer search needs --budget, in dollars' })
    expect(readSearchArgs(['--budget'])).toEqual({ error: '--budget needs a value' })
    expect(readSearchArgs(['--budget', 'ten'])).toEqual({ error: '--budget takes a number' })
    expect(readSearchArgs(['--price', '1'])).toEqual({ error: "offer search doesn't take --price" })
  })
})

describe('what a search found, in words', () => {
  const search: OfferSearch = {
    query: null,
    budget: dollars(200),
    currency: 'USD',
    quantity: 2,
    deliverBy: null,
    needingApproval: true,
  }
  const checkedAt = 1_800_000_000n
  const match = offerMatch(search, listedTranscript(), 'Test Transcripts', checkedAt)

  it('names each offer, labels its supplier a sandbox business and says the result grants nothing', () => {
    const words = searchSentences({
      ok: true,
      result: offerSearchResult({
        search,
        checkedAt,
        mandate: `0x${'cd'.repeat(32)}`,
        eligible: [match],
        needingApproval: [
          {
            ...offerMatch(search, listedTranscript('sandbox-other'), 'Other', checkedAt),
            need: 'mandate.supplier_not_allowed',
          },
        ],
      }),
    }).join(' ')
    expect(words).toContain(
      `${match.id}, item "Transcript" from sandbox business "Test Transcripts" (sandbox-seller), which no check has verified.`,
    )
    expect(words).toContain('2 units cost $100 and reserve $50')
    expect(words).toContain('Your mandate refuses it now with mandate.supplier_not_allowed.')
    expect(words).toMatch(
      /A result grants nothing\. Booking an offer checks your mandate and funds again/,
    )
  })

  it('says when nothing was found, and passes on the notice of a sandbox that lists nothing', () => {
    const none = searchSentences({
      ok: true,
      result: offerSearchResult({
        search: { ...search, needingApproval: false },
        checkedAt,
        mandate: `0x${'cd'.repeat(32)}`,
        eligible: [],
        needingApproval: [],
      }),
    })
    expect(none[0]).toMatch(/^Avow found no listed offer your mandate allows/)
    expect(
      searchSentences({
        ok: false,
        reason: 'offer.listing_unavailable',
        notice: OFFER_SEARCH_UNSERVED,
      }),
    ).toEqual([OFFER_SEARCH_UNSERVED])
  })
})
