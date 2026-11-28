import { describe, expect, it } from 'vitest'
import { demoTerms, dollars, testnetDemoJobTerms, testnetDemoTerms } from './demo.js'
import { termsPrice } from './price.js'
import { type ServiceOfferVersion, serviceOfferTerms } from './service.js'
import { demoTermsV1 } from './terms-v1.js'
import { ARBITER, NOW, quotedJobTerms, START } from './test-helpers.js'

const HOUR = 3600n

describe('termsPrice', () => {
  it("reads a GPU reservation's price as its rate for every GPU over the whole window", () => {
    // Eight H100s at $3 a GPU-hour, for a day and for half an hour.
    expect(termsPrice(demoTerms(START, ARBITER))).toBe(dollars(576))
    expect(termsPrice(testnetDemoTerms(START, ARBITER))).toBe(dollars(12))
  })

  it('rounds a GPU reservation down to a whole micro, as an offer quotes it', () => {
    const terms = testnetDemoTerms(START, ARBITER)
    const odd = { ...terms, subject: { ...terms.subject, windowDuration: 1n } }
    // 8 GPUs at 3,000,000 micros an hour for one second is 6,666.67 micros.
    expect(termsPrice(odd)).toBe(6_666n)
  })

  it('reads version 1 terms as the GPU reservation they are', () => {
    expect(termsPrice(demoTermsV1(START, ARBITER))).toBe(dollars(576))
  })

  it("reads a job's one fixed price, plain or naming the compute it runs on", () => {
    expect(termsPrice(testnetDemoJobTerms(START, ARBITER))).toBe(dollars(40))
    expect(termsPrice(quotedJobTerms())).toBe(dollars(40))
  })

  it("reads a service's price per unit times the units booked", () => {
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
    const settlement = { arbiter: ARBITER, day90SupplierShareBps: 5_000 }
    expect(termsPrice(serviceOfferTerms(version, 3, NOW, settlement))).toBe(dollars(150))
  })
})
