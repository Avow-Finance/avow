import type { Hex } from 'viem'
import { describe, expect, it } from 'vitest'
import { API_PATH_PATTERN } from './api-request.js'
import { BUSINESS_NAME_MAX, shownBusinessName } from './business-name.js'
import { dollars } from './demo.js'
import { JOB, JOB_CATEGORY } from './job.js'
import { type JobOfferVersion, jobOfferTerms, jobOfferVersionId } from './job-offer.js'
import {
  APPROVAL_NEEDS,
  type ApprovalNeed,
  OFFER_RANKING,
  OFFER_RESULTS_MAX,
  type OfferMatch,
  type OfferNeedingApproval,
  type OfferSearch,
  type OfferSearchResult,
  offerFits,
  offerMatch,
  offerSearchAnswerProblem,
  offerSearchResult,
  offerSearchResultProblem,
  parseOfferSearch,
  parseOfferSearchResult,
  rankOffers,
} from './offer-search.js'
import { type OfferVersion, offerQuote } from './offer-version.js'
import { REASON_CODES } from './reasons.js'
import { SANDBOX_PATHS } from './sandbox.js'
import {
  offerVersionId,
  SERVICE_CATEGORY,
  type ServiceOfferVersion,
  serviceOfferQuote,
  serviceOfferTerms,
  servicePrice,
} from './service.js'
import { ARBITER, NOW } from './test-helpers.js'
import { toWire } from './wire.js'

const HOUR = 3600n
const MANDATE: Hex = `0x${'ab'.repeat(32)}`

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
): ServiceOfferVersion => ({
  ...transcript,
  supplier,
  unitPrice,
  rules: { ...transcript.rules, leadTime },
})

const search: OfferSearch = {
  query: 'english transcript',
  budget: dollars(200),
  currency: 'USD',
  category: null,
  quantity: 2,
  deliverBy: NOW + 48n * HOUR,
  needingApproval: true,
}
const match = (version: OfferVersion, s: OfferSearch = search) =>
  offerMatch(s, version, 'Acme Transcripts', NOW)
const needing = (version: OfferVersion, need: ApprovalNeed): OfferNeedingApproval => ({
  ...match(version),
  need,
})
const answer = (
  eligible: OfferMatch[],
  needingApproval: OfferNeedingApproval[] = [],
  s: OfferSearch = search,
): OfferSearchResult =>
  offerSearchResult({ search: s, checkedAt: NOW, mandate: MANDATE, eligible, needingApproval })

const cheap = match(priced(dollars(40)))
const usual = match(transcript)
const newSupplier = needing(
  priced(dollars(45), 24n * HOUR, 'beta-transcripts'),
  'mandate.supplier_not_allowed',
)

describe('the search path', () => {
  it('is a path a signed request may name', () => {
    expect(SANDBOX_PATHS.offerSearch).toBe('/v1/sandbox/offers/search')
    expect(API_PATH_PATTERN.test(SANDBOX_PATHS.offerSearch)).toBe(true)
  })
})

describe('parseOfferSearch', () => {
  it('fills in every offer of both kinds, one unit, any time and eligible offers only when they are left out', () => {
    expect(parseOfferSearch({ budget: '100000000', currency: 'USD' })).toEqual({
      ok: true,
      value: {
        query: null,
        budget: 100_000_000n,
        currency: 'USD',
        category: null,
        quantity: 1,
        deliverBy: null,
        needingApproval: false,
      },
    })
  })

  it('reads a full search, and one with no words and no deadline, through toWire', () => {
    expect(parseOfferSearch(toWire(search))).toEqual({ ok: true, value: search })
    const open = { ...search, query: null, deliverBy: null }
    expect(parseOfferSearch(toWire(open))).toEqual({ ok: true, value: open })
  })

  it.each([
    ['left out', {}],
    ['null', { query: null }],
    ['empty', { query: '' }],
    ['only whitespace', { query: ' \t\n ' }],
  ])('reads words %s as no words', (_, words) => {
    const parsed = parseOfferSearch({ budget: '1', currency: 'USD', ...words })
    expect(parsed.ok && parsed.value.query).toBeNull()
  })

  it.each([
    ['a budget of nothing', { budget: '0', currency: 'USD' }],
    ['a currency it lists none in', { budget: '1', currency: 'XYZ' }],
    ['no units', { budget: '1', currency: 'USD', quantity: 0 }],
    ['part of a unit', { budget: '1', currency: 'USD', quantity: 1.5 }],
    ['words past the limit', { budget: '1', currency: 'USD', query: 'a'.repeat(201) }],
    ["a field it doesn't know", { budget: '1', currency: 'USD', supplier: 'acme' }],
    ['a kind of offer it lists none of', { budget: '1', currency: 'USD', category: 'compute' }],
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
    expect(offerFits({ ...search, query: '   ' }, transcript, NOW)).toBe(true)
  })

  it('matches a word in the name and another in the summary', () => {
    const gpu = {
      ...transcript,
      item: { name: 'H100 GPU hour', summary: 'One hour of an H100 for rendering or training' },
    }
    const roomy = { ...search, budget: dollars(1000) }
    expect(offerFits({ ...roomy, query: 'GPU rendering' }, gpu, NOW)).toBe(true)
    expect(offerFits({ ...roomy, query: 'gpu' }, gpu, NOW)).toBe(true)
    expect(offerFits({ ...roomy, query: 'GPU inference' }, gpu, NOW)).toBe(false)
  })

  it('leaves out an offer in another currency', () => {
    expect(offerFits({ ...search, currency: 'EUR' as never }, transcript, NOW)).toBe(false)
  })

  it('leaves out an offer whose total for the quantity is over budget, whatever its reserve', () => {
    expect(offerFits({ ...search, budget: dollars(100) }, transcript, NOW)).toBe(true)
    expect(offerFits({ ...search, budget: dollars(100) - 1n }, transcript, NOW)).toBe(false)
  })

  it("leaves out an offer that doesn't take the quantity, and never throws for one", () => {
    const roomy = { ...search, budget: dollars(1000) }
    expect(offerFits({ ...roomy, quantity: 11 }, transcript, NOW)).toBe(false)
    expect(offerFits({ ...roomy, quantity: 0 }, transcript, NOW)).toBe(false)
  })

  it('leaves out an offer whose every charge rounds to nothing at the quantity', () => {
    const penny = {
      ...transcript,
      unitPrice: 1n,
      rules: { ...transcript.rules, noShowBps: 1, lateCancellationBps: 0 },
    }
    expect(offerFits({ ...search, quantity: 1 }, penny, NOW)).toBe(false)
  })

  it("leaves out an offer that can't deliver by the deadline when booked now", () => {
    expect(offerFits({ ...search, deliverBy: NOW + 24n * HOUR }, transcript, NOW)).toBe(true)
    expect(offerFits({ ...search, deliverBy: NOW + 24n * HOUR - 1n }, transcript, NOW)).toBe(false)
    expect(offerFits({ ...search, deliverBy: null }, transcript, NOW + 1000n * HOUR)).toBe(true)
  })
})

describe('offerMatch', () => {
  it('prices the offer for the quantity, names its version and says when it would deliver', () => {
    expect(usual).toEqual({
      id: offerVersionId(transcript),
      version: transcript,
      supplier: { name: 'Acme Transcripts', sandbox: true },
      quote: serviceOfferQuote(transcript, 2),
      deliverBy: NOW + 24n * HOUR,
    })
  })

  it("refuses an offer that doesn't fit, or a blank supplier name", () => {
    expect(() => match(priced(dollars(150)))).toThrow(/doesn't fit/)
    expect(() => offerMatch(search, transcript, '   ', NOW)).toThrow(/blank/)
  })

  it('lists a supplier whose registered name is longer than a result carries, under it shortened', () => {
    const long = `Acme Transcripts ${'and Sons '.repeat(20)}`
    const found = offerMatch(search, transcript, long, NOW)
    expect(found.supplier.name).toBe(shownBusinessName(long))
    expect(found.supplier.name).toHaveLength(BUSINESS_NAME_MAX)
    expect(found.supplier.name.endsWith('\u2026')).toBe(true)
  })
})

describe('rankOffers', () => {
  it('puts the lowest total first, then the soonest delivery, then the lowest version id', () => {
    const roomy = { ...search, query: null, deliverBy: null }
    const dear = match(priced(dollars(60)), roomy)
    const slow = match(priced(dollars(50), 30n * HOUR), roomy)
    const fast = match(priced(dollars(50), 12n * HOUR), roomy)
    const twinA = match(priced(dollars(40), 24n * HOUR, 'twin-a'), roomy)
    const twinB = match(priced(dollars(40), 24n * HOUR, 'twin-b'), roomy)
    const [lowTwin, highTwin] = twinA.id < twinB.id ? [twinA, twinB] : [twinB, twinA]
    expect(rankOffers([dear, slow, highTwin, fast, lowTwin])).toEqual([
      lowTwin,
      highTwin,
      fast,
      slow,
      dear,
    ])
  })
})

describe('offerSearchResult', () => {
  it('ranks each group, including the one needing approval', () => {
    const dearNew = needing(priced(dollars(48), 24n * HOUR, 'gamma'), 'mandate.over_commitment_cap')
    const result = answer([usual, cheap], [dearNew, newSupplier])
    expect(result.eligible.offers).toEqual([cheap, usual])
    expect(result.needingApproval.offers).toEqual([newSupplier, dearNew])
    expect(result.ranking).toBe(OFFER_RANKING)
  })

  it('drops offers needing approval when the search asks only for eligible ones', () => {
    const result = answer([cheap], [newSupplier], { ...search, needingApproval: false })
    expect(result.needingApproval).toEqual({ offers: [], more: false })
  })

  it('cuts a group at the limit and says more fitted', () => {
    const roomy = { ...search, query: null }
    const many = Array.from({ length: OFFER_RESULTS_MAX + 1 }, (_, i) =>
      match(priced(dollars(10) + BigInt(i)), roomy),
    )
    const result = answer(many, [], roomy)
    expect(result.eligible.offers).toHaveLength(OFFER_RESULTS_MAX)
    expect(result.eligible.more).toBe(true)
    expect(result.eligible.offers.at(-1)).toBe(many[OFFER_RESULTS_MAX - 1])
  })
})

describe('offerSearchResultProblem', () => {
  it('passes an answer built from offers that fit', () => {
    expect(offerSearchResultProblem(answer([cheap, usual], [newSupplier]))).toBeNull()
  })

  const built = answer([cheap, usual], [newSupplier])
  it.each([
    ['an offer out of order', { ...built, eligible: { offers: [usual, cheap], more: false } }],
    [
      'an offer needing approval out of order',
      {
        ...built,
        needingApproval: {
          offers: [needing(transcript, 'mandate.over_commitment_cap'), newSupplier],
          more: false,
        },
      },
    ],
    [
      'a price that is not the quote',
      {
        ...built,
        eligible: {
          offers: [{ ...cheap, quote: { ...cheap.quote, total: 1n } }, usual],
          more: false,
        },
      },
    ],
    [
      'a reserve that is not the quote',
      {
        ...built,
        eligible: {
          offers: [{ ...cheap, quote: { ...cheap.quote, reserve: 1n } }, usual],
          more: false,
        },
      },
    ],
    [
      'a delivery time that is not the lead time after the check',
      {
        ...built,
        eligible: { offers: [{ ...cheap, deliverBy: cheap.deliverBy + 1n }, usual], more: false },
      },
    ],
    [
      'an id that is not the version',
      {
        ...built,
        eligible: { offers: [{ ...cheap, id: usual.id }, usual], more: false },
      },
    ],
    ['an offer over budget', { ...built, search: { ...search, budget: dollars(90) } }],
    [
      'an offer in another currency',
      {
        ...built,
        eligible: {
          offers: [{ ...cheap, version: { ...cheap.version, currency: 'EUR' as never } }, usual],
          more: false,
        },
      },
    ],
    [
      'an offer listed twice',
      {
        ...built,
        needingApproval: {
          offers: [{ ...cheap, need: 'mandate.over_commitment_cap' as const }],
          more: false,
        },
      },
    ],
    [
      'more offers though the group is not full',
      { ...built, eligible: { offers: [cheap, usual], more: true } },
    ],
    [
      'offers needing approval the search did not ask for',
      {
        ...built,
        search: { ...search, needingApproval: false },
      },
    ],
  ])('finds %s', (_, result) => {
    expect(offerSearchResultProblem(result as OfferSearchResult)).not.toBeNull()
  })

  it('judges the deadline at the time Avow checked', () => {
    const tight = { ...search, deliverBy: NOW + 24n * HOUR }
    const onTime = answer([match(transcript, tight)], [], tight)
    expect(offerSearchResultProblem(onTime)).toBeNull()
    const late = { ...onTime, checkedAt: NOW + 1n }
    expect(offerSearchResultProblem(late)).not.toBeNull()
  })
})

describe('offerSearchAnswerProblem', () => {
  const result = answer([cheap, usual], [newSupplier])
  const held = { mandate: MANDATE, now: NOW + 60n }

  it('passes an answer to the search sent, under the mandate held, checked just now', () => {
    expect(offerSearchAnswerProblem(search, result, held)).toBeNull()
  })

  it('finds an answer to another search', () => {
    expect(offerSearchAnswerProblem({ ...search, quantity: 3 }, result, held)).toMatch(
      /another search/,
    )
  })

  it('finds an answer checked against a mandate since replaced', () => {
    const replaced = { ...held, mandate: `0x${'cd'.repeat(32)}` as Hex }
    expect(offerSearchAnswerProblem(search, result, replaced)).toMatch(/another mandate/)
  })

  it('finds an answer checked long before or after now by the agent', () => {
    expect(offerSearchAnswerProblem(search, result, { ...held, now: NOW + 301n })).toMatch(
      /just now/,
    )
    expect(offerSearchAnswerProblem(search, result, { ...held, now: NOW - 301n })).toMatch(
      /just now/,
    )
  })
})

describe('parseOfferSearchResult', () => {
  const result = answer([cheap, usual], [newSupplier])

  it('reads an answer through toWire', () => {
    expect(parseOfferSearchResult(toWire(result))).toEqual({ ok: true, value: result })
  })

  it('reads an answer to a search with no words and no deadline', () => {
    const open = { ...search, query: null, deliverBy: null }
    const openAnswer = answer([match(transcript, open)], [], open)
    expect(parseOfferSearchResult(toWire(openAnswer))).toEqual({ ok: true, value: openAnswer })
  })

  const wire = toWire(result) as Record<string, unknown> & {
    eligible: { offers: Record<string, unknown>[] }
    needingApproval: { offers: Record<string, unknown>[] }
  }
  it.each([
    [
      'a supplier not labelled sandbox',
      {
        ...wire,
        eligible: {
          offers: [{ ...wire.eligible.offers[0], supplier: { name: 'Acme', sandbox: false } }],
          more: false,
        },
      },
    ],
    [
      'a blank supplier name',
      {
        ...wire,
        eligible: {
          offers: [{ ...wire.eligible.offers[0], supplier: { name: '  ', sandbox: true } }],
          more: false,
        },
      },
    ],
    [
      'a need no administrator can lift',
      {
        ...wire,
        needingApproval: {
          offers: [{ ...wire.needingApproval.offers[0], need: 'mandate.revoked' }],
          more: false,
        },
      },
    ],
    [
      'an offer needing approval that names no need',
      {
        ...wire,
        needingApproval: { offers: [{ ...wire.eligible.offers[0] }], more: false },
      },
    ],
    [
      'an eligible offer that names a need',
      {
        ...wire,
        eligible: {
          offers: [{ ...wire.eligible.offers[0], need: 'mandate.supplier_not_allowed' }],
          more: false,
        },
      },
    ],
    [
      'an offer listed in both groups',
      {
        ...wire,
        needingApproval: {
          offers: [{ ...wire.eligible.offers[0], need: 'mandate.over_commitment_cap' }],
          more: false,
        },
      },
    ],
    ["a ranking it doesn't know", { ...wire, ranking: 'cheapest' }],
  ])('refuses %s', (_, json) => {
    expect(parseOfferSearchResult(json)).toEqual({ ok: false, reason: 'message.invalid' })
  })
})

describe('APPROVAL_NEEDS', () => {
  it('names only reason codes the spec defines', () => {
    for (const need of APPROVAL_NEEDS) expect(REASON_CODES).toHaveProperty([need])
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

  it('agrees with the terms the offer builds at every quantity it takes', () => {
    const settlement = { arbiter: ARBITER, day90SupplierShareBps: 5_000 }
    for (let quantity = 1; quantity <= transcript.rules.maxPerBooking; quantity++) {
      const quote = serviceOfferQuote(transcript, quantity)
      const terms = serviceOfferTerms(transcript, quantity, NOW, settlement)
      const charge = (kind: string) =>
        terms.remedies.charges.find((c) => c.kind === kind)?.amount ?? 0n
      expect(servicePrice(terms)).toBe(quote.total)
      expect(terms.backing.amount).toBe(quote.reserve)
      expect(charge('lateCancellation')).toBe(quote.lateCancellation)
      expect(charge('noShow')).toBe(quote.noShow)
    }
  })

  it("refuses a quantity the offer doesn't take", () => {
    expect(() => serviceOfferQuote(transcript, 11)).toThrow(/1 to 10 units/)
  })
})

/** Transcribing a whole audio archive as one job on an H100, for $120, delivered within 3 hours. */
const archive: JobOfferVersion = {
  template: JOB,
  supplier: 'acme-transcripts',
  work: { kind: 'archive-transcript', summary: 'A whole audio archive transcribed into English' },
  compute: { gpu: 'H100', count: 1, region: 'demo' },
  currency: 'USD',
  price: dollars(120),
  rules: {
    startAfter: HOUR,
    turnaround: 2n * HOUR,
    gracePeriod: 600n,
    dailyCapacity: 3,
    lateCancellationBps: 2_000,
    noShowBps: 5_000,
  },
}
const oneJob: OfferSearch = { ...search, quantity: 1 }

describe('a job offer in a search', () => {
  it('fits a search for one unit by its kind of work and summary, within budget and in time', () => {
    expect(offerFits(oneJob, archive, NOW)).toBe(true)
    expect(offerFits({ ...oneJob, query: 'ARCHIVE english' }, archive, NOW)).toBe(true)
    expect(offerFits({ ...oneJob, query: 'captions' }, archive, NOW)).toBe(false)
  })

  it('is left out of a search for more than one unit, since a job is one', () => {
    expect(offerFits(search, archive, NOW)).toBe(false)
    expect(() => offerQuote(archive, 2)).toThrow(/one job/)
  })

  it('is held to the budget by its price, and to the deadline by its start and turnaround', () => {
    expect(offerFits({ ...oneJob, budget: dollars(119) }, archive, NOW)).toBe(false)
    expect(offerFits({ ...oneJob, deliverBy: NOW + 3n * HOUR }, archive, NOW)).toBe(true)
    expect(offerFits({ ...oneJob, deliverBy: NOW + 3n * HOUR - 1n }, archive, NOW)).toBe(false)
  })

  it('is priced as the job its version builds, under its own id', () => {
    const m = match(archive, oneJob)
    expect(m.id).toBe(jobOfferVersionId(archive))
    expect(m.quote).toEqual({
      total: dollars(120),
      lateCancellation: dollars(24),
      noShow: dollars(60),
      reserve: dollars(60),
    })
    expect(m.deliverBy).toBe(NOW + 3n * HOUR)
    const terms = jobOfferTerms(archive, NOW, { arbiter: ARBITER, day90SupplierShareBps: 5_000 })
    expect(terms.consideration.amount).toBe(m.quote.total)
    expect(terms.backing.amount).toBe(m.quote.reserve)
    expect(terms.subject.deliverBy).toBe(m.deliverBy)
  })

  it('lists only jobs or only services when the search names one kind, and both when it names none', () => {
    const kinds = (category: OfferSearch['category']) =>
      [archive, transcript].filter((v) => offerFits({ ...oneJob, query: null, category }, v, NOW))
    expect(kinds(null)).toEqual([archive, transcript])
    expect(kinds(JOB_CATEGORY)).toEqual([archive])
    expect(kinds(SERVICE_CATEGORY)).toEqual([transcript])
    const jobsOnly = { ...oneJob, category: JOB_CATEGORY }
    expect(parseOfferSearch(toWire(jobsOnly))).toEqual({ ok: true, value: jobsOnly })
    const sent = answer([match(archive, jobsOnly)], [], jobsOnly)
    expect(parseOfferSearchResult(toWire(sent))).toEqual({ ok: true, value: sent })
    const held = { mandate: MANDATE, now: NOW }
    expect(offerSearchAnswerProblem(jobsOnly, sent, held)).toBeNull()
    expect(offerSearchAnswerProblem(oneJob, sent, held)).toMatch(/another search/)
  })

  it('ranks beside services, and reads back through toWire', () => {
    const job = match(archive, oneJob)
    const service = match(transcript, oneJob)
    expect(rankOffers([job, service])).toEqual([service, job])
    const mixed = answer([job, service], [], oneJob)
    expect(parseOfferSearchResult(toWire(mixed))).toEqual({ ok: true, value: mixed })
  })

  it("refuses an answer whose job is listed under another id, or that doesn't deliver when it says", () => {
    const job = match(archive, oneJob)
    const wrongId = answer([{ ...job, id: offerVersionId(transcript) }], [], oneJob)
    expect(offerSearchResultProblem(wrongId)).toMatch(/doesn't match/)
    const late = answer([{ ...job, deliverBy: job.deliverBy + 1n }], [], oneJob)
    expect(offerSearchResultProblem(late)).toMatch(/doesn't match/)
  })
})
