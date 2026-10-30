import {
  type ChainedTerms,
  type CommitmentReference,
  chainedTermsShapeProblem,
  checkSectionDisclosure,
  type Dependency,
  dependenciesProblem,
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
 * dependencies section, and before a buyer signs or a seller accepts, this reads each one's lock
 * directly and runs five tests. Any failure stops the step. It runs the same whoever the terms say
 * checks for the buyer, since it needs the terms in full, and terms carrying the dependencies
 * section only as its digest are refused with `dependency.elided` before anything is read.
 *
 * 1. Provenance. The lock is on a chain this check supports, the supported factory there lists it,
 *    and the lock's own factory field names that factory.
 * 2. Ownership. The lock's account is the account the booking names as its supplier. The terms
 *    name only the buyer side of a lock, so terms naming the supplier side are refused before
 *    anything is read.
 * 3. State. The lock holds it, someone other than the seller's own account supplies it, and the
 *    lock holds it as accepted with no report filed.
 * 4. Terms. The lock holds it under the terms hash the dependency names, and the section the
 *    seller shows hashes to that terms hash.
 * 5. Fit. The booking asks for no more than the booking it relies on, by its template's rule.
 *
 * Each reader pins the latest finalized block once per check, so every booking read through it is
 * read at that one block, named by number, and the result records that block's number and hash. A
 * read that fails, times out or can't be pinned refuses with `dependency.unreadable`, never as not
 * found and never as a pass.
 *
 * It proves that a matching booking had been accepted when it was read. It doesn't set that
 * capacity aside, so two bookings that rely on the same one both pass. It refuses a seller that
 * supplied the booking relied on from its own account, and it can't tell when one owner runs two
 * registered businesses. Nothing on the chain enforces a dependency, and the booking relied on can
 * leave the accepted state right after the read.
 */

/** A block a check's reads were pinned to, by number, with the hash it had. */
export interface PinnedBlock {
  number: bigint
  hash: Hex
}

/** What a lock's record of one side of a commitment says, as far as this check reads it. */
export type DependencyRecord = Pick<LockedBacking, 'state' | 'hasReport' | 'termsHash' | 'supplier'>

/**
 * Reads the locks one factory created on one chain, each read as of a block named by number. The
 * check reads a booking relied on only through one of these, so the readers it's given are the
 * chain and factory pairs it supports. `tempoLockReader` reads Tempo, and tests script one.
 */
export interface PinnedLockReader {
  readonly chainId: number
  /** The factory whose locks count. */
  readonly factory: Address
  /** The latest finalized block's number and hash. */
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
}

export interface DependencyInput {
  /** The booking that relies on others, in version 3 terms in full. */
  terms: ChainedTerms
  /**
   * The account the booking names as its supplier, whose lock has to hold each booking relied on.
   */
  supplier: Address
  /**
   * For each dependency in the terms' order, the section of the booking relied on that its seller
   * shows, as JSON, as `discloseSection` writes it. The subject holds no price.
   */
  disclosed: readonly unknown[]
}

/** A booking relied on that passed, with the block every read of it was pinned to. */
export interface CheckedDependency {
  on: CommitmentReference
  block: PinnedBlock
}

declare const dependenciesPassed: unique symbol

/**
 * Version 3 terms every booking of which passed `verifyDependencies`. Only that check gives one,
 * so code that takes these instead of `ChainedTerms` can't be reached without the check.
 */
export type CheckedChainedTerms = ChainedTerms & { readonly [dependenciesPassed]: true }

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

function stateProblem(record: DependencyRecord | null, seller: Address): ReasonCode | null {
  if (!record) return 'dependency.not_found'
  // A booking the seller supplied from its own account shows no one else accepted it.
  if (isAddressEqual(record.supplier, seller)) return 'dependency.self_supplied'
  if (record.state === 'accepted' && record.hasReport) return 'dependency.charge_pending'
  return STATE_REASONS[record.state]
}

/** Everything read about one booking relied on, all as of one block. */
interface Observed {
  reader: PinnedLockReader
  block: PinnedBlock
  /** The lock's own fields, or null when the reader's factory doesn't list it. */
  fields: { factory: Address; account: Address } | null
  record: DependencyRecord | null
}

/** A read that couldn't be finished, carrying the block it had pinned when it stopped. */
class Unreadable extends Error {
  constructor(readonly block: PinnedBlock | null) {
    super('The booking relied on could not be read at one block')
  }
}

/** The work, or a rejection once `ms` has passed. */
function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`No answer within ${ms} ms`)), ms)
  })
  return Promise.race([work, late]).finally(() => clearTimeout(timer))
}

/** The block each reader pinned in one check, by reader. */
type Pins = Map<PinnedLockReader, PinnedBlock>

/**
 * Reads one booking relied on through one reader, every read at the block the reader pinned for
 * this check. The first read through a reader pins the latest finalized block, and every later one
 * in the same check reads at that block too. A lock the reader's factory doesn't list is never read
 * from. Whatever was read stands only once the block at that height still has the hash it had when
 * it was pinned, a lock no factory lists included.
 */
async function observe(
  on: CommitmentReference,
  reader: PinnedLockReader,
  pins: Pins,
  timeoutMs: number,
): Promise<Observed> {
  const work = async (): Promise<Observed> => {
    let block = pins.get(reader)
    if (!block) {
      block = await reader.head()
      pins.set(reader, block)
    }
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
    throw error instanceof Unreadable ? error : new Unreadable(pins.get(reader) ?? null)
  }
}

/** The five tests on what was read, in order, or null when all pass. */
function problemOf(
  dependency: Dependency,
  seen: Observed,
  terms: ChainedTerms,
  supplier: Address,
  disclosed: unknown,
): ReasonCode | null {
  const { on } = dependency
  // 1. Provenance.
  if (!seen.fields || !isAddressEqual(seen.fields.factory, seen.reader.factory)) {
    return 'dependency.lock_unknown'
  }
  // 2. Ownership.
  if (!isAddressEqual(seen.fields.account, supplier)) return 'dependency.not_owned'
  // 3. State.
  const state = stateProblem(seen.record, supplier)
  if (state) return state
  // 4. Terms.
  if (seen.record?.termsHash.toLowerCase() !== on.termsHash.toLowerCase()) {
    return 'dependency.terms_mismatch'
  }
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
 * at the first that fails. A buyer runs it before it signs the terms agreement, and the seller's
 * acceptance runs it through `prepareAcceptance`. It reads only the chain and what the seller
 * shows. The lock's public view of a booking relied on shows anyone its reserve, charge caps,
 * deadlines and supplier, so of what the seller pays for it, only the rate stays hidden.
 */
export async function verifyDependencies(
  input: DependencyInput,
  deps: DependencyDeps,
): Promise<DependencyCheck> {
  const refuse = (reason: ReasonCode, index: number | null, block: PinnedBlock | null) =>
    ({ ok: false, reason, index, block }) as const
  const t = input.terms
  const shape = chainedTermsShapeProblem(t)
  if (shape) return refuse(shape, null, null)
  const rules = dependenciesProblem(t.dependencies)
  if (rules) return refuse(rules, null, null)
  // The fit test compares subjects, so a subject its template refuses stops the check before any
  // read.
  const subject = subjectProblem({ template: t.template, subject: t.subject })
  if (subject) return refuse(subject, null, null)
  if (input.disclosed.length > t.dependencies.length) return refuse('message.invalid', null, null)
  const timeoutMs = deps.timeoutMs ?? DEPENDENCY_READ_TIMEOUT_MS
  const pins: Pins = new Map()
  const checked: CheckedDependency[] = []
  for (const [index, dependency] of t.dependencies.entries()) {
    // Each supported factory on the booking's chain in turn, until one lists the lock. The last
    // one read stands for a lock none of them lists.
    let seen: Observed | null = null
    for (const reader of deps.readers.filter((r) => r.chainId === dependency.on.chainId)) {
      try {
        seen = await observe(dependency.on, reader, pins, timeoutMs)
      } catch (error) {
        const block = error instanceof Unreadable ? error.block : null
        return refuse('dependency.unreadable', index, block)
      }
      if (seen.fields) break
    }
    // No factory is supported on the booking's chain, so nothing was read.
    if (!seen) return refuse('dependency.lock_unknown', index, null)
    const problem = problemOf(dependency, seen, t, input.supplier, input.disclosed[index])
    if (problem) return refuse(problem, index, seen.block)
    // Copies, so freezing what the check gives back leaves the caller's terms and the reader's
    // block alone.
    const { number, hash } = seen.block
    checked.push({ on: { ...dependency.on }, block: { number, hash } })
  }
  return { ok: true, terms: t as CheckedChainedTerms, checked }
}
