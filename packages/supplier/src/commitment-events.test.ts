import {
  type CommitmentEvent,
  commitmentEvent,
  commitmentEventHash,
  commitmentEventProblem,
  commitmentEventSlot,
  commitmentEventStatementHash,
  parseCommitmentEvent,
  sameSlot,
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
 * The adapter's four webhook events, written as the spec's commitment events. The adapter doesn't
 * send commitment events yet. This pins what the move would keep, what it would carry another way
 * and what it would leave out, field by field.
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
 * What becomes of each field of a webhook event in a commitment event. `kept` fields read back
 * exactly. A field the adapter adds to its events has to be placed here before this compiles.
 */
const FIELDS = {
  id: { fate: 'derived', as: 'the slot, from the code and the commitment, and never carried' },
  type: { fate: 'kept', as: 'code' },
  createdAt: { fate: 'kept_to_the_second', as: 'at, with the source supplier' },
  commitmentId: { fate: 'kept', as: 'commitment.commitmentId' },
  chainId: { fate: 'kept', as: 'commitment.chainId' },
  lock: { fate: 'kept', as: 'commitment.lock, in lower case' },
  buyerBusinessId: { fate: 'left_out', as: 'nothing, since an event names no business' },
  supplierBusinessId: { fate: 'left_out', as: 'nothing, since an event names no business' },
  reserveDollars: { fate: 'kept', as: 'reserve, in micros' },
  agreementExpiresAt: { fate: 'kept', as: 'agreementExpiry, in unix seconds' },
  acceptanceTransaction: { fate: 'kept', as: 'acceptedIn, on reserve.accepted' },
  terms: {
    fate: 'by_hash',
    as: 'termsHash, which the booking holds and the webhook event does not',
  },
} as const satisfies Record<
  keyof BookingEventData | Exclude<keyof WebhookEvent, 'data'>,
  { fate: 'kept' | 'kept_to_the_second' | 'derived' | 'by_hash' | 'left_out'; as: string }
>
type Kept = {
  [K in keyof typeof FIELDS]: (typeof FIELDS)[K]['fate'] extends 'kept' | 'kept_to_the_second'
    ? K
    : never
}[keyof typeof FIELDS]

/**
 * A webhook event as a commitment event. The terms hash comes from the booking's agreement, since
 * the webhook event carries the terms and no salt to hash them with.
 */
function asCommitmentEvent(e: WebhookEvent, hashOfTerms: Hex): CommitmentEvent {
  const stated = {
    commitment: {
      chainId: e.data.chainId,
      lock: e.data.lock.toLowerCase() as Address,
      commitmentId: e.data.commitmentId,
    },
    termsHash: hashOfTerms,
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

const CODES = ['booking.agreed', 'reserve.held', 'reserve.accepted', 'booking.lapsed'] as const

/** The fields of a webhook event that a supplier's commitment event gives back. */
function keptFields(c: CommitmentEvent): Pick<WebhookEvent & BookingEventData, Kept> {
  const code = CODES.find((known) => known === c.code)
  if (c.source !== 'supplier' || !code) {
    throw new Error(`${c.code} by ${c.source} is none of the adapter's events`)
  }
  return {
    type: code,
    createdAt: iso(c.at),
    commitmentId: c.commitment.commitmentId,
    chainId: c.commitment.chainId,
    lock: c.commitment.lock,
    reserveDollars: dollars(c.reserve, TERMS_DECIMALS),
    agreementExpiresAt: iso(c.agreementExpiry),
    acceptanceTransaction: c.code === 'reserve.accepted' ? c.acceptedIn : null,
  }
}
const fated = (...fates: string[]) =>
  (Object.keys(FIELDS) as (keyof typeof FIELDS)[]).filter((k) => fates.includes(FIELDS[k].fate))

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
    expect(new Set(codes)).toEqual(new Set(CODES))
  })

  it('places every field of a webhook event, as kept, derived, by hash or left out', () => {
    for (const b of bookings) {
      const { data, ...envelope } = webhookEvent(b)
      expect([...Object.keys(envelope), ...Object.keys(data)].sort()).toEqual(
        Object.keys(FIELDS).sort(),
      )
    }
    expect(fated('left_out')).toEqual(['buyerBusinessId', 'supplierBusinessId'])
    expect(fated('by_hash')).toEqual(['terms'])
    expect(fated('derived')).toEqual(['id'])
  })

  it('reads back exactly the fields it keeps, and no other', () => {
    for (const b of bookings) {
      const sent = webhookEvent(b)
      const back = keptFields(asCommitmentEvent(sent, b.agreement.termsHash))
      expect(Object.keys(back).sort(), sent.type).toEqual(
        fated('kept', 'kept_to_the_second').sort(),
      )
      const flat: Record<string, unknown> = { ...sent, ...sent.data }
      for (const [name, value] of Object.entries(back)) {
        expect(value, `${sent.type} ${name}`).toEqual(flat[name])
      }
    }
  })

  it('names no business, so neither business id comes back', () => {
    for (const b of bookings) {
      const sent = webhookEvent(b)
      const event = asCommitmentEvent(sent, b.agreement.termsHash)
      const wire = JSON.stringify(toWire(event))
      expect(wire).not.toContain(sent.data.buyerBusinessId)
      expect(wire).not.toContain(sent.data.supplierBusinessId)
      expect(wire).not.toMatch(/business/i)
    }
  })

  it('carries the terms by hash, which the booking supplies and the webhook event cannot', () => {
    for (const b of bookings) {
      const sent = webhookEvent(b)
      const event = asCommitmentEvent(sent, b.agreement.termsHash)
      if (event.code === 'reserve.owed_paid') throw new Error('never an adapter event')
      // The hash is the one both sides signed, and whoever holds the terms and salt can check it.
      expect(event.termsHash).toBe(b.agreement.termsHash)
      expect(termsHash(b.terms, b.salt)).toBe(event.termsHash)
      // The terms themselves stay out, and the webhook event holds no salt to hash them with.
      expect(Object.keys(event)).not.toContain('terms')
      expect(JSON.stringify(sent)).not.toContain(b.salt.slice(2))
    }
  })

  it('gives one status of one booking one slot, as the webhook id does, and one statement however often it is recorded', () => {
    const [agreed, held] = bookings as [Booking, Booking]
    const first = asCommitmentEvent(webhookEvent(agreed), agreed.agreement.termsHash)
    const again = asCommitmentEvent(webhookEvent(agreed), agreed.agreement.termsHash)
    const later = asCommitmentEvent(webhookEvent(agreed, T0 + 60_000), agreed.agreement.termsHash)
    const next = asCommitmentEvent(webhookEvent(held), held.agreement.termsHash)
    expect(webhookEvent(agreed, T0 + 60_000).id).toBe(webhookEvent(agreed).id)
    expect(commitmentEventSlot(later)).toBe(commitmentEventSlot(first))
    expect(commitmentEventSlot(next)).not.toBe(commitmentEventSlot(first))
    // The same event sent twice is a repeat. Recorded again a minute later, as the adapter does
    // after a restart, it is another event and the same statement, so still a repeat, and the
    // receiver keeps the earlier time.
    expect(commitmentEventHash(again)).toBe(commitmentEventHash(first))
    expect(sameSlot(first, again)).toBe('repeat')
    expect(commitmentEventHash(later)).not.toBe(commitmentEventHash(first))
    expect(commitmentEventStatementHash(later)).toBe(commitmentEventStatementHash(first))
    expect(sameSlot(first, later)).toBe('repeat')
    expect(sameSlot(later, first)).toBe('earlier_repeat')
  })

  it('keeps the time to the second, so the milliseconds of a webhook event are lost', () => {
    const [agreed] = bookings as [Booking]
    const sent = webhookEvent(agreed, T0 + 250)
    const event = asCommitmentEvent(sent, agreed.agreement.termsHash)
    expect(event.at).toBe(BigInt(T0 / 1000))
    expect(sent.createdAt).toBe(new Date(T0 + 250).toISOString())
    expect(keptFields(event).createdAt).toBe(new Date(T0).toISOString())
  })

  it('writes a lapse the same whether or not a reserve had come, as the adapter records it', () => {
    // The adapter lapses an agreed booking and a held one alike at the acceptance deadline. A held
    // booking's reserve is still on the lock then. The record keeps no trace of which it was, so
    // the event says the booking ended unaccepted and nothing about a reserve.
    const lapses = (['agreed', 'held'] as const).map((was) => {
      const { status: _status, sent: _sent, ...record } = withStatus(was)
      const b: Booking = { ...record, status: 'lapsed' }
      return asCommitmentEvent(webhookEvent(b), b.agreement.termsHash)
    })
    const [noReserve, withReserve] = lapses as [CommitmentEvent, CommitmentEvent]
    expect(noReserve.code).toBe('booking.lapsed')
    expect(withReserve).toEqual(noReserve)
    expect(Object.keys(noReserve).filter((name) => /reserved|funded|held/i.test(name))).toEqual([])
  })
})
