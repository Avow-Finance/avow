import { dollars, offerVersionId, toWire } from '@avow-finance/spec'
import { describe, expect, it } from 'vitest'
import {
  bookingSentence,
  offerSentences,
  readOfferInput,
  readPublishArgs,
  readServiceOrderArgs,
  readSharedOffer,
} from './services.js'

const asked = {
  name: ' Transcript ',
  summary: 'One hour of audio transcribed into English text',
  price: 50,
  evidence: 'The transcript is delivered to the buyer as a text file',
  late_cancellation_percent: 20,
  no_show_percent: 50,
}

describe("an offer's inputs", () => {
  it('turn dollars, percentages, hours and days into the draft the template takes', () => {
    const draft = readOfferInput({ ...asked, free_cancel_hours: 2, max_per_booking: 10 })
    if ('error' in draft) throw new Error(draft.error)
    expect(draft).toEqual({
      item: { name: 'Transcript', summary: asked.summary },
      currency: 'USD',
      unitPrice: dollars(50),
      rules: {
        evidence: asked.evidence,
        leadTime: 86_400n,
        maxPerBooking: 10,
        dailyCapacity: 10,
        freeCancelWindow: 7_200n,
        lateCancellationBps: 2_000,
        noShowBps: 5_000,
        payment: { route: 'transfer', dueAfterDelivery: 604_800n },
      },
    })
  })

  it('ask for both charges, which set the reserve, and never assume one', () => {
    const { no_show_percent: _, ...oneCharge } = asked
    expect(readOfferInput(oneCharge)).toMatchObject({ error: expect.stringMatching(/both/) })
    expect(readOfferInput({ ...asked, no_show_percent: 120 })).toHaveProperty('error')
    expect(readOfferInput({ ...asked, price: 0 })).toHaveProperty('error')
    expect(readOfferInput({ ...asked, payment: 'card' })).toHaveProperty('error')
    expect(readOfferInput({ ...asked, lead_hours: '24' })).toHaveProperty('error')
  })

  it('refuse a number the folder could never read back, or one that would be rounded', () => {
    // Each of the first four once published and then made the folder's services file unreadable.
    expect(readOfferInput({ ...asked, lead_hours: 1e17 })).toHaveProperty('error')
    expect(readOfferInput({ ...asked, price: 1e80 })).toHaveProperty('error')
    expect(readOfferInput({ ...asked, price: 1e305 })).toHaveProperty('error')
    expect(readOfferInput({ ...asked, payment_due_days: 1e9 })).toHaveProperty('error')
    expect(readOfferInput({ ...asked, late_cancellation_percent: 12.345 })).toHaveProperty('error')
    expect(readOfferInput({ ...asked, price: 0.0000001 })).toHaveProperty('error')
    expect(readOfferInput({ ...asked, max_per_booking: 1.5 })).toHaveProperty('error')
    expect(readOfferInput({ ...asked, per_day: 0 })).toHaveProperty('error')
    // Halves and cents are exact, so they pass.
    expect(
      readOfferInput({ ...asked, price: 12.5, no_show_percent: 12.5, lead_hours: 0.5 }),
    ).toMatchObject({ unitPrice: 12_500_000n, rules: { noShowBps: 1_250, leadTime: 1_800n } })
  })

  it('read from the flags of offer publish', () => {
    expect(
      readPublishArgs(['--name', 'Transcript', '--price', '12.5', '--no-show', '50', '--max', '4']),
    ).toEqual({ name: 'Transcript', price: 12.5, no_show_percent: 50, max_per_booking: 4 })
    expect(readPublishArgs(['--price', 'fifty'])).toEqual({ error: '--price takes a number' })
    expect(readPublishArgs(['--name'])).toEqual({ error: '--name needs a value' })
    expect(readPublishArgs(['--supplier', 'x'])).toHaveProperty('error')
    expect(readPublishArgs(['toString', 'x'])).toHaveProperty('error')
  })
})

describe('an offer in words', () => {
  const draft = readOfferInput({ ...asked, free_cancel_hours: 2, max_per_booking: 10 })
  if ('error' in draft) throw new Error(draft.error)
  const offer = { ...draft, supplier: 'sandbox-seller' }

  it('says every rule that sets what a booking costs and reserves', () => {
    const words = offerSentences(offer).join(' ')
    expect(words).toContain('Transcript from sandbox-seller.')
    expect(words).toContain('$50 a unit, up to 10 units a booking, delivered within 1 day')
    expect(words).toContain('20% for cancelling late and 50% for not being there to take delivery')
    expect(words).toContain("the reserve doesn't secure it")
    expect(words).toContain('Cancelling is free for 2 hours after booking.')
    // The words Avow keeps out of product text.
    expect(words).not.toMatch(/bond|coverage|premium|guarantee|escrow|\bclaim/i)
    expect(bookingSentence(offer, 2)).toBe(
      '2 units of Transcript from sandbox-seller costs $100 and reserves $50.',
    )
  })

  it('reads back from what its supplier shared, as an object or as text, and nothing else', () => {
    const shared = toWire(offer)
    expect(offerVersionId(readSharedOffer(shared) ?? offer)).toBe(offerVersionId(offer))
    expect(readSharedOffer(JSON.stringify(shared))).toEqual(offer)
    expect(readSharedOffer('{')).toBeNull()
    expect(readSharedOffer({ ...(shared as object), unitPrice: '0' })).toBeNull()
    expect(readSharedOffer(undefined)).toBeNull()
  })
})

describe('order --offer', () => {
  it('takes the offer file and a whole quantity', () => {
    expect(readServiceOrderArgs(['--offer', 'transcript.offer.json'])).toEqual({
      offer: 'transcript.offer.json',
      quantity: 1,
      expiresIn: null,
    })
    expect(readServiceOrderArgs(['--offer', 'a.json', '--quantity', '3'])).toMatchObject({
      quantity: 3,
    })
    expect(readServiceOrderArgs(['--offer', 'a.json', '--quantity', '1.5'])).toHaveProperty('error')
    expect(readServiceOrderArgs(['--offer', 'a.json', '--supplier', 'x'])).toHaveProperty('error')
    expect(readServiceOrderArgs(['--quantity', '2'])).toHaveProperty('error')
  })
})
