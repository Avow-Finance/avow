import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { toWire } from '@avow-finance/spec'
import { type Hex, keccak256, stringToHex } from 'viem'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Booking, FiledReport, SentTransaction, SupplierStore } from './store.js'
import { agreedBooking, COMMITMENT, NOW, tempStore } from './test/fixtures.js'

let store: SupplierStore
let remove: () => void
beforeEach(() => {
  ;({ store, remove } = tempStore())
})
afterEach(() => remove())

const OTHER: Hex = `0x${'ee'.repeat(32)}`
const bookingFile = (id: Hex) => join(store.dir, 'bookings', `${id}.json`)
/** A booking's file as `put` writes it, with fields changed, for the files the store refuses. */
const writeBooking = (id: Hex, change: (json: Record<string, unknown>) => void) => {
  const json = toWire(agreedBooking()) as Record<string, unknown>
  change(json)
  writeFileSync(bookingFile(id), JSON.stringify(json))
}

describe("the supplier's state directory", () => {
  it('makes the keys once and reads them back, and refuses a key file that holds anything else', () => {
    expect(store.keys()).toBeNull()
    const keys = store.makeKeys()
    expect(store.keys()).toEqual(keys)
    writeFileSync(join(store.dir, 'keys.json'), JSON.stringify({ accountKey: keys.accountKey }))
    expect(() => store.keys()).toThrow("doesn't hold the supplier's two keys")
    expect(() => store.makeKeys()).toThrow("doesn't hold the supplier's two keys")
  })

  it('writes a booking as JSON and reads it back parsed, its terms, agreement and send included', () => {
    expect(store.booking(COMMITMENT)).toBeNull()
    const sent: SentTransaction = { hash: `0x${'ab'.repeat(32)}`, validBefore: NOW + 25n }
    const booking: Booking = { ...agreedBooking(), status: 'accepting', sent }
    store.put(booking)
    expect(store.booking(COMMITMENT)).toEqual(booking)
    store.put({ ...booking, sent: { ...sent, validBefore: null } })
    expect(store.booking(COMMITMENT)?.sent).toEqual({ ...sent, validBefore: null })
    expect(store.commitmentIds()).toEqual([COMMITMENT])
    expect(store.bookings()).toHaveLength(1)
  })

  it('keeps an acceptance transaction only on a booking that is accepting or accepted', () => {
    const sent: SentTransaction = { hash: `0x${'ab'.repeat(32)}`, validBefore: NOW + 25n }
    for (const status of ['accepting', 'accepted'] as const) {
      const booking: Booking = { ...agreedBooking(), status, sent }
      store.put(booking)
      expect(store.booking(COMMITMENT), status).toEqual(booking)
    }
    // @ts-expect-error A held booking never sends an acceptance, so it can't record one.
    store.put({ ...agreedBooking(), status: 'held', sent })
    for (const status of ['agreed', 'held', 'lapsed'] as const) {
      writeBooking(COMMITMENT, (j) => Object.assign(j, { status, sent: toWire(sent) }))
      expect(() => store.booking(COMMITMENT), status).toThrow(
        `${bookingFile(COMMITMENT)} holds an acceptance transaction, which a booking that's ${status} never has`,
      )
      expect(() => store.bookings(), status).toThrow('holds an acceptance transaction')
    }
  })

  it("refuses a booking file that doesn't hold what it should, saying which and why", () => {
    const broken: [(json: Record<string, unknown>) => void, string][] = [
      [(j) => Object.assign(j, { extra: true }), "doesn't hold a booking"],
      // The status a booking had before the supplier granted only after acceptance.
      [(j) => Object.assign(j, { status: 'granted' }), "doesn't hold a booking"],
      [(j) => Object.assign(j, { commitmentId: OTHER }), `holds the booking for ${OTHER}`],
      [
        (j) => Object.assign(j, { agreement: { nonce: 9 } }),
        "holds an agreement that doesn't parse",
      ],
      [
        (j) => Object.assign(j, { agreement: { ...(j.agreement as object), commitmentId: OTHER } }),
        'holds an agreement for another commitment',
      ],
      [
        (j) => Object.assign(j, { terms: { ...(j.terms as object), version: 3 } }),
        "holds terms that don't parse (terms.version_unknown)",
      ],
      [(j) => Object.assign(j, { sent: { hash: COMMITMENT, validBefore: 25 } }), "doesn't hold"],
    ]
    for (const [change, says] of broken) {
      writeBooking(COMMITMENT, change)
      expect(() => store.booking(COMMITMENT), says).toThrow(`${bookingFile(COMMITMENT)} ${says}`)
      expect(() => store.bookings(), says).toThrow(says)
    }
    writeFileSync(bookingFile(COMMITMENT), '{')
    expect(() => store.booking(COMMITMENT)).toThrow("isn't JSON")
  })
})

describe("the supplier's reports", () => {
  const note = `A late cancellation on booking ${COMMITMENT}, reported at 2027-01-15T08:00:00Z.`
  const report: FiledReport = {
    commitmentId: COMMITMENT,
    reportNumber: 1,
    kind: 'lateCancellation',
    amount: 250_000_000n,
    note,
    evidenceHash: keccak256(stringToHex(note)),
  }
  it('saves a report with its note and reads it back, its transaction included', () => {
    expect(store.report(COMMITMENT)).toBeNull()
    store.putReport(report)
    expect(store.report(COMMITMENT)).toEqual(report)
    const sent: SentTransaction = { hash: `0x${'ab'.repeat(32)}`, validBefore: NOW + 25n }
    store.putReport({ ...report, sent })
    expect(store.report(COMMITMENT)).toEqual({ ...report, sent })
  })

  it("refuses a report whose evidence hash isn't its note's, or that's for another commitment", () => {
    const path = join(store.dir, 'reports', `${COMMITMENT}.json`)
    expect(() => store.putReport({ ...report, note: `${note} Changed later.` })).toThrow(
      `${path} wasn't written, since it holds an evidence hash its note doesn't give`,
    )
    store.putReport(report)
    const broken: [unknown, string][] = [
      [{ ...report, note: 'Another note.' }, "holds an evidence hash its note doesn't give"],
      [{ ...report, commitmentId: OTHER }, `holds the report on ${OTHER}`],
      [{ ...report, kind: 'cleaning' }, "doesn't hold a report"],
      [{ ...report, amount: 250 }, "doesn't hold a report"],
      // The lock takes two reports on a commitment at most, and the number is what tells them apart.
      [{ ...report, reportNumber: 0 }, "doesn't hold a report"],
      [{ ...report, reportNumber: 3 }, "doesn't hold a report"],
      [{ ...report, reportNumber: undefined }, "doesn't hold a report"],
    ]
    for (const [json, says] of broken) {
      writeFileSync(path, JSON.stringify(toWire(json)))
      expect(() => store.report(COMMITMENT), says).toThrow(`${path} ${says}`)
    }
  })
})
