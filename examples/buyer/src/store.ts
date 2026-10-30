import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { ApprovedCommitment, Commitment } from '@avow-finance/sdk'
import {
  type Approval,
  approvalJson,
  type Enrollment,
  type Mandate,
  mandateJson,
  parseEnrollment,
  parseSigned,
  parseSignedAgreement,
  parseSupplierProfile,
  parseTerms,
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

/** A booking whose funding failed, or whose outcome the chain didn't show in time. */
export type UnsettledBooking = ApprovedCommitment & { outcome: 'failed' | 'unknown' }

/**
 * One booking the agent made, as `book` saves it. It's a funded commitment, or one whose funding
 * failed or has an outcome the chain didn't show in time.
 */
export type BuyerBooking = Commitment | UnsettledBooking

/** Whether a booking's funding failed, so the lock never held a reserve for it to cancel. */
export const neverFunded = (b: BuyerBooking): boolean => 'outcome' in b && b.outcome === 'failed'

/**
 * How the business cancelled a booking, once that's settled. Through Avow once free cancellation
 * ended, with the time Avow recorded, or on the lock before then, with the transaction that gave
 * the reserve back.
 */
export type SettledCancellation =
  | { by: 'avow'; cancelledAt: bigint }
  | { by: 'lock'; transactionHash: Hex }

/**
 * A cancellation on the lock whose transaction went out before anyone saw it land. It's saved just
 * before the bytes go out, so a later run settles it from the transaction's receipt and never asks
 * Avow to record a late cancellation of a reserve that came back in full.
 */
export interface SentCancellation {
  by: 'lock'
  sent: { hash: Hex; validBefore: bigint | null }
}

/** Where a booking's cancellation stands in the store. */
export type Cancellation = SettledCancellation | SentCancellation

/** Whether a cancellation is settled, or still a transaction nobody has seen land. */
export const isSettled = (c: Cancellation): c is SettledCancellation => !('sent' in c)

const bytes32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((s) => s.toLowerCase() as Hex)
const decimal = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .transform((s) => BigInt(s))
const keysJson = z.strictObject({ rootKey: bytes32, agentKey: bytes32 })

/** A commitment id as the store writes one, 32 bytes of hex in lower case, or null for anything else. */
export function readCommitmentId(text: string): Hex | null {
  const parsed = bytes32.safeParse(text)
  return parsed.success ? parsed.data : null
}
const bookingJson = z.strictObject({
  commitmentId: bytes32,
  supplier: z.unknown(),
  terms: z.unknown(),
  salt: bytes32,
  termsHash: bytes32,
  agreement: z.unknown(),
  approval: z.unknown(),
  reservedIn: bytes32.nullable().optional(),
  outcome: z.enum(['failed', 'unknown']).optional(),
})
const cancellationJson = z.union([
  z.strictObject({ commitmentId: bytes32, by: z.literal('avow'), cancelledAt: decimal }),
  z.strictObject({ commitmentId: bytes32, by: z.literal('lock'), transactionHash: bytes32 }),
  z.strictObject({
    commitmentId: bytes32,
    by: z.literal('lock'),
    sent: z.strictObject({ hash: bytes32, validBefore: decimal.nullable() }),
  }),
])
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
 * The booking some JSON holds, for one commitment under the business's lock on Moderato. Its
 * supplier, terms, agreement and approval each have to parse, the agreement and approval have to
 * name the commitment, and it has to hold either the transaction that funded it or the outcome of
 * a funding that didn't settle, never both.
 */
function parseBooking(
  json: unknown,
  expected: { commitmentId: Hex; lock: Address },
  refuse: (what: string) => Error,
): BuyerBooking {
  const outer = bookingJson.safeParse(json)
  if (!outer.success) throw refuse("doesn't hold a booking")
  const { supplier, terms, agreement, approval, reservedIn, outcome, ...rest } = outer.data
  if (rest.commitmentId !== expected.commitmentId.toLowerCase()) {
    throw refuse(`holds the booking for ${rest.commitmentId}`)
  }
  const envelope = { chainId: TEMPO_MODERATO, lock: expected.lock }
  const profile = parseSupplierProfile(supplier)
  if (!profile.ok) throw refuse(`holds a supplier that doesn't parse (${profile.reason})`)
  const parsedTerms = parseTerms(terms)
  if (!parsedTerms.ok) throw refuse(`holds terms that don't parse (${parsedTerms.reason})`)
  const signedAgreement = parseSignedAgreement(agreement, envelope)
  if (!signedAgreement.ok) {
    throw refuse(`holds an agreement that doesn't parse (${signedAgreement.reason})`)
  }
  const signedApproval = parseSigned(approval, 'Approval', approvalJson, envelope)
  if (!signedApproval.ok) {
    throw refuse(`holds an approval that doesn't parse (${signedApproval.reason})`)
  }
  if (
    signedAgreement.value.message.commitmentId !== rest.commitmentId ||
    signedApproval.value.message.commitmentId !== rest.commitmentId
  ) {
    throw refuse('holds an agreement or an approval for another commitment')
  }
  const approved: ApprovedCommitment = {
    ...rest,
    supplier: profile.value,
    terms: parsedTerms.value,
    agreement: signedAgreement.value,
    approval: signedApproval.value as Signed<Approval>,
  }
  if (reservedIn !== undefined && outcome === undefined) return { ...approved, reservedIn }
  if (outcome !== undefined && reservedIn === undefined) return { ...approved, outcome }
  throw refuse('holds both a funding and an outcome, or neither')
}

/** Whether booking `a` was agreed after booking `b`, by when their agreements expire. */
function agreedAfter(a: BuyerBooking, b: BuyerBooking): boolean {
  const [x, y] = [a.agreement.message.expiry, b.agreement.message.expiry]
  return x > y || (x === y && a.commitmentId > b.commitmentId)
}

/**
 * The business's state directory: its keys, its setup, one file per booking and one per
 * cancellation. Keep it out of version control and back it up, since the keys can't be made again.
 * A booking's file holds its salt, which only the two parties should see. Each file is parsed as
 * it's read, and one that doesn't hold what it should is refused, so nothing unchecked from disk
 * reaches the agent.
 */
export class BuyerStore {
  readonly #bookings: string
  readonly #cancellations: string

  constructor(readonly dir: string) {
    this.#bookings = join(dir, 'bookings')
    this.#cancellations = join(dir, 'cancellations')
    mkdirSync(this.#bookings, { recursive: true, mode: 0o700 })
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

  /** The lock the setup holds, which every booking is signed under. */
  #lock(): Address {
    const { lock } = this.setup()
    if (!lock) throw new Error(`${this.dir} holds no lock yet. Run init first.`)
    return lock
  }

  #bookingFile(commitmentId: Hex) {
    return join(this.#bookings, `${commitmentId.toLowerCase()}.json`)
  }

  #cancellationFile(commitmentId: Hex) {
    return join(this.#cancellations, `${commitmentId.toLowerCase()}.json`)
  }

  /** The booking for a commitment, or null when there's none. It refuses a file that doesn't hold one. */
  booking(commitmentId: Hex): BuyerBooking | null {
    const path = this.#bookingFile(commitmentId)
    const json = readJson(path)
    if (json === null) return null
    return parseBooking(
      json,
      { commitmentId, lock: this.#lock() },
      (what) => new Error(`${path} ${what}`),
    )
  }

  /**
   * The booking the agent made last, or null when there's none. Each agreement expires the same
   * time after the agent makes it, so the one that expires last was made last. It refuses the
   * first file that doesn't hold a booking.
   */
  latestBooking(): BuyerBooking | null {
    let latest: BuyerBooking | null = null
    for (const name of readdirSync(this.#bookings)) {
      if (!name.endsWith('.json')) continue
      const booking = this.booking(name.slice(0, -'.json'.length) as Hex)
      if (booking && (!latest || agreedAfter(booking, latest))) latest = booking
    }
    return latest
  }

  /**
   * Saves a booking. What it would write gets every check a read makes first, so a save never
   * leaves a file that later reads refuse.
   */
  saveBooking(booking: BuyerBooking) {
    const path = this.#bookingFile(booking.commitmentId)
    const text = `${JSON.stringify(toWire(booking), null, 2)}\n`
    parseBooking(
      JSON.parse(text),
      { commitmentId: booking.commitmentId, lock: this.#lock() },
      (what) => new Error(`${path} wasn't written, since it ${what}`),
    )
    writeAtomically(path, text)
  }

  /** Where a booking's cancellation stands, or null when the store shows none. */
  cancellation(commitmentId: Hex): Cancellation | null {
    const path = this.#cancellationFile(commitmentId)
    const json = readJson(path)
    if (json === null) return null
    const parsed = cancellationJson.safeParse(json)
    if (!parsed.success) throw new Error(`${path} doesn't hold a cancellation`)
    const { commitmentId: named, ...cancellation } = parsed.data
    if (named !== commitmentId.toLowerCase()) {
      throw new Error(`${path} holds the cancellation of ${named}`)
    }
    return cancellation
  }

  /**
   * Records where a booking's cancellation stands. A sent cancellation gives way to a later send or
   * to a settled cancellation, and a settled one is final. It refuses a commitment the store holds
   * no booking for and a booking whose funding failed.
   */
  saveCancellation(commitmentId: Hex, cancellation: Cancellation) {
    const booking = this.booking(commitmentId)
    if (!booking) throw new Error(`${this.dir} holds no booking for ${commitmentId}`)
    if (neverFunded(booking)) {
      throw new Error(`The booking ${commitmentId} was never funded, so it has nothing to cancel`)
    }
    const known = this.cancellation(commitmentId)
    if (known && isSettled(known)) {
      throw new Error(`${this.dir} already shows the booking ${commitmentId} cancelled`)
    }
    mkdirSync(this.#cancellations, { recursive: true, mode: 0o700 })
    writeAtomically(
      this.#cancellationFile(commitmentId),
      `${JSON.stringify(toWire({ commitmentId: booking.commitmentId, ...cancellation }), null, 2)}\n`,
    )
  }

  /** Forgets a sent cancellation that never landed. It refuses to forget a settled one. */
  forgetSentCancellation(commitmentId: Hex) {
    const known = this.cancellation(commitmentId)
    if (!known || isSettled(known)) {
      throw new Error(`${this.dir} holds no sent cancellation for ${commitmentId}`)
    }
    rmSync(this.#cancellationFile(commitmentId))
  }
}
