import { describe, expect, it } from 'vitest'
import { dollars } from './demo.js'
import {
  AFTER_ACCEPTANCE,
  CHECK_BOUNDARY,
  COMPUTE_PROVES,
  DECISIVE_SENTENCE,
  jobEventSentence,
  REFUSAL_CHALLENGE,
  REFUSAL_INSTRUCTION,
  reserveLine,
  SEPARATE_RESERVES,
} from './job-wording.js'
import { describeReason } from './reasons.js'
import { JOB_EVENTS, READ_BLOCK } from './test-helpers.js'

const charges = [
  { kind: 'lateCancellation', amount: dollars(10) },
  { kind: 'noShow', amount: dollars(6) },
] as const

const everything = [
  DECISIVE_SENTENCE,
  COMPUTE_PROVES,
  SEPARATE_RESERVES,
  CHECK_BOUNDARY,
  AFTER_ACCEPTANCE,
  REFUSAL_CHALLENGE,
  REFUSAL_INSTRUCTION,
  reserveLine(charges),
  ...JOB_EVENTS.map(jobEventSentence),
]

describe('the words a job’s terminal and screen share', () => {
  it('say the decisive moment exactly', () => {
    expect(DECISIVE_SENTENCE).toBe(
      "Your code verified the customer's commitment and checked its reserve. Work can now begin. The customer accepted after verifying your compute booking.",
    )
    const checked = JOB_EVENTS.find((e) => e.type === 'job_commitment_checked')
    if (!checked) throw new Error('The fixtures check a commitment')
    expect(jobEventSentence(checked)).toBe(DECISIVE_SENTENCE)
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
