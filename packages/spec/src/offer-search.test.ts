import { describe, expect, it } from 'vitest'
import { dollars } from './demo.js'
import {
  OFFER_RANKING,
  OFFER_RESULTS_MAX,
  type OfferMatch,
  type OfferSearch,
  type OfferSearchResult,
  offerFits,
  offerSearchResultProblem,
  parseOfferSearch,
  parseOfferSearchResult,
  rankOffers,
} from './offer-search.js'
import { SANDBOX_PATHS } from './sandbox.js'
import { offerVersionId, type ServiceOfferVersion, serviceOfferQuote } from './service.js'
import { NOW } from './test-helpers.js'
import { toWire } from './wire.js'

const HOUR = 3600n

/** Transcription by the hour of audio, at $50 a unit, delivered within a day. */
const transcript: ServiceOfferVersion = {
  supplier: 'acme-transcripts',
  item: { name: 'Transcript', summary: 'One hour of audio transcribed into English text' },
  currency: 'USD',
  unitPrice: dollars(50),
  rules: {
    evidence: 'The transcript is delivered to the buyer as a text file',
    leadTime: 24n * HOUR,
    maxPerBooking: 10,
    dailyCapacity: 20,
    freeCancelWindow: 2n * HOUR,
    lateCancellationBps: 2_000,
    noShowBps: 5_000,
    payment: { route: 'transfer', dueAfterDelivery: 7n * 24n * HOUR },
  },
}
const priced = (
  unitPrice: bigint,
  leadTime = transcript.rules.leadTime,
  supplier = 'acme-transcripts',
) => ({
  ...transcript,
  supplier,
  unitPrice,
  rules: { ...transcript.rules, leadTime },
})

const search: OfferSearch = {
  query: 'english transcript',
  budget: dollars(200),
  currency: 'USD',
  quantity: 2,
  deliverBy: NOW + 48n * HOUR,
  needingApproval: true,
}
const match = (version: ServiceOfferVersion, needs: OfferMatch['needs'] = []): OfferMatch => ({
  version,
  supplier: { name: 'Acme Transcripts', sandbox: true },
  needs,
})
const result = (eligible: OfferMatch[], needingApproval: OfferMatch[] = []): OfferSearchResult => ({
  ranking: OFFER_RANKING,
  checkedAt: NOW,
  eligible,
  needingApproval,
})

describe('the search path', () => {
  it('is a sandbox path a signed request can name', () => {
    expect(SANDBOX_PATHS.offerSearch).toBe('/v1/sandbox/offers/search')
  })
})

describe('parseOfferSearch', () => {
  it('fills in what a search leaves out: every offer, one unit, any time, eligible only', () => {
    expect(parseOfferSearch({ budget: '100000000', currency: 'USD' })).toEqual({
      ok: true,
      value: {
        query: null,
        budget: 100_000_000n,
        currency: 'USD',
        quantity: 1,
        deliverBy: null,
        needingApproval: false,
      },
    })
  })

  it.each([
    ['left out', {}],
    ['empty', { query: '' }],
    ['only whitespace', { query: ' \t\n ' }],
  ])('reads words %s as no words', (_, words) => {
    const parsed = parseOfferSearch({ budget: '1', currency: 'USD', ...words })
    expect(parsed.ok && parsed.value.query).toBeNull()
  })

  it('reads a full search', () => {
    const parsed = parseOfferSearch(toWire(search))
    expect(parsed).toEqual({ ok: true, value: search })
  })

  it.each([
    ['a budget of nothing', { budget: '0', currency: 'USD' }],
    ['a currency it lists none in', { budget: '1', currency: 'XYZ' }],
    ['no units', { budget: '1', currency: 'USD', quantity: 0 }],
    ['part of a unit', { budget: '1', currency: 'USD', quantity: 1.5 }],
    ['words past the limit', { budget: '1', currency: 'USD', query: 'a'.repeat(201) }],
    ["a field it doesn't know", { budget: '1', currency: 'USD', supplier: 'acme' }],
  ])('refuses %s', (_, json) => {
    expect(parseOfferSearch(json)).toEqual({ ok: false, reason: 'message.invalid' })
  })
})

describe('offerFits', () => {
  it('takes an offer in the currency, with the words, within budget and in time', () => {
    expect(offerFits(search, transcript, NOW)).toBe(true)
  })

  it('matches words in any case and order, against the name and the summary', () => {
    expect(offerFits({ ...search, query: 'AUDIO hour' }, transcript, NOW)).toBe(true)
    expect(offerFits({ ...search, query: 'french transcript' }, transcript, NOW)).toBe(false)
    expect(offerFits({ ...search, query: null }, transcript, NOW)).toBe(true)
  })

  it('matches a word in the name and another in the summary', () => {
    const gpu = {
      ...transcript,
      item: { name: 'H100 GPU hour', summary: 'One hour of an H100 for rendering or training' },
    }
    const budget = { ...search, budget: dollars(1000) }
    expect(offerFits({ ...budget, query: 'GPU rendering' }, gpu, NOW)).toBe(true)
    expect(offerFits({ ...budget, query: 'gpu' }, gpu, NOW)).toBe(true)
    expect(offerFits({ ...budget, query: 'GPU inference' }, gpu, NOW)).toBe(false)
  })

  it('lists every offer for blank words, as for none', () => {
    expect(offerFits({ ...search, query: '   ' }, transcript, NOW)).toBe(true)
  })

  it('leaves out an offer in another currency', () => {
    expect(offerFits({ ...search, currency: 'EUR' as never }, transcript, NOW)).toBe(false)
  })

  it("leaves out an offer whose total for the quantity is over budget, but not its reserve's", () => {
    expect(offerFits({ ...search, budget: dollars(100) }, transcript, NOW)).toBe(true)
    expect(offerFits({ ...search, budget: dollars(100) - 1n }, transcript, NOW)).toBe(false)
  })

  it("leaves out an offer that doesn't take the quantity", () => {
    expect(offerFits({ ...search, quantity: 11, budget: dollars(1000) }, transcript, NOW)).toBe(
      false,
    )
  })

  it("leaves out an offer that can't deliver by the deadline when booked now", () => {
    expect(offerFits({ ...search, deliverBy: NOW + 24n * HOUR }, transcript, NOW)).toBe(true)
    expect(offerFits({ ...search, deliverBy: NOW + 24n * HOUR - 1n }, transcript, NOW)).toBe(false)
    expect(offerFits({ ...search, deliverBy: null }, transcript, NOW + 1000n * HOUR)).toBe(true)
  })
})

describe('rankOffers', () => {
  it('puts the lowest total first, then the soonest delivery, then the lowest version id', () => {
    const dear = match(priced(dollars(60)))
    const slow = match(priced(dollars(50), 30n * HOUR))
    const fast = match(priced(dollars(50), 12n * HOUR))
    const twinA = match(priced(dollars(40), 24n * HOUR, 'twin-a'))
    const twinB = match(priced(dollars(40), 24n * HOUR, 'twin-b'))
    const [lowTwin, highTwin] =
      offerVersionId(twinA.version) < offerVersionId(twinB.version)
        ? [twinA, twinB]
        : [twinB, twinA]
    expect(rankOffers(2, [dear, slow, highTwin, fast, lowTwin])).toEqual([
      lowTwin,
      highTwin,
      fast,
      slow,
      dear,
    ])
  })
})

describe('offerSearchResultProblem', () => {
  const cheap = match(priced(dollars(40)))
  const usual = match(transcript)
  const newSupplier = match(priced(dollars(45), 24n * HOUR, 'beta-transcripts'), [
    'mandate.supplier_not_allowed',
  ])

  it('passes an answer that fits the search and keeps to the ranking', () => {
    expect(offerSearchResultProblem(search, result([cheap, usual], [newSupplier]))).toBeNull()
  })

  it.each([
    ['an offer out of order', result([usual, cheap])],
    ['an offer over budget', result([match(priced(dollars(150)))])],
    [
      'an offer listed twice',
      result([cheap], [match(cheap.version, ['mandate.over_commitment_cap'])]),
    ],
    [
      'an eligible offer that needs approval',
      result([match(transcript, ['mandate.supplier_not_allowed'])]),
    ],
    ['an offer needing approval with no reason', result([], [match(transcript)])],
  ])('finds %s', (_, answer) => {
    expect(offerSearchResultProblem(search, answer)).not.toBeNull()
  })

  it("finds offers needing approval that the search didn't ask for", () => {
    const eligibleOnly = { ...search, needingApproval: false }
    expect(offerSearchResultProblem(eligibleOnly, result([cheap], [newSupplier]))).toMatch(
      /didn't ask/,
    )
  })

  it('judges the deadline at the time Avow checked, not later', () => {
    const tight = { ...search, deliverBy: NOW + 24n * HOUR }
    expect(offerSearchResultProblem(tight, result([usual]))).toBeNull()
    expect(
      offerSearchResultProblem(tight, { ...result([usual]), checkedAt: NOW + 1n }),
    ).not.toBeNull()
  })

  it('finds a group longer than the limit', () => {
    const many = Array.from({ length: OFFER_RESULTS_MAX + 1 }, (_, i) =>
      match(priced(dollars(10) + BigInt(i), 24n * HOUR)),
    )
    expect(offerSearchResultProblem({ ...search, query: null }, result(many))).toMatch(/more than/)
  })
})

describe('parseOfferSearchResult', () => {
  const answer = result(
    [match(priced(dollars(40)))],
    [match(transcript, ['mandate.over_commitment_cap'])],
  )

  it('reads an answer from JSON', () => {
    expect(parseOfferSearchResult(toWire(answer))).toEqual({ ok: true, value: answer })
  })

  it.each([
    [
      'a supplier not labelled sandbox',
      {
        ...answer,
        eligible: [{ ...answer.eligible[0], supplier: { name: 'Acme', sandbox: false } }],
      },
    ],
    [
      'a reason that needs no administrator',
      { ...answer, needingApproval: [match(transcript, ['mandate.revoked' as never])] },
    ],
    [
      'a reason listed twice',
      {
        ...answer,
        needingApproval: [
          match(transcript, ['mandate.over_commitment_cap', 'mandate.over_commitment_cap']),
        ],
      },
    ],
    [
      'a version its rules refuse',
      { ...answer, eligible: [match({ ...transcript, unitPrice: 0n })] },
    ],
    ["a ranking it doesn't know", { ...answer, ranking: 'cheapest' }],
  ])('refuses %s', (_, json) => {
    expect(parseOfferSearchResult(toWire(json))).toEqual({ ok: false, reason: 'message.invalid' })
  })
})

describe('serviceOfferQuote', () => {
  it('prices two transcripts at $100, with a $50 reserve from the no-show charge', () => {
    expect(serviceOfferQuote(transcript, 2)).toEqual({
      total: dollars(100),
      lateCancellation: dollars(20),
      noShow: dollars(50),
      reserve: dollars(50),
    })
  })

  it("refuses a quantity the offer doesn't take", () => {
    expect(() => serviceOfferQuote(transcript, 11)).toThrow(/1 to 10 units/)
  })
})
