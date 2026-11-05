import {
  type ChainedJobTerms,
  type CommitmentReference,
  formatUsd,
  type JobVerification,
  type PinnedBlock,
  REASON_CODES,
  type ReasonCode,
} from '@avow-finance/spec'
import type { Address, Hex } from 'viem'

/**
 * The developer's job service, which `service.ts` defines. Its budget and compute switch are what
 * the tool layer applies before the SDK books anything, and its `checkBeforeWork` is the
 * developer's own check of the customer's commitment before the business accepts it or any work
 * starts. The session runs both in a process of their own with no keys, and takes back only data.
 * The model reads none of it and can't change it.
 */
export interface ServiceFile {
  /**
   * The most a compute booking may cost per GPU-hour, in dollars, such as 3 or 2.40. The tool layer
   * refuses an offer over it with `service.over_budget`.
   */
  computeBudgetPerGpuHour: number
  /**
   * The compute switch. While it's true the agent books compute for each job and names the booking
   * in its quote. While it's false the tool layer refuses every booking with `service.compute_off`,
   * and a quote goes out naming no booking.
   */
  bookCompute: boolean
  /**
   * Runs once the customer has reserved for a job, before the business accepts the job. The
   * business accepts and work starts only when it returns `start`. It runs with no keys, and
   * `avow` reads the chain and nothing else.
   */
  checkBeforeWork(job: ReservedJob, avow: ServiceChecks): Promise<Verdict>
}

/** A job the customer has reserved for, as `checkBeforeWork` gets it. Everything in it is public. */
export interface ReservedJob {
  orderId: string
  /** The customer's commitment, on the buyer side of the customer's lock. */
  commitment: CommitmentReference
  /** What a link to verify the job carries, which `verifyCommitment` checks on the chain. */
  verification: JobVerification
  /** The job's terms as the business quoted them, and their salt. */
  terms: ChainedJobTerms
  salt: Hex
  /** The business as the job's supplier, which the customer's lock has to name. */
  supplier: { account: Address; signingKey: Address; payee: Address }
  /** The lock's token, which the reserve is held in. */
  token: { address: Address; decimals: number }
}

/** The checks `checkBeforeWork` can run, each reading the chain and nothing else. */
export interface ServiceChecks {
  /**
   * Reads the customer's commitment and its reserve on its lock, at one finalized block. The lock
   * has to be from Avow's factory and hold the commitment under the job's terms hash, reserved or
   * already accepted, naming this business as supplier, with its signing key and payout. Every
   * value the lock enforces has to be what the job's terms set, and the reserve has to be held in
   * full. Each compute booking the job relies on has to stand at the same block.
   */
  verifyCommitment(job: ReservedJob): Promise<CommitmentCheck>
}

/** What `verifyCommitment` read, at one block, or why the commitment doesn't stand. */
export type CommitmentCheck =
  | {
      ok: true
      state: 'reserved' | 'accepted'
      /** What the customer's reserve holds, in micros. */
      reserve: bigint
      block: PinnedBlock
      /** Each compute booking the job relies on, as read at the same block. */
      bookings: { reference: CommitmentReference; block: PinnedBlock }[]
    }
  | { ok: false; code: ReasonCode; block: PinnedBlock | null; index: number | null }

/** Whether work starts, with the check it rests on or why not. */
export type Verdict =
  | { start: true; check: Extract<CommitmentCheck, { ok: true }> }
  | { start: false; code: ReasonCode; block: PinnedBlock | null; index: number | null }

/** Work starts, on the check that passed. */
export function start(check: CommitmentCheck): Verdict {
  if (!check.ok) return dontStart(check)
  return { start: true, check }
}

/** Work doesn't start, for the reason a failed check gave or one the developer names. */
export function dontStart(
  why: Extract<CommitmentCheck, { ok: false }> | { code: ReasonCode },
): Verdict {
  return {
    start: false,
    code: why.code,
    block: 'block' in why ? why.block : null,
    index: 'index' in why ? why.index : null,
  }
}

/** The policy the tool layer applies, in micros. */
export interface ServicePolicy {
  budgetPerGpuHour: bigint
  computeSwitch: 'on' | 'off'
}

/** The developer's service as `defineService` checked it. */
export interface Service {
  readonly kind: 'avow-job-service'
  readonly policy: ServicePolicy
  checkBeforeWork(job: ReservedJob, avow: ServiceChecks): Promise<Verdict>
}

/** Dollars as micros, refusing anything but a positive amount with at most whole cents. */
function budgetMicros(amount: unknown): bigint {
  const cents = typeof amount === 'number' ? Math.round(amount * 100) : Number.NaN
  if (
    typeof amount !== 'number' ||
    !Number.isFinite(amount) ||
    amount <= 0 ||
    Math.abs(amount * 100 - cents) > 1e-6
  ) {
    throw new TypeError(
      'computeBudgetPerGpuHour in service.ts has to be a positive amount of dollars, such as 3 or 2.40',
    )
  }
  return BigInt(cents) * 10_000n
}

/**
 * Reads the developer's service, refusing anything that isn't a budget in dollars, a switch and a
 * function, so a typo in `service.ts` fails when the session loads it and never inside a job.
 */
export function defineService(file: ServiceFile): Service {
  if (typeof file !== 'object' || file === null)
    throw new TypeError('service.ts defines no service')
  if (typeof file.bookCompute !== 'boolean') {
    throw new TypeError('bookCompute in service.ts has to be true or false')
  }
  if (typeof file.checkBeforeWork !== 'function') {
    throw new TypeError('checkBeforeWork in service.ts has to be a function')
  }
  const budgetPerGpuHour = budgetMicros(file.computeBudgetPerGpuHour)
  return Object.freeze({
    kind: 'avow-job-service',
    policy: Object.freeze({ budgetPerGpuHour, computeSwitch: file.bookCompute ? 'on' : 'off' }),
    checkBeforeWork: file.checkBeforeWork.bind(file),
  } as const)
}

/** Whether a value is a service `defineService` made, as a loaded `service.ts` exports by default. */
export function isService(value: unknown): value is Service {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'avow-job-service'
  )
}

/** A whole number of micros as the child process writes it, as a decimal string. */
const microsOf = (v: unknown): bigint | null =>
  typeof v === 'string' && /^(0|[1-9][0-9]{0,30})$/.test(v) ? BigInt(v) : null

const isHex = (v: unknown, bytes: number): v is Hex =>
  typeof v === 'string' && new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(v)

/** A policy as the child process wrote it, or null when it doesn't read. */
export function readPolicy(json: unknown): ServicePolicy | null {
  const p = json as { budgetPerGpuHour?: unknown; computeSwitch?: unknown } | null
  const budgetPerGpuHour = microsOf(p?.budgetPerGpuHour)
  if (budgetPerGpuHour === null || budgetPerGpuHour === 0n) return null
  if (p?.computeSwitch !== 'on' && p?.computeSwitch !== 'off') return null
  return { budgetPerGpuHour, computeSwitch: p.computeSwitch }
}

function readBlock(json: unknown): PinnedBlock | null {
  const b = json as { number?: unknown; hash?: unknown; timestamp?: unknown } | null
  const number = microsOf(b?.number)
  const timestamp = microsOf(b?.timestamp)
  if (number === null || timestamp === null || !isHex(b?.hash, 32)) return null
  return { number, hash: b.hash.toLowerCase() as Hex, timestamp }
}

/**
 * A verdict as the child process wrote it, or null when it doesn't read. The verdict comes from
 * the developer's own code, so every field is read here, at the boundary, and anything else is
 * dropped. A start names the block its check read and the compute bookings it read with it.
 */
export function readVerdict(json: unknown): Verdict | null {
  const v = json as Record<string, unknown> | null
  if (typeof v !== 'object' || v === null) return null
  if (v.start === false) {
    const code = v.code
    if (typeof code !== 'string' || !Object.hasOwn(REASON_CODES, code)) return null
    const block = v.block === null ? null : readBlock(v.block)
    if (v.block !== null && block === null) return null
    const index = v.index
    if (
      index !== null &&
      !(Number.isInteger(index) && (index as number) >= 0 && (index as number) < 4)
    ) {
      return null
    }
    return { start: false, code: code as ReasonCode, block, index: index as number | null }
  }
  if (v.start !== true) return null
  const c = v.check as Record<string, unknown> | null
  if (typeof c !== 'object' || c === null || c.ok !== true) return null
  if (c.state !== 'reserved' && c.state !== 'accepted') return null
  const reserve = microsOf(c.reserve)
  const block = readBlock(c.block)
  if (reserve === null || block === null || !Array.isArray(c.bookings) || c.bookings.length > 4) {
    return null
  }
  const bookings: { reference: CommitmentReference; block: PinnedBlock }[] = []
  for (const b of c.bookings as Record<string, unknown>[]) {
    const r = b?.reference as Record<string, unknown> | null
    const at = readBlock(b?.block)
    if (
      !at ||
      typeof r !== 'object' ||
      r === null ||
      r.kind !== 'commitment' ||
      !Number.isInteger(r.chainId) ||
      !isHex(r.lock, 20) ||
      !isHex(r.commitmentId, 32) ||
      (r.side !== 'buyer' && r.side !== 'supplier') ||
      !isHex(r.termsHash, 32)
    ) {
      return null
    }
    bookings.push({
      reference: {
        kind: 'commitment',
        chainId: r.chainId as number,
        lock: (r.lock as string).toLowerCase() as Address,
        commitmentId: (r.commitmentId as string).toLowerCase() as Hex,
        side: r.side,
        termsHash: (r.termsHash as string).toLowerCase() as Hex,
      },
      block: at,
    })
  }
  return { start: true, check: { ok: true, state: c.state, reserve, block, bookings } }
}

/** One quiet line for each way a re-read policy differs from the last one. */
export function policyChanges(before: ServicePolicy, after: ServicePolicy): string[] {
  const lines: string[] = []
  if (before.computeSwitch !== after.computeSwitch) {
    lines.push(`service.ts changed: compute booking is ${after.computeSwitch}`)
  }
  if (before.budgetPerGpuHour !== after.budgetPerGpuHour) {
    lines.push(
      `service.ts changed: budget is now ${formatUsd(after.budgetPerGpuHour)} per GPU-hour`,
    )
  }
  return lines
}
