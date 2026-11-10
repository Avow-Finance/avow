import { describe, expect, it } from 'vitest'
import { dollars } from './demo.js'
import {
  AFTER_ACCEPTANCE,
  CHECK_BOUNDARY,
  COMPUTE_PROVES,
  DECISIVE_SENTENCE,
  jobEventSentence,
  RECOVERED_DECISIVE_SENTENCE,
  REFUSAL_CHALLENGE,
  REFUSAL_INSTRUCTION,
  reserveLine,
  SEPARATE_RESERVES,
  SIMULATED_LINE,
} from './job-wording.js'
import { describeReason } from './reasons.js'
import { parseSessionEvent } from './sandbox.js'
import { SIMULATED_RESULT_LABEL } from './test-customer.js'
import { JOB_EVENTS, READ_BLOCK } from './test-helpers.js'
import { toWire } from './wire.js'

const charges = [
  { kind: 'lateCancellation', amount: dollars(10) },
  { kind: 'noShow', amount: dollars(6) },
] as const

const everything = [
  DECISIVE_SENTENCE,
  RECOVERED_DECISIVE_SENTENCE,
  COMPUTE_PROVES,
  SEPARATE_RESERVES,
  CHECK_BOUNDARY,
  AFTER_ACCEPTANCE,
  REFUSAL_CHALLENGE,
  REFUSAL_INSTRUCTION,
  reserveLine(charges),
  SIMULATED_LINE,
  SIMULATED_RESULT_LABEL,
  ...JOB_EVENTS.map(jobEventSentence),
]

describe('the words a job’s terminal and screen share', () => {
  it('say the decisive moment exactly', () => {
    expect(DECISIVE_SENTENCE).toBe(
      "Your code verified the customer's commitment and checked its reserve. The customer accepted after verifying your compute booking. Work starts when the customer's free cancellation ends.",
    )
    const checked = JOB_EVENTS.find((e) => e.type === 'job_commitment_checked')
    if (!checked) throw new Error('The fixtures check a commitment')
    expect(jobEventSentence(checked)).toBe(DECISIVE_SENTENCE)
    // An acceptance an earlier attempt sent says so, since this run didn't repeat its checks.
    expect(jobEventSentence({ ...checked, acceptedIn: null })).toBe(RECOVERED_DECISIVE_SENTENCE)
  })

  it('names your business when it never accepted the customer’s reserve', () => {
    const refused = JOB_EVENTS.find((e) => e.type === 'job_customer_refused')
    if (!refused) throw new Error('The fixtures refuse a quote')
    const late = {
      ...refused,
      refusal: { code: 'supplier.not_accepted', layer: 'supplier', block: null, index: null },
    } as const
    expect(jobEventSentence(late)).toMatch(
      /^Your business didn't accept the customer's reserve in time\./,
    )
    expect(parseSessionEvent(JSON.parse(JSON.stringify(toWire(late))))).toMatchObject({ ok: true })
  })

  it('give what the customer says it verified as the customer’s statement, at its block', () => {
    const verified = JOB_EVENTS.find((e) => e.type === 'job_customer_verified')
    if (!verified) throw new Error('The fixtures verify the compute')
    expect(jobEventSentence(verified)).toBe(
      `Avow's test customer says it verified your compute booking at block ${READ_BLOCK.number}.`,
    )
  })

  it('say plainly what is simulated wherever the work appears', () => {
    expect(SIMULATED_LINE).toBe(
      'The GPUs and the training are simulated. Every commitment, reserve, check and payment is a real testnet operation.',
    )
    expect(SIMULATED_RESULT_LABEL).toMatch(/^Simulated/)
  })

  it('say what the customer’s reserve backs, with each cap, and that it never secures the price', () => {
    expect(reserveLine(charges)).toBe(
      "The customer's reserve backs what the job's terms let you charge if the customer walks away. That's a late cancellation after work has started, up to $10, or a no-show, up to $6, if the customer doesn't hand over the work's inputs in time. The job's price arrives as a separate transfer on delivery, and the reserve doesn't secure it.",
    )
  })

  it('name the reason and the block of a refusal', () => {
    const refused = JOB_EVENTS.find((e) => e.type === 'job_customer_refused')
    if (refused?.type !== 'job_customer_refused') throw new Error('The fixtures refuse a quote')
    const sentence = jobEventSentence(refused)
    expect(sentence).toContain(describeReason('dependency.cancellable'))
    expect(sentence).toContain(`at block ${READ_BLOCK.number}`)
  })

  it('give every event a sentence that keeps to the product’s words', () => {
    for (const line of everything) {
      expect(line.length).toBeGreaterThan(20)
      expect(line).not.toMatch(/—|–/)
      expect(line).not.toMatch(/\b(bond|coverage|premium|claim|guarantee)/i)
      expect(line).not.toMatch(/payment reserved|reserved payment/i)
    }
  })
})
