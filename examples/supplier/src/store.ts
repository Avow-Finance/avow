import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  CHARGE_KINDS,
  type ChargeKind,
  parseTerms,
  type Terms,
  type TermsAgreement,
  termsAgreementJson,
  toWire,
} from '@avow-finance/spec'
import { type Address, type Hex, keccak256, stringToHex } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { z } from 'zod'

/**
 * The supplier's two keys. The account key holds the supplier's account, which businesses approve
 * on their locks and where charges are paid. The signing key signs agreements and acceptances,
 * and pays the fee for each acceptance it sends.
 */
export interface SupplierKeys {
  accountKey: Hex
  signingKey: Hex
}

/**
 * Where a booking stands. `agreed` once the supplier signed the agreement. `held` once Avow
 * authorized the funded reserve and the verifier passed it, so the supplier holds the capacity
 * without granting it yet. `accepting` while the acceptance is on its way to the lock. `accepted`
 * once the lock holds the acceptance, which is when the supplier grants the capacity. `lapsed` when
 * no reserve came before the acceptance deadline.
 */
export const BOOKING_STATUSES = ['agreed', 'held', 'accepting', 'accepted', 'lapsed'] as const
export type BookingStatus = (typeof BOOKING_STATUSES)[number]

/** The transaction last sent for a step, recorded before its bytes went to the chain. */
export interface SentTransaction {
  hash: Hex
  validBefore: bigint | null
}

/**
 * The report of a charge the supplier filed on a booking. The note says which booking and kind it
 * reports and when, and the report names the note's keccak256 as its evidence, so the supplier
 * keeps the note to show a ruling.
 */
export interface FiledReport {
  commitmentId: Hex
  kind: ChargeKind
  /** Base units of the lock's token. */
  amount: bigint
  note: string
  evidenceHash: Hex
  /** The report transaction last sent, once one has been. */
  sent?: SentTransaction
}

/** What a booking holds whatever its status. */
interface BookingRecord {
  commitmentId: Hex
  chainId: number
  lock: Address
  /** The terms agreement the supplier signed. */
  agreement: TermsAgreement
  /** The terms the agreement's hash covers. */
  terms: Terms
  salt: Hex
  /** The supplier's signature on the agreement. */
  signature: Hex
}

/**
 * One booking an agent made, as the supplier keeps it, keyed on its status. Only an accepting
 * booking sends an acceptance, and an accepted one keeps the send that got it there, so those two
 * are the only statuses that can record one.
 */
export type Booking =
  | (BookingRecord & { status: 'agreed' | 'held' | 'lapsed'; sent?: never })
  | (BookingRecord & { status: 'accepting' | 'accepted'; sent?: SentTransaction })

const lower = <T extends string>(s: string) => s.toLowerCase() as T
const bytes32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform(lower<Hex>)
const keysJson = z.strictObject({ accountKey: bytes32, signingKey: bytes32 })
const decimal = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .transform((s) => BigInt(s))
const sentJson = z.strictObject({ hash: bytes32, validBefore: decimal.nullable() })
const reportJson = z.strictObject({
  commitmentId: bytes32,
  kind: z.enum(Object.keys(CHARGE_KINDS) as [ChargeKind, ...ChargeKind[]]),
  amount: decimal,
  note: z.string().min(1).max(1000),
  evidenceHash: bytes32,
  sent: sentJson.optional(),
})
const bookingJson = z.strictObject({
  commitmentId: bytes32,
  chainId: z.number().int().positive(),
  lock: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .transform(lower<Address>),
  agreement: z.unknown(),
  terms: z.unknown(),
  salt: bytes32,
  signature: z
    .string()
    .regex(/^0x([0-9a-fA-F]{2})+$/)
    .transform(lower<Hex>),
  status: z.enum(BOOKING_STATUSES),
  sent: sentJson.optional(),
})

/** Writes a file whole or not at all, so a crash never leaves half a record. */
function writeAtomically(path: string, text: string, mode = 0o600) {
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, text, { mode })
  renameSync(temporary, path)
}

/** A file's JSON, or null when there's no file. A file that isn't JSON is refused. */
function readJson(path: string): unknown {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new Error(`${path} isn't JSON`)
  }
}

/**
 * The supplier's state directory: its keys, one file per booking and one per report it files. The
 * keys file is readable only by the user who made it. Keep the directory out of version control
 * and back it up, since the keys can't be made again. Each file is parsed once as it's read, terms
 * included, and one that doesn't hold what it should is refused, so nothing unchecked from disk
 * reaches the verifier.
 */
export class SupplierStore {
  readonly #bookings: string
  readonly #reports: string

  constructor(readonly dir: string) {
    this.#bookings = join(dir, 'bookings')
    this.#reports = join(dir, 'reports')
    mkdirSync(this.#bookings, { recursive: true, mode: 0o700 })
  }

  get #keysFile() {
    return join(this.dir, 'keys.json')
  }

  keys(): SupplierKeys | null {
    const json = readJson(this.#keysFile)
    if (json === null) return null
    const parsed = keysJson.safeParse(json)
    if (!parsed.success) throw new Error(`${this.#keysFile} doesn't hold the supplier's two keys`)
    return parsed.data
  }

  /** Makes the supplier's keys once. It refuses to replace keys that exist. */
  makeKeys(): SupplierKeys {
    if (this.keys()) throw new Error(`${this.#keysFile} already holds the supplier's keys`)
    const keys: SupplierKeys = {
      accountKey: generatePrivateKey(),
      signingKey: generatePrivateKey(),
    }
    writeAtomically(this.#keysFile, `${JSON.stringify(keys, null, 2)}\n`)
    return keys
  }

  #bookingFile(commitmentId: Hex) {
    return join(this.#bookings, `${commitmentId.toLowerCase()}.json`)
  }

  /** The text of a commitment's booking file, unparsed, or null when there's no file. */
  bookingText(commitmentId: Hex): string | null {
    const path = this.#bookingFile(commitmentId)
    return existsSync(path) ? readFileSync(path, 'utf8') : null
  }

  /**
   * The booking a commitment's file text holds. It refuses text that isn't JSON or doesn't hold a
   * booking, a booking for another commitment, an agreement or terms that don't parse, and an
   * acceptance transaction under a status that never sends one. It reads nothing but the id and the
   * text, so the same text always gives the same answer, which the poll relies on to skip a file it
   * refused until the file changes.
   */
  parseBooking(commitmentId: Hex, text: string): Booking {
    const id = commitmentId.toLowerCase() as Hex
    const path = this.#bookingFile(id)
    const refuse = (what: string) => new Error(`${path} ${what}`)
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      throw refuse("isn't JSON")
    }
    const outer = bookingJson.safeParse(json)
    if (!outer.success) throw refuse("doesn't hold a booking")
    const { agreement: agreementJson, terms: termsJson, status, sent, ...rest } = outer.data
    if (rest.commitmentId !== id) throw refuse(`holds the booking for ${rest.commitmentId}`)
    const agreement = termsAgreementJson.safeParse(agreementJson)
    if (!agreement.success) throw refuse("holds an agreement that doesn't parse")
    if (agreement.data.commitmentId !== id)
      throw refuse('holds an agreement for another commitment')
    const terms = parseTerms(termsJson)
    if (!terms.ok) throw refuse(`holds terms that don't parse (${terms.reason})`)
    const record = { ...rest, agreement: agreement.data, terms: terms.value }
    if (sent === undefined) return { ...record, status }
    if (status !== 'accepting' && status !== 'accepted') {
      throw refuse(`holds an acceptance transaction, which a booking that's ${status} never has`)
    }
    return { ...record, status, sent }
  }

  /** The booking for a commitment, or null when there's none. It refuses what `parseBooking` does. */
  booking(commitmentId: Hex): Booking | null {
    const text = this.bookingText(commitmentId)
    return text === null ? null : this.parseBooking(commitmentId, text)
  }

  put(booking: Booking) {
    writeAtomically(
      this.#bookingFile(booking.commitmentId),
      `${JSON.stringify(toWire(booking), null, 2)}\n`,
    )
  }

  /** The commitment of every booking file, whether or not the file parses. */
  commitmentIds(): Hex[] {
    return readdirSync(this.#bookings)
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length) as Hex)
  }

  /** Every booking, refusing the first file that doesn't parse. */
  bookings(): Booking[] {
    return this.commitmentIds().flatMap((id) => this.booking(id) ?? [])
  }

  /**
   * The accepted booking agreed last, or null when none is accepted. Each agreement expires the
   * same time after the agent offers it, so the one that expires last was agreed last. It refuses
   * the first booking file that doesn't parse.
   */
  latestAccepted(): Booking | null {
    let latest: Booking | null = null
    for (const b of this.bookings()) {
      if (b.status === 'accepted' && (!latest || agreedAfter(b, latest))) latest = b
    }
    return latest
  }

  #reportFile(commitmentId: Hex) {
    return join(this.#reports, `${commitmentId.toLowerCase()}.json`)
  }

  /** The report filed on a commitment, or null when there's none. It refuses what `parseReport` does. */
  report(commitmentId: Hex): FiledReport | null {
    const path = this.#reportFile(commitmentId)
    const json = readJson(path)
    if (json === null) return null
    return parseReport(json, commitmentId, (what) => new Error(`${path} ${what}`))
  }

  /**
   * Saves the report filed on a commitment, in place of any saved for it before. What it would
   * write gets every check a read makes first, so a save never leaves a file a later read refuses.
   */
  putReport(report: FiledReport) {
    const path = this.#reportFile(report.commitmentId)
    const text = `${JSON.stringify(toWire(report), null, 2)}\n`
    parseReport(
      JSON.parse(text),
      report.commitmentId,
      (what) => new Error(`${path} wasn't written, since it ${what}`),
    )
    mkdirSync(this.#reports, { recursive: true, mode: 0o700 })
    writeAtomically(path, text)
  }
}

/** Whether booking `a` was agreed after booking `b`, by when their agreements expire. */
function agreedAfter(a: Booking, b: Booking): boolean {
  const [x, y] = [a.agreement.expiry, b.agreement.expiry]
  return x > y || (x === y && a.commitmentId > b.commitmentId)
}

/**
 * The report some JSON holds for one commitment. It refuses JSON that doesn't hold a report, a
 * report on another commitment, and an evidence hash that isn't its note's keccak256.
 */
function parseReport(
  json: unknown,
  commitmentId: Hex,
  refuse: (what: string) => Error,
): FiledReport {
  const parsed = reportJson.safeParse(json)
  if (!parsed.success) throw refuse("doesn't hold a report")
  const { sent, ...report } = parsed.data
  if (report.commitmentId !== commitmentId.toLowerCase()) {
    throw refuse(`holds the report on ${report.commitmentId}`)
  }
  if (report.evidenceHash !== keccak256(stringToHex(report.note))) {
    throw refuse("holds an evidence hash its note doesn't give")
  }
  return sent ? { ...report, sent } : report
}
