import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Address, Hex } from 'viem'
import { generatePrivateKey } from 'viem/accounts'

/**
 * The business's two keys. The root key holds the business account and stands in for the
 * administrator's passkey, so it signs the mandate and puts the agent's key on the account. The
 * agent key is the agent's own access key on that account.
 */
export interface BuyerKeys {
  rootKey: Hex
  agentKey: Hex
}

/** What setting up has done so far, so each command picks up where the last one stopped. */
export interface BuyerSetup {
  lock?: Address
  /** The mandate the administrator signed, as JSON. */
  mandate?: unknown
  /** The transaction that put the agent's key on the account with the mandate's hash. */
  keyAuthorizedIn?: Hex
  enrollment?: unknown
}

function writeAtomically(path: string, text: string) {
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, text, { mode: 0o600 })
  renameSync(temporary, path)
}

const readJson = <T>(path: string): T | null =>
  existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : null

/**
 * The business's state directory: its keys, its setup and one file per booking. Keep it out of
 * version control and back it up, since the keys can't be made again. A booking's file holds its
 * salt, which only the two parties should see.
 */
export class BuyerStore {
  constructor(readonly dir: string) {
    mkdirSync(join(dir, 'bookings'), { recursive: true, mode: 0o700 })
  }

  keys(): BuyerKeys | null {
    return readJson<BuyerKeys>(join(this.dir, 'keys.json'))
  }

  /** Makes the business's keys once. It refuses to replace keys that exist. */
  makeKeys(): BuyerKeys {
    if (this.keys()) throw new Error(`${this.dir}/keys.json already holds the business's keys`)
    const keys: BuyerKeys = { rootKey: generatePrivateKey(), agentKey: generatePrivateKey() }
    writeAtomically(join(this.dir, 'keys.json'), `${JSON.stringify(keys, null, 2)}\n`)
    return keys
  }

  setup(): BuyerSetup {
    return readJson<BuyerSetup>(join(this.dir, 'setup.json')) ?? {}
  }

  saveSetup(change: BuyerSetup): BuyerSetup {
    const next = { ...this.setup(), ...change }
    writeAtomically(join(this.dir, 'setup.json'), `${JSON.stringify(next, null, 2)}\n`)
    return next
  }

  saveBooking(commitmentId: Hex, record: unknown) {
    writeAtomically(
      join(this.dir, 'bookings', `${commitmentId.toLowerCase()}.json`),
      `${JSON.stringify(record, null, 2)}\n`,
    )
  }
}
