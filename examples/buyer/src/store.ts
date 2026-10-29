import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type Enrollment,
  type Mandate,
  mandateJson,
  parseEnrollment,
  parseSigned,
  type Signed,
  TEMPO_MODERATO,
  toWire,
} from '@avow-finance/spec'
import { type Address, type Hex, isAddressEqual } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { z } from 'zod'

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
  /** The mandate the administrator signed for the agent, under the business's lock on Moderato. */
  mandate?: Signed<Mandate>
  /** The transaction that put the agent's key on the account with the mandate's hash. */
  keyAuthorizedIn?: Hex
  /** What Avow recorded when it enrolled the agent. */
  enrollment?: Enrollment
}

const bytes32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((s) => s.toLowerCase() as Hex)
const keysJson = z.strictObject({ rootKey: bytes32, agentKey: bytes32 })
const setupJson = z.strictObject({
  lock: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .transform((s) => s.toLowerCase() as Address)
    .optional(),
  mandate: z.unknown().optional(),
  keyAuthorizedIn: bytes32.optional(),
  enrollment: z.unknown().optional(),
})

function writeAtomically(path: string, text: string) {
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, text, { mode: 0o600 })
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
 * The setup some JSON holds, with every check a read of the setup file makes. The mandate has to
 * be signed for the setup's own lock on Moderato, and the enrollment has to be one Avow's API could
 * have answered with. `refuse` turns what's wrong into the error thrown.
 */
function parseSetup(json: unknown, refuse: (what: string) => Error): BuyerSetup {
  const outer = setupJson.safeParse(json)
  if (!outer.success) throw refuse("doesn't hold the business's setup")
  const { lock, mandate, keyAuthorizedIn, enrollment } = outer.data
  const setup: BuyerSetup = {}
  if (lock !== undefined) setup.lock = lock
  if (keyAuthorizedIn !== undefined) setup.keyAuthorizedIn = keyAuthorizedIn
  if (mandate !== undefined) {
    if (!lock) throw refuse('holds a mandate but no lock')
    const parsed = parseSigned(mandate, 'Mandate', mandateJson, { chainId: TEMPO_MODERATO, lock })
    if (!parsed.ok) throw refuse(`holds a mandate that doesn't parse (${parsed.reason})`)
    setup.mandate = parsed.value as Signed<Mandate>
  }
  if (enrollment !== undefined) {
    const parsed = parseEnrollment(enrollment)
    if (!parsed.ok) throw refuse(`holds an enrollment that doesn't parse (${parsed.reason})`)
    setup.enrollment = parsed.value
  }
  return setup
}

/**
 * The business's state directory: its keys, its setup and one file per booking. Keep it out of
 * version control and back it up, since the keys can't be made again. A booking's file holds its
 * salt, which only the two parties should see. Each file is parsed as it's read, and one that
 * doesn't hold what it should is refused, so nothing unchecked from disk reaches the agent.
 */
export class BuyerStore {
  constructor(readonly dir: string) {
    mkdirSync(join(dir, 'bookings'), { recursive: true, mode: 0o700 })
  }

  keys(): BuyerKeys | null {
    const path = join(this.dir, 'keys.json')
    const json = readJson(path)
    if (json === null) return null
    const parsed = keysJson.safeParse(json)
    if (!parsed.success) throw new Error(`${path} doesn't hold the business's two keys`)
    return parsed.data
  }

  /** Makes the business's keys once. It refuses to replace keys that exist. */
  makeKeys(): BuyerKeys {
    if (this.keys()) throw new Error(`${this.dir}/keys.json already holds the business's keys`)
    const keys: BuyerKeys = { rootKey: generatePrivateKey(), agentKey: generatePrivateKey() }
    writeAtomically(join(this.dir, 'keys.json'), `${JSON.stringify(keys, null, 2)}\n`)
    return keys
  }

  get #setupFile() {
    return join(this.dir, 'setup.json')
  }

  /**
   * What setting up has done so far. The mandate has to be signed for the setup's own lock on
   * Moderato, and the enrollment has to be one Avow's API could have answered with.
   */
  setup(): BuyerSetup {
    const path = this.#setupFile
    const json = readJson(path)
    if (json === null) return {}
    return parseSetup(json, (what) => new Error(`${path} ${what}`))
  }

  /**
   * Refuses a lock the setup can't take. Once a mandate is saved it's signed for the saved lock,
   * so the setup keeps that lock, and starting over with another one takes a new state directory.
   */
  checkLock(lock: Address) {
    const { lock: saved, mandate } = this.setup()
    if (mandate && saved && !isAddressEqual(saved, lock)) {
      throw new Error(
        `${this.dir} holds a mandate signed for the lock ${saved}, so it keeps that lock and can't take ${lock}. Use a new STATE_DIR to start over.`,
      )
    }
  }

  /**
   * Saves a change to the setup. What it would write gets every check a read makes first, so a
   * save never leaves a file that later reads refuse, and a refused change writes nothing.
   */
  saveSetup(change: BuyerSetup): BuyerSetup {
    if (change.lock !== undefined) this.checkLock(change.lock)
    const path = this.#setupFile
    const text = `${JSON.stringify(toWire({ ...this.setup(), ...change }), null, 2)}\n`
    const next = parseSetup(
      JSON.parse(text),
      (what) => new Error(`${path} wasn't changed, since with this change it ${what}`),
    )
    writeAtomically(path, text)
    return next
  }

  saveBooking(commitmentId: Hex, record: unknown) {
    writeAtomically(
      join(this.dir, 'bookings', `${commitmentId.toLowerCase()}.json`),
      `${JSON.stringify(record, null, 2)}\n`,
    )
  }
}
