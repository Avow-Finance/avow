import { describe, expect, it } from 'vitest'
import { dollars, testnetDemoJobTerms, testnetDemoTerms } from './demo.js'
import { type CheckedChainedTerms, subjectFits, subjectProblem } from './dependencies.js'
import { elideDependencies } from './elided-terms.js'
import {
  chainedJobTerms,
  JOB,
  JOB_CATEGORY,
  type JobSubject,
  type JobTerms,
  jobFitsReservation,
  validateJob,
} from './job.js'
import { checkMandate } from './mandate.js'
import { TESTNET_DEMO_PROFILE } from './profiles.js'
import { discloseSection, termsHash, validateChainedTerms, validateTerms } from './terms.js'
import {
  ARBITER,
  COMPUTE_REFERENCE,
  demoMandate,
  demoRequest,
  NOW,
  newKey,
  SALT,
  START,
  TOKEN,
} from './test-helpers.js'
import { parseChainedTerms, parseSectionDisclosure, parseTerms, toWire } from './wire.js'

const job = testnetDemoJobTerms(START, ARBITER)
const relyOn = { on: COMPUTE_REFERENCE, condition: 'accepted', disclosed: 'subject' } as const
const chained = chainedJobTerms(job, [relyOn])
const roundTrip = (value: unknown) => JSON.parse(JSON.stringify(toWire(value)))

/** The compute a job runs on: one H100 in the demo region for the half hour from `START`. */
const reservation = testnetDemoTerms(START, ARBITER).subject

/** The job with its subject changed. */
const withSubject = (change: Partial<JobSubject>): JobTerms => ({
  ...job,
  subject: { ...job.subject, ...change },
})

describe('job terms', () => {
  it('end free cancellation when work starts, and charge from then', () => {
    expect(job.template).toBe(JOB)
    expect(job.consideration).toEqual({ kind: 'fixed', amount: dollars(40) })
    expect(job.remedies.freeCancelBy).toBe(START)
    expect(job.remedies.acceptBy).toBe(START)
    expect(job.remedies.charges).toEqual([
      { kind: 'lateCancellation', amount: dollars(10), earliest: START },
      { kind: 'noShow', amount: dollars(6), earliest: START + 120n },
    ])
    // The reserve is the larger charge, and the price is never part of it.
    expect(job.backing.amount).toBe(dollars(10))
  })

  it('commit only under version 3, naming the compute they run on', () => {
    expect(validateChainedTerms(chained, TESTNET_DEMO_PROFILE)).toBeNull()
    expect(validateTerms(job, TESTNET_DEMO_PROFILE)).toBe('dependency.required')
  })

  it('take only the buyer setting, since the customer checks the compute itself', () => {
    const avow = { ...chained, dependencyCheck: 'avow' } as never
    expect(validateChainedTerms(avow, TESTNET_DEMO_PROFILE)).toBe('terms.template_invalid')
    expect(parseChainedTerms(roundTrip(avow)).ok).toBe(false)
    expect(() => elideDependencies(avow, SALT)).toThrow(TypeError)
  })

  it('read back from JSON in both shapes, and hash like any sectioned terms', () => {
    expect(parseChainedTerms(roundTrip(chained))).toEqual({ ok: true, value: chained })
    expect(parseTerms(roundTrip(job))).toEqual({ ok: true, value: job })
    expect(termsHash(chained, SALT)).not.toBe(termsHash(job, SALT))
    const subject = parseSectionDisclosure(roundTrip(discloseSection(chained, SALT, 'subject')))
    expect(subject.ok && subject.value.content).toEqual(job.subject)
  })

  it('pass the mandate check once checked, under the job category alone', () => {
    const agent = newKey()
    const mandate = {
      ...demoMandate(newKey().address, agent.address),
      categories: ['compute', JOB_CATEGORY],
    }
    const decide = (terms: JobTerms | CheckedChainedTerms, category: string = JOB_CATEGORY) =>
      checkMandate({
        mandate,
        request: { ...demoRequest(agent.address), category, terms },
        token: TOKEN,
        openReserves: 0n,
        revoked: false,
        now: NOW,
        profile: TESTNET_DEMO_PROFILE,
      })
    expect(decide(chained as CheckedChainedTerms).result).toBe('approved')
    expect(decide(job)).toEqual({ result: 'denied', reason: 'dependency.required' })
    expect(decide(chained as CheckedChainedTerms, 'compute')).toEqual({
      result: 'denied',
      reason: 'terms.category_mismatch',
    })
    // A GPU reservation names its own category, as before.
    expect(decide(demoRequest(agent.address).terms as never, 'compute').result).toBe('approved')
  })
})

describe('the job template’s rules', () => {
  const rules = (t: JobTerms) => validateJob(t)

  it('pass the demo job', () => {
    expect(rules(job)).toBeNull()
  })

  it('refuse a job whose work, compute or times are out of form', () => {
    const work = job.subject.work
    expect(rules(withSubject({ work: { ...work, kind: '' } }))).toBe('terms.template_invalid')
    expect(rules(withSubject({ work: { ...work, summary: 'x'.repeat(281) } }))).toBe(
      'terms.template_invalid',
    )
    const compute = job.subject.compute
    expect(rules(withSubject({ compute: { ...compute, count: 0 } }))).toBe('terms.template_invalid')
    expect(rules(withSubject({ startsAt: 1 as never }))).toBe('terms.template_invalid')
    expect(rules(withSubject({ deliverBy: START }))).toBe('terms.deadlines_out_of_order')
  })

  it('refuse a price that isn’t one fixed amount above zero', () => {
    const rate = { kind: 'rate', amount: dollars(3), unit: 'gpu-hour' } as const
    expect(rules({ ...job, consideration: rate })).toBe('terms.template_invalid')
    expect(rules({ ...job, consideration: { kind: 'fixed', amount: 0n } })).toBe(
      'terms.template_invalid',
    )
  })

  it('refuse free cancellation that ends at another moment than the start', () => {
    const remedies = { ...job.remedies, freeCancelBy: START - 1n }
    expect(rules({ ...job, remedies })).toBe('terms.template_invalid')
  })

  it('refuse an acceptance after the start, and a deadline after the charge deadline', () => {
    const late = { ...job.remedies, acceptBy: START + 1n }
    expect(rules({ ...job, remedies: late })).toBe('terms.deadlines_out_of_order')
    const beyond = withSubject({ deliverBy: job.remedies.chargeDeadline + 1n })
    expect(rules(beyond)).toBe('terms.deadlines_out_of_order')
  })

  it('refuse a late cancellation chargeable before work starts, and an early no-show', () => {
    const [late, noShow] = job.remedies.charges
    if (!late || !noShow) throw new Error('The demo job has both charges')
    const early = { ...job.remedies, charges: [{ ...late, earliest: START - 1n }, noShow] }
    expect(rules({ ...job, remedies: early })).toBe('terms.template_invalid')
    const soon = { ...job.remedies, charges: [late, { ...noShow, earliest: START - 1n }] }
    expect(rules({ ...job, remedies: soon })).toBe('terms.deadlines_out_of_order')
  })
})

describe('a job inside the compute it relies on', () => {
  const fits = (s: JobSubject) => jobFitsReservation(s, reservation)

  it('fits a reservation of the same GPU and region that holds it for the whole run', () => {
    expect(fits(job.subject)).toBe(true)
    expect(
      subjectFits(
        { template: JOB, subject: job.subject },
        { template: 'gpu-reservation/1', subject: reservation },
      ),
    ).toBe(true)
  })

  it('fits nowhere when it needs more, another GPU or region, or time outside the window', () => {
    const { compute } = job.subject
    expect(fits({ ...job.subject, compute: { ...compute, count: 9 } })).toBe(false)
    expect(fits({ ...job.subject, compute: { ...compute, gpu: 'A100' } })).toBe(false)
    expect(fits({ ...job.subject, compute: { ...compute, region: 'elsewhere' } })).toBe(false)
    expect(fits({ ...job.subject, startsAt: START - 1n })).toBe(false)
    expect(fits({ ...job.subject, deliverBy: START + 1801n })).toBe(false)
    expect(fits({ ...job.subject, deliverBy: START + 1800n })).toBe(true)
  })

  it('fits inside nothing but a GPU reservation, and nothing fits inside a job', () => {
    const asJob = { template: JOB, subject: job.subject }
    const asGpu = { template: 'gpu-reservation/1', subject: reservation }
    expect(subjectFits(asJob, asJob)).toBe(false)
    expect(subjectFits(asGpu, asJob)).toBe(false)
    expect(subjectProblem(asJob)).toBeNull()
  })
})
