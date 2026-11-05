import {
  type Approval,
  type ChainedTerms,
  type CheckedChainedTerms,
  type CheckedDependency,
  type CommitmentReference,
  chainedTermsShapeProblem,
  checkSectionDisclosure,
  type Dependency,
  dependenciesProblem,
  dependencyCheckProblem,
  type JobVerification,
  jobVerificationProblem,
  type PinnedBlock,
  parseSectionDisclosure,
  type RailState,
  type ReasonCode,
  type Side,
  subjectFits,
  subjectProblem,
} from '@avow-finance/spec'
import { type Address, type Hex, isAddressEqual } from 'viem'
import type { LockedBacking } from './chain.js'

/**
 * The check of a booking another booking relies on. A version 3 booking names each one in its
 * dependencies section, and before a buyer funds or a seller accepts, this reads each one's lock
 * directly and runs five tests. Any failure stops the step. It runs the same whoever the terms say
 * checks for the buyer, since it needs the terms in full, and terms carrying the dependencies
 * section only as its digest are refused with `dependency.elided` before anything is read.
 *
 * 1. Provenance. The lock is on a chain this check supports, the supported factory there lists it,
 *    and the lock's own factory field names that factory.
 * 2. Ownership. The lock's account is the account Avow's approval names as this booking's supplier,
 *    which the lock copies into the commitment, so a seller can't cite another business's booking
 *    by naming that business. The terms name only the buyer side of a lock, so terms naming the
 *    supplier side are refused before anything is read.
 * 3. State. The lock holds it, someone other than the seller's own account supplies it, the lock
 *    holds it as accepted with no report filed, and its free cancellation had closed by the pinned
 *    block's timestamp, so cancelling it from then on costs the seller a late-cancellation charge.
 * 4. Terms. The lock holds it under the terms hash the dependency names, and the section the
 *    seller shows hashes to that terms hash.
 * 5. Fit. The booking asks for no more than the booking it relies on, by its template's rule.
 *
 * The first read on each chain pins that chain's latest finalized block once per check, so every
 * booking on that chain is read at that one block, named by number, through whichever reader reads
 * it, and the result records that block's number, hash and timestamp. A finalized block older than the read age limit by the caller's clock refuses with
 * `dependency.stale`, since a node that has fallen behind would show a state the chain has left. A
 * read that fails, times out or can't be pinned refuses with `dependency.unreadable`, never as not
 * found and never as a pass.
 *
 * It proves that a matching booking had been accepted when it was read. It doesn't set that
 * capacity aside, so two bookings that rely on the same one both pass. It refuses a seller that
 * supplied the booking relied on from its own account, and it can't tell when one owner runs two
 * registered businesses. Nothing on the chain enforces a dependency, and the booking relied on can
 * leave the accepted state right after the read.
 */

export type { CheckedChainedTerms, CheckedDependency, PinnedBlock } from '@avow-finance/spec'

/** What a lock's record of one side of a commitment says, as far as this check reads it. */
export type DependencyRecord = Pick<
  LockedBacking,
  'state' | 'hasReport' | 'termsHash' | 'supplier' | 'freeCancelBy'
>

/**
 * Reads the locks one factory created on one chain, each read as of a block named by number. The
 * check reads a booking relied on only through one of these, so the readers it's given are the
 * chain and factory pairs it supports. `tempoLockReader` reads Tempo, and tests script one.
 */
export interface PinnedLockReader {
  readonly chainId: number
  /** The factory whose locks count. */
  readonly factory: Address
  /** The latest finalized block's number, hash and timestamp. */
  head(): Promise<PinnedBlock>
  /** The hash the chain's block at this height has now, or null when the node has none. */
  blockHash(number: bigint): Promise<Hex | null>
  /** Whether the factory lists the lock as one it created, as of the block. */
  isLock(lock: Address, at: bigint): Promise<boolean>
  /** The factory and the account the lock's own fields name, as of the block. */
  lockFields(lock: Address, at: bigint): Promise<{ factory: Address; account: Address }>
  /** The lock's record of one side of a commitment as of the block, or null when it holds none. */
  commitment(
    lock: Address,
    commitmentId: Hex,
    side: Side,
    at: bigint,
  ): Promise<DependencyRecord | null>
}

/** Ten seconds for the reads of one booking relied on through one reader. */
export const DEPENDENCY_READ_TIMEOUT_MS = 10_000

/**
 * Thirty seconds, the oldest a pinned finalized block may be by the caller's clock. Tempo finalizes
 * blocks within about a second, so this leaves room for clock drift and nothing more.
 */
export const DEPENDENCY_MAX_READ_AGE = 30n

export interface DependencyDeps {
  /**
   * One reader for each chain and factory pair whose locks count. A lock on any other chain, or
   * from any other factory, is refused without being read.
   */
  readers: readonly PinnedLockReader[]
  /**
   * How long the reads of one booking through one reader may take, `DEPENDENCY_READ_TIMEOUT_MS`
   * by default.
   */
  timeoutMs?: number
  /**
   * The oldest, in seconds by the caller's clock, a pinned block may be, `DEPENDENCY_MAX_READ_AGE`
   * by default.
   */
  maxReadAge?: bigint
}

/**
 * What the check reads of Avow's approval of this booking's reserve. Its supplier is the account
 * the lock copies into the commitment as the supplier, so it is the account whose lock has to hold
 * each booking relied on.
 */
export type DependencyApproval = Pick<Approval, 'side' | 'supplier'>

export interface DependencyInput {
  /** The booking that relies on others, in version 3 terms in full. */
  terms: ChainedTerms
  /**
   * Avow's approval of this booking's reserve, or for Avow's own check the approval it is about to
   * sign. A buyer passes the approval it is about to fund, and `prepareAcceptance` passes the
   * approval the lock holds, which its later checks confirm. The supplier is taken from it and
   * from nowhere else, so neither what a seller says nor a caller's setting can name the owner.
   */
  approval: DependencyApproval
  /**
   * For each dependency in the terms' order, the section of the booking relied on that its seller
   * shows, as JSON, as `discloseSection` writes it. The subject holds no price.
   */
  disclosed: readonly unknown[]
  /** The caller's clock, in seconds, which the pinned block's timestamp is held against. */
  now: bigint
}

/** Why a check refused, with where and as of which block. */
export interface DependencyRefusal {
  ok: false
  reason: ReasonCode
  /** The dependency that failed, by its place in the terms, or null when the input did. */
  index: number | null
  /** The block its reads were pinned to, or null when it failed before a block was pinned. */
  block: PinnedBlock | null
}

export type DependencyCheck =
  | { ok: true; terms: CheckedChainedTerms; checked: readonly CheckedDependency[] }
  | DependencyRefusal

/** What the state test makes of each state the lock has. The build fails when one is missing. */
const STATE_REASONS: { readonly [S in RailState]: ReasonCode | null } = {
  none: 'dependency.not_found',
  reserved: 'dependency.not_accepted',
  // Accepted passes only with no report filed, which `stateProblem` checks.
  accepted: null,
  charge_pending: 'dependency.charge_pending',
  paused: 'dependency.charge_pending',
  released: 'dependency.ended',
  charged: 'dependency.ended',
  resolved: 'dependency.ended',
}

function stateProblem(
  record: DependencyRecord | null,
  seller: Address,
  block: PinnedBlock,
): ReasonCode | null {
  if (!record) return 'dependency.not_found'
  // A booking the seller supplied from its own account shows no one else accepted it.
  if (isAddressEqual(record.supplier, seller)) return 'dependency.self_supplied'
  if (record.state === 'accepted' && record.hasReport) return 'dependency.charge_pending'
  const reason = STATE_REASONS[record.state]
  if (reason) return reason
  // The lock lets the seller's account cancel an accepted booking at no charge in any block before
  // its free-cancellation deadline, and block timestamps never go back, so this one has to be at or
  // past the deadline.
  return block.timestamp < record.freeCancelBy ? 'dependency.cancellable' : null
}

/** Everything read about one booking relied on, all as of one block. */
interface Observed {
  reader: PinnedLockReader
  block: PinnedBlock
  /** The lock's own fields, or null when the reader's factory doesn't list it. */
  fields: { factory: Address; account: Address } | null
  record: DependencyRecord | null
}

/**
 * A read that couldn't be finished or can't be relied on, carrying the block it had pinned when it
 * stopped and why.
 */
class Unreadable extends Error {
  constructor(
    readonly block: PinnedBlock | null,
    readonly reason: 'dependency.unreadable' | 'dependency.stale' = 'dependency.unreadable',
  ) {
    super('The booking relied on could not be read at one recent block')
  }
}

/** How old a check's pinned blocks may be, and by which clock. */
interface Freshness {
  now: bigint
  maxAge: bigint
}

/** The work, or a rejection once `ms` has passed. */
function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`No answer within ${ms} ms`)), ms)
  })
  return Promise.race([work, late]).finally(() => clearTimeout(timer))
}

/**
 * The block each chain was pinned at in one check, by chain id, so two readers on one chain, such
 * as two factories there, read at the same block.
 */
type Pins = Map<number, PinnedBlock>

/**
 * Reads one booking relied on through one reader, every read at the block pinned for its chain in
 * this check. The first read on a chain pins the latest finalized block through the reader making
 * it, and every later read on that chain in the same check, through any reader, reads at that
 * block too. A pinned block older than the freshness limit stops
 * the check before the lock is read. A lock the reader's factory doesn't list is never read from.
 * Whatever was read stands only once the block at that height still has the hash it had when it
 * was pinned, a lock no factory lists included.
 */
async function observe(
  on: CommitmentReference,
  reader: PinnedLockReader,
  pins: Pins,
  timeoutMs: number,
  fresh: Freshness,
): Promise<Observed> {
  const work = async (): Promise<Observed> => {
    let block = pins.get(reader.chainId)
    if (!block) {
      block = await reader.head()
      pins.set(reader.chainId, block)
    }
    if (fresh.now - block.timestamp > fresh.maxAge) throw new Unreadable(block, 'dependency.stale')
    const listed = await reader.isLock(on.lock, block.number)
    const fields = listed ? await reader.lockFields(on.lock, block.number) : null
    const record = listed
      ? await reader.commitment(on.lock, on.commitmentId, on.side, block.number)
      : null
    const still = await reader.blockHash(block.number)
    if (still?.toLowerCase() !== block.hash.toLowerCase()) throw new Unreadable(block)
    return { reader, block, fields, record }
  }
  try {
    return await within(work(), timeoutMs)
  } catch (error) {
    throw error instanceof Unreadable ? error : new Unreadable(pins.get(reader.chainId) ?? null)
  }
}

/**
 * Whether a lock is one the reader's factory made: the factory lists it, and the lock's own factory
 * field names that factory. Each caller gives its own reason when it isn't.
 */
function madeByFactory(
  seen: Observed,
): seen is Observed & { fields: NonNullable<Observed['fields']> } {
  return seen.fields !== null && isAddressEqual(seen.fields.factory, seen.reader.factory)
}

/** Whether the lock holds the commitment read under the terms hash given. */
const heldUnder = (seen: Observed, termsHash: Hex) =>
  seen.record?.termsHash.toLowerCase() === termsHash.toLowerCase()

/** A check's refusal, with the dependency that failed and the block its reads were pinned to. */
const refusal = (
  reason: ReasonCode,
  index: number | null,
  block: PinnedBlock | null,
): DependencyRefusal => ({ ok: false, reason, index, block })

/** How long a check's reads may take and how old its blocks may be, the defaults unless set. */
function readLimits(deps: DependencyDeps, now: bigint): { timeoutMs: number; fresh: Freshness } {
  return {
    timeoutMs: deps.timeoutMs ?? DEPENDENCY_READ_TIMEOUT_MS,
    fresh: { now, maxAge: deps.maxReadAge ?? DEPENDENCY_MAX_READ_AGE },
  }
}

/**
 * The tests that need only the chain, in order, or null when all pass: provenance, ownership,
 * state, and the terms hash the lock holds the booking under.
 */
function standingProblem(
  on: CommitmentReference,
  seen: Observed,
  supplier: Address,
): ReasonCode | null {
  // 1. Provenance.
  if (!madeByFactory(seen)) return 'dependency.lock_unknown'
  // 2. Ownership.
  if (!isAddressEqual(seen.fields.account, supplier)) return 'dependency.not_owned'
  // 3. State.
  const state = stateProblem(seen.record, supplier, seen.block)
  if (state) return state
  // 4. Terms, as the lock holds them.
  if (!heldUnder(seen, on.termsHash)) return 'dependency.terms_mismatch'
  return null
}

/** The five tests on what was read, in order, or null when all pass. */
function problemOf(
  dependency: Dependency,
  seen: Observed,
  terms: ChainedTerms,
  supplier: Address,
  disclosed: unknown,
): ReasonCode | null {
  const standing = standingProblem(dependency.on, seen, supplier)
  if (standing) return standing
  const { on } = dependency
  // 4. Terms, as the seller shows them.
  const shown = parseSectionDisclosure(disclosed)
  if (
    !shown.ok ||
    shown.value.section !== dependency.disclosed ||
    checkSectionDisclosure(shown.value, on.termsHash) !== null
  ) {
    return 'dependency.disclosure_invalid'
  }
  // 5. Fit.
  const inner = { template: terms.template, subject: terms.subject }
  const outer = { template: shown.value.header.template, subject: shown.value.content }
  return subjectFits(inner, outer) ? null : 'dependency.does_not_fit'
}

/**
 * Checks every booking a version 3 booking relies on, in the order its terms name them, and stops
 * at the first that fails. A buyer runs it on Avow's approval before it funds its reserve, and the
 * seller's acceptance runs it through `prepareAcceptance`. It reads only the chain, the approval's
 * supplier and what the seller shows. The lock's public view of a booking relied on shows anyone
 * its reserve, charge caps, deadlines and supplier, so of what the seller pays for it, only the rate
 * stays hidden.
 */
export async function verifyDependencies(
  input: DependencyInput,
  deps: DependencyDeps,
): Promise<DependencyCheck> {
  const t = input.terms
  const shape = chainedTermsShapeProblem(t)
  if (shape) return refusal(shape, null, null)
  const setting = dependencyCheckProblem(t)
  if (setting) return refusal(setting, null, null)
  const rules = dependenciesProblem(t.dependencies)
  if (rules) return refusal(rules, null, null)
  // The fit test compares subjects, so a subject its template refuses stops the check before any
  // read.
  const subject = subjectProblem({ template: t.template, subject: t.subject })
  if (subject) return refusal(subject, null, null)
  if (input.disclosed.length > t.dependencies.length) return refusal('message.invalid', null, null)
  // The approval of this booking's reserve is for its buyer side, the only side version 3 terms
  // can be reserved on.
  if (input.approval.side !== 'buyer') return refusal('approval.terms_mismatch', null, null)
  const supplier = input.approval.supplier
  const { timeoutMs, fresh } = readLimits(deps, input.now)
  const pins: Pins = new Map()
  const checked: CheckedDependency[] = []
  for (const [index, dependency] of t.dependencies.entries()) {
    const seen = await readThrough(dependency.on, deps.readers, pins, timeoutMs, fresh)
    if (!('reader' in seen)) return refusal(seen.reason, index, seen.block)
    const problem = problemOf(dependency, seen, t, supplier, input.disclosed[index])
    if (problem) return refusal(problem, index, seen.block)
    checked.push(copied(dependency.on, seen.block))
  }
  return { ok: true, terms: t as CheckedChainedTerms, checked }
}

/**
 * Copies of a booking and its block, so freezing what a check gives back leaves the caller's
 * terms and the reader's block alone.
 */
function copied(on: CommitmentReference, block: PinnedBlock): CheckedDependency {
  const { number, hash, timestamp } = block
  return { on: { ...on }, block: { number, hash, timestamp } }
}

/** A read that stopped, with why and the block it had pinned. */
interface Stopped {
  reason: ReasonCode
  block: PinnedBlock | null
}

/**
 * Reads one booking through each supported reader on its chain in turn, until one's factory lists
 * its lock. The last one read stands for a lock none of them lists, and a chain no reader supports
 * is `dependency.lock_unknown`, with nothing read.
 */
async function readThrough(
  on: CommitmentReference,
  readers: readonly PinnedLockReader[],
  pins: Pins,
  timeoutMs: number,
  fresh: Freshness,
): Promise<Observed | Stopped> {
  let seen: Observed | null = null
  for (const reader of readers.filter((r) => r.chainId === on.chainId)) {
    try {
      seen = await observe(on, reader, pins, timeoutMs, fresh)
    } catch (error) {
      if (error instanceof Unreadable) return { reason: error.reason, block: error.block }
      return { reason: 'dependency.unreadable', block: null }
    }
    if (seen.fields) break
  }
  return seen ?? { reason: 'dependency.lock_unknown', block: null }
}

export interface JobVerificationInput {
  /** What a link to verify a job carries, from `decodeJobVerification`. */
  verification: JobVerification
  /** The caller's clock, in seconds, which the pinned block's timestamp is held against. */
  now: bigint
}

/**
 * The job commitment as the customer's lock held it at the pinned block. A link names a job in any
 * state, so its state comes back as read, and a page says what that state means: reserved before
 * the developer's business accepted, accepted while the job stands, and released, charged or
 * resolved once it ended.
 */
export interface CheckedJob {
  state: RailState
  /** The customer's free-cancellation deadline as the lock holds it, which is when work starts. */
  freeCancelBy: bigint
  /** The block the job commitment was read at, which every read on its chain shares. */
  block: PinnedBlock
}

/**
 * A booking a job's link names, as the link's check read it. The link carries the job's subject
 * only as its hash, so the check couldn't test whether the job fits inside the booking. A
 * `CheckedDependency` comes only from a check that tested fit, as the customer's check and the
 * developer's acceptance do, so this one has fields of its own and neither can stand for the other.
 */
export interface StandingBooking {
  booking: CommitmentReference
  /** The block the booking was read at. */
  readAt: PinnedBlock
  fit: 'unchecked'
}

/** What a link to verify a job shows, as the chain held it at one pinned block. */
export type JobVerificationCheck =
  | {
      ok: true
      job: CheckedJob
      /**
       * The supplier the customer's lock names for the job, copied there from Avow's approval,
       * whose own lock has to hold each compute booking.
       */
      supplier: Address
      /** Each compute booking the job names, with the block it was read at. */
      bookings: readonly StandingBooking[]
    }
  | DependencyRefusal

/**
 * What a read of the job's own commitment that stopped means, in the job's terms. The reasons a
 * read of a booking relied on stops with name that booking, so these name the job's lock and the
 * job's reference instead. A stale block means the same for either, so it stays.
 */
const JOB_READ_REASONS: Partial<Record<ReasonCode, ReasonCode>> = {
  'dependency.lock_unknown': 'chain.lock_unknown',
  'dependency.unreadable': 'reference.unreadable',
}

/**
 * The check a page runs on a link to verify a job, reading the chain at one pinned finalized
 * block. It works out the job's terms hash from what the link carries, reads the job commitment
 * from the customer's lock with its state and free-cancellation deadline, and takes the supplier
 * from the lock's record of it, which the lock copied from Avow's approval. A pass says the link
 * matches the chain, and the job's state says whether the job stands. Then it runs the tests `verifyDependencies` runs on each compute
 * booking the job names that need only the chain: provenance, ownership by that supplier, state
 * with free cancellation, the terms hash the lock holds and a fresh block. It skips the shown
 * section and fit, which need the job's terms in full, so each booking comes back as a
 * `StandingBooking` marked with fit unchecked.
 *
 * A link whose parts don't hash to its reference's terms hash is `terms.hash_mismatch`, a
 * customer's lock no supported factory created is `chain.lock_unknown`, a read of the job that
 * fails is `reference.unreadable`, and a lock that holds no job commitment under that terms hash is
 * `reference.commitment_mismatch`, each before any compute booking is read.
 */
export async function verifyJobVerification(
  input: JobVerificationInput,
  deps: DependencyDeps,
): Promise<JobVerificationCheck> {
  const v = input.verification
  const hashed = jobVerificationProblem(v)
  if (hashed) return refusal(hashed, null, null)
  const rules = dependenciesProblem(v.dependencies)
  if (rules) return refusal(rules, null, null)
  if (v.commitment.side !== 'buyer') return refusal('reference.commitment_mismatch', null, null)
  const { timeoutMs, fresh } = readLimits(deps, input.now)
  const pins: Pins = new Map()
  const job = await readThrough(v.commitment, deps.readers, pins, timeoutMs, fresh)
  if (!('reader' in job))
    return refusal(JOB_READ_REASONS[job.reason] ?? job.reason, null, job.block)
  if (!madeByFactory(job)) return refusal('chain.lock_unknown', null, job.block)
  if (!job.record || !heldUnder(job, v.commitment.termsHash)) {
    return refusal('reference.commitment_mismatch', null, job.block)
  }
  const supplier = job.record.supplier
  const bookings: StandingBooking[] = []
  for (const [index, dependency] of v.dependencies.entries()) {
    const seen = await readThrough(dependency.on, deps.readers, pins, timeoutMs, fresh)
    if (!('reader' in seen)) return refusal(seen.reason, index, seen.block)
    const problem = standingProblem(dependency.on, seen, supplier)
    if (problem) return refusal(problem, index, seen.block)
    const { on, block } = copied(dependency.on, seen.block)
    bookings.push({ booking: on, readAt: block, fit: 'unchecked' })
  }
  return {
    ok: true,
    job: {
      state: job.record.state,
      freeCancelBy: job.record.freeCancelBy,
      block: copied(v.commitment, job.block).block,
    },
    supplier,
    bookings,
  }
}
