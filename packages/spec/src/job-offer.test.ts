import { readFileSync } from 'node:fs'
import { type Hex, keccak256, maxUint64, maxUint256, toHex } from 'viem'
import { describe, expect, it } from 'vitest'
import { canonicalJson } from './canonical.js'
import { dollars } from './demo.js'
import { chainedJobTerms, JOB, JOB_CATEGORY, validateJob } from './job.js'
import {
  JOB_OFFER_CHARGE_AFTER,
  JOB_OFFER_START_MIN,
  JOB_OFFER_VERSION_LABEL,
  type JobOfferVersion,
  jobOfferProblem,
  jobOfferQuote,
  jobOfferTerms,
  jobOfferVersionFields,
  jobOfferVersionId,
  jobTermsMatchOffer,
  parseJobOfferVersion,
} from './job-offer.js'
import {
  isJobOfferVersion,
  offerIdOf,
  offerItemOf,
  offerVersionProblem,
  parseOfferVersion,
} from './offer-version.js'
import { TESTNET_DEMO_PROFILE } from './profiles.js'
import { offerVersionId, SERVICE_CATEGORY, type ServiceOfferVersion } from './service.js'
import { templateCategoryProblem, validateChainedTerms } from './terms.js'
import { ARBITER, COMPUTE_REFERENCE, NOW } from './test-helpers.js'
import { toWire } from './wire.js'

const MINUTE = 60n
const HOUR = 60n * MINUTE
const settlement = { arbiter: ARBITER, day90SupplierShareBps: 5_000 }

/** A supplier's offer of fine-tuning on one H100, for $120 a job. */
const version: JobOfferVersion = {
  template: JOB,
  supplier: 'biz_supplier',
  work: { kind: 'fine-tuning', summary: 'Fine-tune a small model on the dataset the buyer sends' },
  compute: { gpu: 'H100', count: 1, region: 'demo' },
  currency: 'USD',
  price: dollars(120),
  rules: {
    startAfter: HOUR,
    turnaround: 2n * HOUR,
    gracePeriod: 10n * MINUTE,
    dailyCapacity: 3,
    lateCancellationBps: 2_000,
    noShowBps: 5_000,
  },
}
const withRules = (change: Partial<JobOfferVersion['rules']>): JobOfferVersion => ({
  ...version,
  rules: { ...version.rules, ...change },
})
const roundTrip = (value: unknown) => JSON.parse(JSON.stringify(toWire(value)))

const service: ServiceOfferVersion = {
  supplier: 'biz_supplier',
  item: { name: 'fine-tuning', summary: 'One fine-tuning run' },
  currency: 'USD',
  unitPrice: dollars(50),
  rules: {
    evidence: 'The tuned weights are delivered to the buyer',
    leadTime: 24n * HOUR,
    maxPerBooking: 4,
    dailyCapacity: 5,
    freeCancelWindow: 0n,
    lateCancellationBps: 2_000,
    noShowBps: 5_000,
    payment: { route: 'transfer', dueAfterDelivery: 0n },
  },
}

describe('a job offer version', () => {
  it('passes its own rules, and reads back from JSON as it was written', () => {
    expect(jobOfferProblem(version)).toBeNull()
    const parsed = parseJobOfferVersion(roundTrip(version))
    expect(parsed).toEqual({ ok: true, value: version })
  })

  it('refuses each way a version is malformed', () => {
    const cases: JobOfferVersion[] = [
      { ...version, template: 'service/1' as never },
      { ...version, supplier: '' },
      { ...version, work: { ...version.work, kind: 'fine "tuning"' } },
      { ...version, work: { ...version.work, kind: 'fine\ntuning' } },
      { ...version, work: { ...version.work, kind: 'k'.repeat(65) } },
      { ...version, work: { ...version.work, summary: 'half a \ud800 character' } },
      { ...version, compute: { ...version.compute, count: 0 } },
      { ...version, compute: { ...version.compute, count: 1025 } },
      { ...version, compute: { ...version.compute, gpu: '' } },
      { ...version, price: 0n },
      { ...version, currency: 'EUR' as never },
      withRules({ startAfter: JOB_OFFER_START_MIN - 1n }),
      withRules({ turnaround: 0n }),
      withRules({ gracePeriod: 2n * HOUR + 1n }),
      withRules({ gracePeriod: -1n }),
      withRules({ dailyCapacity: 0 }),
      withRules({ lateCancellationBps: 10_001 }),
      withRules({ lateCancellationBps: 0, noShowBps: 0 }),
      withRules({ startAfter: 3600 as never }),
      // Past a uint64 of seconds once the charge window after delivery is added.
      withRules({ startAfter: JOB_OFFER_START_MIN, turnaround: maxUint64 }),
      // Past a uint256 once multiplied by 10,000 basis points.
      { ...version, price: maxUint256 / 10_000n + 1n },
    ]
    for (const v of cases) {
      expect(jobOfferProblem(v), JSON.stringify(toWire(v))).not.toBeNull()
      expect(() => jobOfferVersionId(v)).toThrow(RangeError)
    }
    expect(jobOfferProblem(null as never)).not.toBeNull()
    expect(jobOfferProblem(withRules({ startAfter: JOB_OFFER_START_MIN }))).toBeNull()
    expect(jobOfferProblem(withRules({ gracePeriod: 2n * HOUR }))).toBeNull()
    // Each bound holds at its edge.
    const turnaround = maxUint64 - JOB_OFFER_START_MIN - JOB_OFFER_CHARGE_AFTER
    expect(jobOfferProblem(withRules({ startAfter: JOB_OFFER_START_MIN, turnaround }))).toBeNull()
    expect(
      jobOfferProblem(withRules({ startAfter: JOB_OFFER_START_MIN, turnaround: turnaround + 1n })),
    ).not.toBeNull()
    expect(jobOfferProblem({ ...version, price: maxUint256 / 10_000n })).toBeNull()
  })

  it('reads no JSON with a field it does not know or a field missing', () => {
    const wire = roundTrip(version)
    expect(parseJobOfferVersion({ ...wire, offer: '0x00' }).ok).toBe(false)
    expect(parseJobOfferVersion({ ...wire, rules: { ...wire.rules, leadTime: '1' } }).ok).toBe(
      false,
    )
    const { template: _, ...untemplated } = wire
    expect(parseJobOfferVersion(untemplated).ok).toBe(false)
    expect(parseJobOfferVersion({ ...wire, price: '0' }).ok).toBe(false)
  })

  it('has an id over exactly its own fields, under a label of its own', () => {
    const id = jobOfferVersionId(version)
    expect(id).toMatch(/^0x[0-9a-f]{64}$/)
    expect(jobOfferVersionId({ ...version, extra: 1 } as JobOfferVersion)).toBe(id)
    expect(jobOfferVersionFields({ ...version, extra: 1 } as JobOfferVersion)).toEqual(version)
    expect(jobOfferVersionId({ ...version, price: version.price + 1n })).not.toBe(id)
    expect(jobOfferVersionId(withRules({ gracePeriod: 11n * MINUTE }))).not.toBe(id)
    expect(
      jobOfferVersionId({ ...version, compute: { ...version.compute, region: 'demo-2' } }),
    ).not.toBe(id)
    expect(JOB_OFFER_VERSION_LABEL).toBe('avow:offer:job/1')
  })
})

describe('what a job of an offer version costs', () => {
  it('charges each share of the price, rounded up to the micro', () => {
    expect(jobOfferQuote(version)).toEqual({
      price: dollars(120),
      lateCancellation: dollars(24),
      noShow: dollars(60),
      reserve: dollars(60),
    })
    // 20% of 5.000001 dollars is 1.0000002, which rounds up to 1.000001.
    const awkward = jobOfferQuote({ ...version, price: 5_000_001n })
    expect(awkward.lateCancellation).toBe(1_000_001n)
    expect(awkward.noShow).toBe(2_500_001n)
    // At a micro, a share above zero is still a micro.
    expect(jobOfferQuote({ ...version, price: 1n }).lateCancellation).toBe(1n)
    expect(jobOfferQuote(withRules({ lateCancellationBps: 0 })).lateCancellation).toBe(0n)
  })
})

describe('job terms from an offer version', () => {
  const terms = jobOfferTerms(version, NOW, settlement)

  it('build the job at its price, starting and delivering when its rules say', () => {
    const startsAt = NOW + HOUR
    const deliverBy = startsAt + 2n * HOUR
    expect(terms.template).toBe(JOB)
    expect(terms.subject).toEqual({
      work: version.work,
      compute: version.compute,
      startsAt,
      deliverBy,
    })
    expect(terms.consideration).toEqual({ kind: 'fixed', amount: dollars(120) })
    expect(terms.remedies).toEqual({
      acceptBy: startsAt,
      freeCancelBy: startsAt,
      charges: [
        { kind: 'lateCancellation', amount: dollars(24), earliest: startsAt },
        { kind: 'noShow', amount: dollars(60), earliest: startsAt + 10n * MINUTE },
      ],
      chargeDeadline: deliverBy + JOB_OFFER_CHARGE_AFTER,
    })
    expect(terms.backing.amount).toBe(dollars(60))
    expect(terms.backing.releaseDate).toBe(deliverBy + JOB_OFFER_CHARGE_AFTER)
    expect(validateJob(terms)).toBeNull()
    expect(templateCategoryProblem(terms, JOB_CATEGORY)).toBeNull()
  })

  it('leave a charge at zero out', () => {
    const terms = jobOfferTerms(withRules({ lateCancellationBps: 0 }), NOW, settlement)
    expect(terms.remedies.charges.map((c) => c.kind)).toEqual(['noShow'])
  })

  it('pass as version 3 terms once the quote adds the compute booking', () => {
    const quoted = chainedJobTerms(terms, [
      { on: COMPUTE_REFERENCE, condition: 'accepted', disclosed: 'subject' },
    ])
    expect(validateChainedTerms(quoted, TESTNET_DEMO_PROFILE)).toBeNull()
    expect(jobTermsMatchOffer(quoted, version)).toBe(true)
  })

  it('match the version they came from and nothing moved from it', () => {
    expect(jobTermsMatchOffer(terms, version)).toBe(true)
    expect(jobTermsMatchOffer(jobOfferTerms(version, NOW + 7n, settlement), version)).toBe(true)
    const other = { arbiter: ARBITER, day90SupplierShareBps: 6_000 }
    expect(jobTermsMatchOffer(jobOfferTerms(version, NOW, other), version)).toBe(true)

    const moved = [
      { ...terms, consideration: { kind: 'fixed' as const, amount: dollars(119) } },
      { ...terms, subject: { ...terms.subject, deliverBy: terms.subject.deliverBy + 1n } },
      { ...terms, subject: { ...terms.subject, compute: { ...version.compute, count: 2 } } },
      { ...terms, remedies: { ...terms.remedies, charges: terms.remedies.charges.slice(1) } },
      { ...terms, backing: { ...terms.backing, amount: terms.backing.amount + 1n } },
      { ...terms, resolution: { ...terms.resolution, contestWindow: 601n } },
    ]
    for (const t of moved) expect(jobTermsMatchOffer(t, version)).toBe(false)
    expect(jobTermsMatchOffer(terms, { ...version, price: dollars(119) })).toBe(false)
    expect(jobTermsMatchOffer(terms, withRules({ startAfter: 0n }))).toBe(false)
    expect(jobTermsMatchOffer(null as never, version)).toBe(false)
  })
})

describe('an offer version of either kind', () => {
  it('reads a service and a job apart, and refuses JSON that is neither', () => {
    expect(isJobOfferVersion(version)).toBe(true)
    expect(isJobOfferVersion(service)).toBe(false)
    expect(parseOfferVersion(roundTrip(version))).toEqual({ ok: true, value: version })
    expect(parseOfferVersion(roundTrip(service))).toEqual({ ok: true, value: service })
    // A job's fields under a service's shape, or a template on a service, read as neither.
    expect(parseOfferVersion({ ...roundTrip(service), template: JOB }).ok).toBe(false)
    expect(parseOfferVersion({ ...roundTrip(version), template: 'service/1' }).ok).toBe(false)
    expect(parseOfferVersion(roundTrip({ ...version, price: 0n })).ok).toBe(false)
    expect(offerVersionProblem(null as never)).not.toBeNull()
  })

  it('gives each its own id and names its item under its category', () => {
    expect(offerIdOf(version)).toBe(jobOfferVersionId(version))
    expect(offerIdOf(service)).toBe(offerVersionId(service))
    expect(offerIdOf(version)).not.toBe(offerIdOf(service))
    expect(offerItemOf(version)).toEqual({ category: JOB_CATEGORY, name: 'fine-tuning' })
    expect(offerItemOf(service)).toEqual({ category: SERVICE_CATEGORY, name: 'fine-tuning' })
  })
})

/**
 * The vectors another implementation checks itself against, in `vectors/job-offer-v1.json`.
 * `scripts/write-job-offer-vectors.mjs` wrote them. This fails when the code and the file disagree,
 * so a change to how a version hashes needs new vectors and a new label.
 */
describe('pinned job offer vectors', () => {
  const file = JSON.parse(
    readFileSync(new URL('../vectors/job-offer-v1.json', import.meta.url), 'utf8'),
  ) as {
    label: string
    vectors: { name: string; version: unknown; canonicalJson: string; id: Hex }[]
  }

  it('holds three vectors under the current label, byte for byte as written', () => {
    expect(file.label).toBe(JOB_OFFER_VERSION_LABEL)
    expect(file.vectors).toHaveLength(3)
    const bytes = readFileSync(new URL('../vectors/job-offer-v1.json', import.meta.url))
    expect(keccak256(toHex(bytes))).toBe(
      '0xd6cb8ebdf88a5d93d586695a8889892795ed22c1991808983e7e96eac647ce07',
    )
  })

  for (const v of file.vectors) {
    it(`${v.name}: reproduces the canonical JSON and the id`, () => {
      const parsed = parseJobOfferVersion(v.version)
      if (!parsed.ok) throw new Error(`the vector's version doesn't parse: ${parsed.reason}`)
      expect(toWire(parsed.value)).toEqual(v.version)
      expect(canonicalJson(jobOfferVersionFields(parsed.value))).toBe(v.canonicalJson)
      expect(jobOfferVersionId(parsed.value)).toBe(v.id)
    })
  }
})
