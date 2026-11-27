import {
  type CommitmentEvent,
  type CommitmentReference,
  commitmentEvent,
  commitmentEventProblem,
  parseCommitmentEvent,
  type Terms,
  termsHash,
  toWire,
} from '@avow-finance/spec'
import type { Address, Hex } from 'viem'
import { parseUnits } from 'viem'
import { describe, expect, it } from 'vitest'
import { dollars, iso, TERMS_DECIMALS } from './format.js'
import type { Booking } from './store.js'
import { agreedBooking } from './test/fixtures.js'
import { type BookingEventData, bookingEvent, type WebhookEvent } from './webhook.js'

/*
 * The adapter's four webhook events, written as the spec's commitment events and read back. The
 * adapter doesn't send commitment events yet. This pins that it can, so the move loses nothing a
 * receiver gets today.
 */

const T0 = Date.parse('2027-01-04T09:00:00Z')
const TX: Hex = `0x${'ab'.repeat(32)}`
const seconds = (isoTime: string) => BigInt(Math.floor(Date.parse(isoTime) / 1000))

const withStatus = (status: 'agreed' | 'held' | 'lapsed'): Booking => {
  const { sent: _sent, status: _status, ...record } = agreedBooking()
  return { ...record, status }
}
const accepted = (sent?: { hash: Hex; validBefore: null }): Booking => {
  const { sent: _sent, status: _status, ...record } = agreedBooking()
  return sent ? { ...record, status: 'accepted', sent } : { ...record, status: 'accepted' }
}
const bookings: Booking[] = [
  withStatus('agreed'),
  withStatus('held'),
  accepted({ hash: TX, validBefore: null }),
  accepted(),
  withStatus('lapsed'),
]
const webhookEvent = (b: Booking, ms = T0) => bookingEvent(b, new Date(ms)) as WebhookEvent

/**
 * Where each field of a webhook event goes in a commitment event. A field the adapter adds to its
 * events has to be given a home here before this compiles.
 */
const HOME = {
  id: 'the code and commitment.commitmentId, which the webhook id is made from',
  type: 'code',
  createdAt: 'at, with the source supplier, in whole seconds',
  commitmentId: 'commitment.commitmentId',
  chainId: 'commitment.chainId',
  lock: 'commitment.lock',
  buyerBusinessId: 'buyerBusinessId',
  supplierBusinessId: 'supplierBusinessId',
  reserveDollars: 'reserve, in micros',
  agreementExpiresAt: 'agreementExpiry, in unix seconds',
  acceptanceTransaction: 'acceptedIn, on reserve.accepted',
  terms: 'commitment.termsHash, which names the terms the event leaves out',
} as const satisfies Record<keyof BookingEventData | Exclude<keyof WebhookEvent, 'data'>, string>

/** A webhook event as a commitment event, with the terms hash from the agreement it was made for. */
function asCommitmentEvent(e: WebhookEvent, hashOfTerms: Hex): CommitmentEvent {
  const commitment: CommitmentReference = {
    kind: 'commitment',
    chainId: e.data.chainId,
    lock: e.data.lock.toLowerCase() as Address,
    commitmentId: e.data.commitmentId,
    // The adapter books the buyer's side, the only side a lock reserves.
    side: 'buyer',
    termsHash: hashOfTerms,
  }
  const stated = {
    commitment,
    buyerBusinessId: e.data.buyerBusinessId,
    supplierBusinessId: e.data.supplierBusinessId,
    reserve: parseUnits(e.data.reserveDollars, TERMS_DECIMALS),
    source: 'supplier',
    at: seconds(e.createdAt),
    agreementExpiry: seconds(e.data.agreementExpiresAt),
  } as const
  switch (e.type) {
    case 'booking.agreed':
      return commitmentEvent({ ...stated, code: e.type })
    case 'reserve.held':
      return commitmentEvent({ ...stated, code: e.type })
    case 'reserve.accepted':
      return commitmentEvent({ ...stated, code: e.type, acceptedIn: e.data.acceptanceTransaction })
    case 'booking.lapsed':
      return commitmentEvent({ ...stated, code: e.type })
  }
}

const STATUS = {
  'booking.agreed': 'agreed',
  'reserve.held': 'held',
  'reserve.accepted': 'accepted',
  'booking.lapsed': 'lapsed',
} as const

/** The webhook event a supplier's commitment event stands for, with the terms its hash names. */
function asWebhookEvent(c: CommitmentEvent, terms: Terms): WebhookEvent {
  if (c.source !== 'supplier' || !Object.hasOwn(STATUS, c.code)) {
    throw new Error(`${c.code} by ${c.source} is none of the adapter's events`)
  }
  return {
    id: `msg_${c.commitment.commitmentId.slice(2)}_${STATUS[c.code]}`,
    type: c.code,
    createdAt: iso(c.at),
    data: {
      commitmentId: c.commitment.commitmentId,
      chainId: c.commitment.chainId,
      lock: c.commitment.lock,
      buyerBusinessId: c.buyerBusinessId,
      supplierBusinessId: c.supplierBusinessId,
      reserveDollars: dollars(c.reserve, TERMS_DECIMALS),
      agreementExpiresAt: iso(c.agreementExpiry),
      acceptanceTransaction: c.code === 'reserve.accepted' ? c.acceptedIn : null,
      terms: toWire(terms),
    },
  }
}

describe("the adapter's webhook events as commitment events", () => {
  it('writes each of the four as one well-formed commitment event of the same code', () => {
    const codes = bookings.map((b) => {
      const sent = webhookEvent(b)
      const event = asCommitmentEvent(sent, b.agreement.termsHash)
      expect(commitmentEventProblem(event), sent.type).toBeNull()
      expect(event.source).toBe('supplier')
      expect(parseCommitmentEvent(JSON.parse(JSON.stringify(toWire(event))))).toEqual({
        ok: true,
        value: event,
      })
      expect(event.code).toBe(sent.type)
      return event.code
    })
    expect(new Set(codes)).toEqual(new Set(Object.keys(STATUS)))
  })

  it('reads each one back with every field the adapter sent', () => {
    for (const b of bookings) {
      const sent = webhookEvent(b)
      const event = asCommitmentEvent(sent, b.agreement.termsHash)
      expect(asWebhookEvent(event, b.terms), sent.type).toEqual(sent)
    }
  })

  it('gives every field of a webhook event a home', () => {
    for (const b of bookings) {
      const { data, ...envelope } = webhookEvent(b)
      expect([...Object.keys(envelope), ...Object.keys(data)].sort()).toEqual(
        Object.keys(HOME).sort(),
      )
    }
  })

  it('names the terms by their hash and leaves their words out', () => {
    for (const b of bookings) {
      const event = asCommitmentEvent(webhookEvent(b), b.agreement.termsHash)
      // Whoever holds the booking's terms and salt can check they are the terms the event names.
      expect(termsHash(b.terms, b.salt)).toBe(event.commitment.termsHash)
      expect(Object.keys(event)).not.toContain('terms')
    }
  })

  it('keeps one id for one status of one booking, as the webhook id does', () => {
    const [agreed, held] = bookings as [Booking, Booking]
    const first = asCommitmentEvent(webhookEvent(agreed), agreed.agreement.termsHash)
    const again = asCommitmentEvent(webhookEvent(agreed, T0 + 60_000), agreed.agreement.termsHash)
    expect(again.id).toBe(first.id)
    expect(asCommitmentEvent(webhookEvent(held), held.agreement.termsHash).id).not.toBe(first.id)
  })

  it('keeps the time to the second, which is as fine as a commitment event states one', () => {
    const [agreed] = bookings as [Booking]
    const event = asCommitmentEvent(webhookEvent(agreed, T0 + 250), agreed.agreement.termsHash)
    expect(event.at).toBe(BigInt(T0 / 1000))
    expect(asWebhookEvent(event, agreed.terms).createdAt).toBe(new Date(T0).toISOString())
  })
})
