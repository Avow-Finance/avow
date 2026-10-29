import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { Address, Hex } from 'viem'
import { generatePrivateKey } from 'viem/accounts'

/**
 * The supplier's two keys. The account key holds the supplier's account, which businesses approve
 * on their locks and where charges are paid. The signing key signs agreements and acceptances,
 * and pays the fee for each acceptance it sends.
 */
export interface SupplierKeys {
  accountKey: Hex
  signingKey: Hex
}

/** Where a booking stands, from the agreement the supplier signed to the lock taking its acceptance. */
export type BookingStatus = 'agreed' | 'granted' | 'accepting' | 'accepted' | 'lapsed'

/** One booking an agent made, as the supplier keeps it. Amounts and times are decimal strings. */
export interface Booking {
  commitmentId: Hex
  chainId: number
  lock: Address
  /** The terms agreement the supplier signed, as JSON. */
  agreement: unknown
  /** The terms the agreement's hash covers, as JSON. */
  terms: unknown
  salt: Hex
  /** The supplier's signature on the agreement. */
  signature: Hex
  status: BookingStatus
  /** The acceptance transaction last sent, recorded before its bytes went to the chain. */
  sent?: { hash: Hex; validBefore: string | null }
}

/** Writes a file whole or not at all, so a crash never leaves half a record. */
function writeAtomically(path: string, text: string, mode = 0o600) {
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, text, { mode })
  renameSync(temporary, path)
}

/**
 * The supplier's state directory: its keys and one file per booking. The keys file is readable
 * only by the user who made it. Keep the directory out of version control and back it up, since
 * the keys can't be made again.
 */
export class SupplierStore {
  readonly #bookings: string

  constructor(readonly dir: string) {
    this.#bookings = join(dir, 'bookings')
    mkdirSync(this.#bookings, { recursive: true, mode: 0o700 })
  }

  get #keysFile() {
    return join(this.dir, 'keys.json')
  }

  keys(): SupplierKeys | null {
    if (!existsSync(this.#keysFile)) return null
    return JSON.parse(readFileSync(this.#keysFile, 'utf8')) as SupplierKeys
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

  booking(commitmentId: Hex): Booking | null {
    const path = join(this.#bookings, `${commitmentId.toLowerCase()}.json`)
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Booking) : null
  }

  put(booking: Booking) {
    const path = join(this.#bookings, `${booking.commitmentId.toLowerCase()}.json`)
    writeAtomically(path, `${JSON.stringify(booking, null, 2)}\n`)
  }

  bookings(): Booking[] {
    return readdirSync(this.#bookings)
      .filter((name) => name.endsWith('.json'))
      .map((name) => JSON.parse(readFileSync(join(this.#bookings, name), 'utf8')) as Booking)
  }
}
