import { describe, expect, it } from 'vitest'
import { dollars } from './demo.js'
import { subjectFits, subjectProblem } from './dependencies.js'
import { TESTNET_DEMO_PROFILE } from './profiles.js'
import {
  offerVersionId,
  parseServiceOfferVersion,
  SERVICE,
  SERVICE_ACCEPT_WITHIN,
  SERVICE_CATEGORY,
  SERVICE_CHARGE_AFTER,
  SERVICE_UNIT,
  type ServiceOfferVersion,
  type ServiceTerms,
  serviceOfferProblem,
  serviceOfferTerms,
  servicePrice,
  serviceTermsMatchOffer,
  validateService,
} from './service.js'
import { templateCategoryProblem, termsHash, validateTerms } from './terms.js'
import { ARBITER, NOW, SALT } from './test-helpers.js'
import { parseTerms, toWire } from './wire.js'

const HOUR = 3600n
const settlement = { arbiter: ARBITER, day90SupplierShareBps: 5_000 }

/** A supplier's offer of transcription by the hour of audio, at $50 a unit. */
const version: ServiceOfferVersion = {
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
const withRules = (change: Partial<ServiceOfferVersion['rules']>): ServiceOfferVersion => ({
  ...version,
  rules: { ...version.rules, ...change },
})

const terms = serviceOfferTerms(version, 2, NOW, settlement)
const roundTrip = (value: unknown) => JSON.parse(JSON.stringify(toWire(value)))
const withSubject = (change: Partial<ServiceTerms['subject']>): ServiceTerms => ({
  ...terms,
  subject: { ...terms.subject, ...change },
})

describe('service terms from an offer version', () => {
  it('book the version at its price, with delivery, payment and charges from its rules', () => {
    expect(terms.template).toBe(SERVICE)
    expect(terms.subject).toEqual({
      offer: offerVersionId(version),
      item: version.item,
      quantity: 2,
      delivery: { by: NOW + 24n * HOUR, evidence: version.rules.evidence },
      payment: { route: 'transfer', dueBy: NOW + 24n * HOUR + 7n * 24n * HOUR },
    })
    expect(terms.consideration).toEqual({ kind: 'rate', amount: dollars(50), unit: SERVICE_UNIT })
    expect(servicePrice(terms)).toBe(dollars(100))
    expect(terms.remedies).toEqual({
      acceptBy: NOW + SERVICE_ACCEPT_WITHIN,
      freeCancelBy: NOW + 2n * HOUR,
      charges: [
        { kind: 'lateCancellation', amount: dollars(20), earliest: NOW + 2n * HOUR },
        { kind: 'noShow', amount: dollars(50), earliest: NOW + 24n * HOUR },
      ],
      chargeDeadline: NOW + 24n * HOUR + SERVICE_CHARGE_AFTER,
    })
    // The reserve is the larger charge, and the price is never part of it.
    expect(terms.backing.amount).toBe(dollars(50))
    expect(validateTerms(terms, TESTNET_DEMO_PROFILE)).toBeNull()
  })

  it('give a new version a new id, and leave terms booked under the old one as they were', () => {
    const before = termsHash(terms, SALT)
    const repriced = { ...version, unitPrice: dollars(60) }
    expect(offerVersionId(repriced)).not.toBe(offerVersionId(version))
    const later = serviceOfferTerms(repriced, 2, NOW, settlement)
    expect(servicePrice(later)).toBe(dollars(120))
    expect(termsHash(terms, SALT)).toBe(before)
    expect(servicePrice(terms)).toBe(dollars(100))
  })

  it('build terms that pass the template at the shortest lead time and with no free cancellation', () => {
    const quick = withRules({ leadTime: SERVICE_ACCEPT_WITHIN, freeCancelWindow: 0n })
    const t = serviceOfferTerms(quick, 1, NOW, settlement)
    expect(t.remedies.acceptBy).toBe(t.subject.delivery.by)
    expect(validateTerms(t, TESTNET_DEMO_PROFILE)).toBeNull()
  })

  it('refuse a quantity the version does not take, a version it can not book, and charges that round to zero', () => {
    expect(() => serviceOfferTerms(version, 0, NOW, settlement)).toThrow(RangeError)
    expect(() => serviceOfferTerms(version, 11, NOW, settlement)).toThrow(RangeError)
    expect(() => serviceOfferTerms({ ...version, unitPrice: 0n }, 1, NOW, settlement)).toThrow(
      /more than zero/,
    )
    const tiny = { ...withRules({ noShowBps: 1, lateCancellationBps: 1 }), unitPrice: 1n }
    expect(() => serviceOfferTerms(tiny, 1, NOW, settlement)).toThrow(/rounds to zero/)
  })
})

describe('an offer version', () => {
  it('says what is wrong in words for the supplier', () => {
    expect(serviceOfferProblem(version)).toBeNull()
    const wrong = (v: ServiceOfferVersion, words: RegExp) =>
      expect(serviceOfferProblem(v)).toMatch(words)
    wrong({ ...version, unitPrice: -1n }, /more than zero/)
    wrong({ ...version, item: { ...version.item, name: '   ' } }, /Name the item/)
    wrong({ ...version, item: { ...version.item, name: 'x'.repeat(121) } }, /Name the item/)
    wrong(withRules({ evidence: ' ' }), /counts as delivery/)
    wrong(withRules({ leadTime: SERVICE_ACCEPT_WITHIN - 1n }), /at least 15 minutes/)
    wrong(withRules({ freeCancelWindow: 60n }), /Free cancellation/)
    wrong(withRules({ freeCancelWindow: version.rules.leadTime + 1n }), /Free cancellation/)
    wrong(withRules({ maxPerBooking: 0 }), /units/)
    wrong(withRules({ noShowBps: 10_001 }), /0 to 100%/)
    wrong(withRules({ lateCancellationBps: 0, noShowBps: 0 }), /reserve backs nothing/)
  })

  it('has one id for its content, and none for fields of the wrong type', () => {
    const extra = { ...version, stripePrice: 'price_123' } as ServiceOfferVersion
    expect(offerVersionId(extra)).toBe(offerVersionId(version))
    const numeric = withRules({ leadTime: 86_400 as unknown as bigint })
    expect(() => offerVersionId(numeric)).toThrow(RangeError)
    const text = { ...version, unitPrice: '50000000' as unknown as bigint }
    expect(() => offerVersionId(text)).toThrow(RangeError)
  })

  it('reads back from JSON with the same id, and refuses an unknown field or a broken rule', () => {
    const parsed = parseServiceOfferVersion(roundTrip(version))
    expect(parsed).toEqual({ ok: true, value: version })
    if (parsed.ok) expect(offerVersionId(parsed.value)).toBe(offerVersionId(version))
    expect(parseServiceOfferVersion({ ...roundTrip(version), extra: 1 }).ok).toBe(false)
    expect(parseServiceOfferVersion(roundTrip(withRules({ freeCancelWindow: 60n }))).ok).toBe(false)
  })
})

describe('terms against the offer version they name', () => {
  it('match when built from it, and not when any part was changed', () => {
    expect(serviceTermsMatchOffer(terms, version)).toBe(true)
    expect(serviceTermsMatchOffer(terms, { ...version, unitPrice: dollars(60) })).toBe(false)
    const cheaper = { ...terms, consideration: { ...terms.consideration, amount: dollars(40) } }
    expect(serviceTermsMatchOffer(cheaper, version)).toBe(false)
    expect(
      serviceTermsMatchOffer(withSubject({ item: { ...version.item, name: 'Other' } }), version),
    ).toBe(false)
    const lighter = { ...terms, backing: { ...terms.backing, amount: dollars(1) } }
    expect(serviceTermsMatchOffer(lighter, version)).toBe(false)
  })
})

describe("the service template's rules", () => {
  it('fall under the service category alone', () => {
    expect(templateCategoryProblem(terms, SERVICE_CATEGORY)).toBeNull()
    expect(templateCategoryProblem(terms, 'compute')).toBe('terms.category_mismatch')
  })

  it('refuse a subject of the wrong shape', () => {
    const invalid = (t: ServiceTerms) => expect(validateService(t)).toBe('terms.template_invalid')
    invalid(withSubject({ offer: `0x${'AB'.repeat(32)}` }))
    invalid(withSubject({ offer: '0x1234' }))
    invalid(withSubject({ quantity: 0 }))
    invalid(withSubject({ quantity: 1.5 }))
    invalid(withSubject({ item: { name: '  ', summary: 'x' } }))
    invalid(withSubject({ delivery: { by: terms.subject.delivery.by, evidence: '' } }))
    invalid(withSubject({ payment: { route: 'card' as 'transfer', dueBy: NOW } }))
    invalid({ ...terms, consideration: { kind: 'fixed', amount: dollars(100) } })
    invalid({ ...terms, consideration: { kind: 'rate', amount: 0n, unit: SERVICE_UNIT } })
  })

  it('keep acceptance, free cancellation and payment in order around delivery', () => {
    const late = (t: ServiceTerms) =>
      expect(validateService(t)).toBe('terms.deadlines_out_of_order')
    const by = terms.subject.delivery.by
    late({ ...terms, remedies: { ...terms.remedies, acceptBy: by + 1n } })
    late({ ...terms, remedies: { ...terms.remedies, freeCancelBy: by + 1n } })
    late({ ...terms, remedies: { ...terms.remedies, chargeDeadline: by - 1n } })
    late(withSubject({ payment: { route: 'invoice', dueBy: by - 1n } }))
    const earlyNoShow = terms.remedies.charges.map((c) =>
      c.kind === 'noShow' ? { ...c, earliest: by - 1n } : c,
    )
    late({ ...terms, remedies: { ...terms.remedies, charges: earlyNoShow } })
  })

  it('rely on no booking', () => {
    expect(subjectProblem(terms)).toBeNull()
    expect(subjectFits(terms, terms)).toBe(false)
  })

  it('read back from JSON as they were written, with the same hash', () => {
    const parsed = parseTerms(roundTrip(terms))
    expect(parsed).toEqual({ ok: true, value: terms })
    if (parsed.ok) expect(termsHash(parsed.value, SALT)).toBe(termsHash(terms, SALT))
    const extra = { ...roundTrip(terms), subject: { ...roundTrip(terms.subject), extra: 1 } }
    expect(parseTerms(extra).ok).toBe(false)
  })
})
