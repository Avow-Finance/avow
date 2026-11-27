import { dollars, offerVersionId, toWire } from '@avow-finance/spec'
import { describe, expect, it } from 'vitest'
import type { SellAskOutcome } from '../sandbox/services.js'
import {
  type AskToSellDeps,
  askToSellCommand,
  bookingSentence,
  offerSentences,
  readAskToSellArgs,
  readOfferInput,
  readPublishArgs,
  readServiceOrderArgs,
  readSharedOffer,
  readTermsText,
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

describe('avow-sandbox ask-to-sell', () => {
  const TERMS = {
    signingKey: `0x${'5e'.repeat(20)}`,
    currency: 'USD',
    limits: [
      {
        category: 'service',
        item: null,
        minUnitPrice: '40000000',
        maxUnitsPerOrder: 4,
        maxUnitsPerDay: 10,
      },
    ],
    maxOrderValue: '500000000',
    maxOutstanding: '2000000000',
    maxDeliveryHorizon: '604800',
    minLateCancellationBps: 2000,
    minNoShowBps: 5000,
    maxFreeCancelWindow: '86400',
    buyers: [],
    excludedBuyers: [],
    excludedCountries: [],
    requiresBusinessCheck: false,
    negotiable: [],
    approvalRule: { kind: 'never' },
    expiry: '1900000000',
  }
  const request = (state: string) => ({
    id: 'ab'.repeat(16),
    status: state === 'active' ? { state, at: 1n, transaction: null } : { state },
  })

  /** Runs the command with what it reads and asks replaced, and answers with what it said. */
  async function run(
    args: string[],
    o: {
      file?: string | null | undefined
      outcome?: SellAskOutcome
      states?: string[]
    } = {},
  ) {
    const said: string[] = []
    const failed: string[] = []
    let asked = 0
    const states = [...(o.states ?? ['waiting', 'active'])]
    const deps: AskToSellDeps = {
      readFile: () => {
        if (o.file === null) throw new Error('no such file')
        return o.file ?? JSON.stringify(TERMS)
      },
      log: (line) => said.push(line),
      fail: (message) => {
        failed.push(message)
      },
      signal: new AbortController().signal,
      services: async () => ({
        askToSell: async () => {
          asked++
          return (o.outcome ?? {
            ok: true,
            asked: { request: request('waiting'), link: 'https://avow.example/a/ab' },
          }) as never
        },
        awaitSellRequest: async (_id, w) => {
          let last = request('waiting')
          for (const state of states) {
            last = request(state)
            w?.onRead?.({ request: last, link: '' } as never)
          }
          return { request: last, link: '' } as never
        },
      }),
    }
    await askToSellCommand(args, deps)
    return { said, failed, asked }
  }

  it('reads one --terms file and nothing else', () => {
    expect(readAskToSellArgs(['--terms', 'terms.json'])).toEqual({ file: 'terms.json' })
    expect(readAskToSellArgs([])).toHaveProperty('error')
    expect(readAskToSellArgs(['--terms'])).toHaveProperty('error')
    expect(readAskToSellArgs(['--terms', '--wait'])).toHaveProperty('error')
    expect(readAskToSellArgs(['--terms', 'terms.json', '--wait'])).toHaveProperty('error')
    expect(readAskToSellArgs(['terms.json'])).toHaveProperty('error')
  })

  it('reads the terms as the spec writes them, and says which way a file is wrong', () => {
    expect(readTermsText('t.json', JSON.stringify(TERMS))).toHaveProperty('terms')
    expect(readTermsText('t.json', '{ not json')).toEqual({ error: "t.json doesn't hold JSON" })
    expect(readTermsText('t.json', JSON.stringify({ ...TERMS, maxOrderValue: 500 }))).toEqual({
      error: expect.stringMatching(/doesn't hold a seller's mandate's terms/),
    })
  })

  it('asks for nothing when its arguments or its file are wrong', async () => {
    for (const [args, file, said] of [
      [[], undefined, /takes --terms/],
      [['--terms', 't.json', '--now'], undefined, /takes --terms/],
      [['--terms', 't.json'], null, /can't be read/],
      [['--terms', 't.json'], '{ not json', /doesn't hold JSON/],
      [['--terms', 't.json'], '{}', /doesn't hold a seller's mandate's terms/],
    ] as const) {
      const r = await run([...args], { file })
      expect(r.failed, JSON.stringify(args)).toEqual([expect.stringMatching(said)])
      expect(r.asked).toBe(0)
    }
  })

  it("says plainly that Avow doesn't take the ask yet, and waits for nothing", async () => {
    const notice = "Avow doesn't take seller's mandate requests yet, so nothing was asked."
    const r = await run(['--terms', 't.json'], {
      outcome: { ok: false, reason: 'approval_request.kind_unavailable', notice },
    })
    expect(r.said).toEqual([notice])
    expect(r.failed).toEqual([])
  })

  it('prints the link, then each state the request moves to, until it is in force', async () => {
    const r = await run(['--terms', 't.json'], {
      states: ['waiting', 'waiting', 'approved', 'active'],
    })
    expect(r.said[0]).toMatch(/request ab/)
    expect(r.said[1]).toContain('https://avow.example/a/ab')
    expect(r.said.filter((l) => l.startsWith('The request is'))).toEqual([
      'The request is waiting.',
      'The request is approved.',
      'The request is active.',
    ])
    expect(r.said.at(-1)).toMatch(/in force/)
    expect(r.said.at(-1)).toMatch(/Avow doesn't enforce seller limits yet/)
  })
})
