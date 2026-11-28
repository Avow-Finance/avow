import type { Hex } from 'viem'
import { describe, expect, it } from 'vitest'
import { API_PATH_PATTERN } from './api-request.js'
import { dollars } from './demo.js'
import {
  OFFER_LISTINGS_MAX,
  type OfferListing,
  parseOfferListing,
  parseOfferListingRequest,
  parseOfferListings,
  parseOfferListingsRequest,
  parseOfferWithdrawal,
  parseOfferWithdrawalRequest,
} from './offer-listing.js'
import { REASON_CODES } from './reasons.js'
import { SANDBOX_PATHS } from './sandbox.js'
import { offerVersionId, type ServiceOfferVersion } from './service.js'
import { NOW } from './test-helpers.js'
import { toWire } from './wire.js'

const HOUR = 3600n
const MANDATE: Hex = `0x${'ab'.repeat(32)}`

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
const named = (name: string, unitPrice = transcript.unitPrice): ServiceOfferVersion => ({
  ...transcript,
  item: { ...transcript.item, name },
  unitPrice,
})

const listingOf = (version: ServiceOfferVersion, replaced: Hex | null = null): OfferListing => ({
  id: offerVersionId(version),
  version,
  listedAt: NOW,
  sellerMandate: MANDATE,
  replaced,
})
const wire = (v: unknown) => JSON.parse(JSON.stringify(toWire(v)))

describe('the listing paths', () => {
  it('are sandbox paths a signed request can name', () => {
    const paths = [
      SANDBOX_PATHS.offerListings,
      SANDBOX_PATHS.offerListingsMine,
      SANDBOX_PATHS.offerWithdrawals,
    ]
    expect(paths).toEqual([
      '/v1/sandbox/offers/listings',
      '/v1/sandbox/offers/listings/mine',
      '/v1/sandbox/offers/withdrawals',
    ])
    for (const p of paths) expect(API_PATH_PATTERN.test(p)).toBe(true)
  })

  it('name every refusal they give as a reason code', () => {
    for (const reason of [
      'offer.unknown',
      'offer.listing_unavailable',
      'offer.listings_full',
      'offer.superseded',
      'offer.withdrawn',
    ]) {
      expect(REASON_CODES).toHaveProperty([reason])
    }
  })
})

describe('a listing request', () => {
  it('reads a version that round-trips as JSON', () => {
    const read = parseOfferListingRequest(wire({ version: transcript }))
    expect(read).toEqual({ ok: true, value: { version: transcript } })
  })

  it('refuses a version the offer rules refuse, an extra field, or no version', () => {
    const free = { ...transcript, unitPrice: 0n }
    expect(parseOfferListingRequest(wire({ version: free }))).toEqual({
      ok: false,
      reason: 'message.invalid',
    })
    expect(parseOfferListingRequest(wire({ version: transcript, replaces: null })).ok).toBe(false)
    expect(parseOfferListingRequest({}).ok).toBe(false)
    expect(parseOfferListingRequest(null).ok).toBe(false)
  })

  it('never throws, whatever it is given', () => {
    const hostile = {
      get version() {
        throw new Error('boom')
      },
    }
    expect(parseOfferListingRequest(hostile)).toEqual({ ok: false, reason: 'message.invalid' })
  })
})

describe('a withdrawal request and a read of listings', () => {
  it('reads an id in either case, in lower case', () => {
    const id = offerVersionId(transcript)
    expect(parseOfferWithdrawalRequest({ id: id.toUpperCase().replace('0X', '0x') })).toEqual({
      ok: true,
      value: { id },
    })
  })

  it('refuses an id that is no hash, and anything but an empty object for a read', () => {
    expect(parseOfferWithdrawalRequest({ id: '0x12' }).ok).toBe(false)
    expect(parseOfferWithdrawalRequest({ id: offerVersionId(transcript), why: 'x' }).ok).toBe(false)
    expect(parseOfferListingsRequest({})).toEqual({ ok: true, value: {} })
    expect(parseOfferListingsRequest({ all: true }).ok).toBe(false)
  })
})

describe("Avow's answers", () => {
  it('read a listing whose id is its version, with the version it replaced', () => {
    const older = offerVersionId(named('Transcript', dollars(40)))
    const listing = listingOf(transcript, older)
    expect(parseOfferListing(wire(listing))).toEqual({ ok: true, value: listing })
  })

  it("refuse a listing whose id isn't its version's, or that replaced itself", () => {
    const wrong = { ...listingOf(transcript), id: offerVersionId(named('Captions')) }
    expect(parseOfferListing(wire(wrong)).ok).toBe(false)
    const itself = listingOf(transcript, offerVersionId(transcript))
    expect(parseOfferListing(wire(itself)).ok).toBe(false)
  })

  it('read a withdrawal', () => {
    const withdrawal = { id: offerVersionId(transcript), withdrawnAt: NOW }
    expect(parseOfferWithdrawal(wire(withdrawal))).toEqual({ ok: true, value: withdrawal })
    expect(parseOfferWithdrawal(wire({ ...withdrawal, by: 'x' })).ok).toBe(false)
  })

  it('read listings with one current version for each item', () => {
    const listed = [listingOf(transcript), listingOf(named('Captions'))]
    expect(parseOfferListings(wire({ listed }))).toEqual({ ok: true, value: { listed } })
    expect(parseOfferListings({ listed: [] })).toEqual({ ok: true, value: { listed: [] } })
  })

  it('refuse two versions of one item, the same version twice, or more than a business keeps', () => {
    const twoOfOne = [listingOf(transcript), listingOf(named('Transcript', dollars(60)))]
    expect(parseOfferListings(wire({ listed: twoOfOne })).ok).toBe(false)
    const twice = [listingOf(transcript), listingOf(transcript)]
    expect(parseOfferListings(wire({ listed: twice })).ok).toBe(false)
    const many = Array.from({ length: OFFER_LISTINGS_MAX + 1 }, (_, i) =>
      listingOf(named(`Item ${i}`)),
    )
    expect(parseOfferListings(wire({ listed: many })).ok).toBe(false)
    expect(parseOfferListings(wire({ listed: many.slice(1) })).ok).toBe(true)
  })
})
