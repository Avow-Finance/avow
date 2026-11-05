import {
  type CommitmentReference,
  lockRecordDifferences,
  lockTerms,
  type PinnedBlock,
  type Side,
} from '@avow-finance/spec'
import {
  type DependencyRecord,
  type LockedBacking,
  type PinnedLockReader,
  verifyJobVerification,
} from '@avow-finance/verifier'
import { type Address, type Hex, isAddressEqual } from 'viem'
import type { CommitmentCheck, ReservedJob, ServiceChecks } from './service.js'

/**
 * The read-only checks `checkBeforeWork` gets as `avow`. They read the chain at one finalized block
 * and nothing else, and they hold no key, so the developer's own code can run them in a process
 * with none.
 */

/** Where the checks read the chain: a reader pinned to finalized blocks, and full lock records. */
export interface CommitmentChain {
  readers: readonly PinnedLockReader[]
  /** A lock's whole record of one side of a commitment as of a block, or null when it holds none. */
  backing(lock: Address, commitmentId: Hex, side: Side, at: bigint): Promise<LockedBacking | null>
}

/**
 * The customer's commitment and its reserve, read at one finalized block. `verifyJobVerification`
 * reads the commitment and each compute booking the job relies on at that block, and the lock's
 * whole record is read at the same block, so every field the lock enforces is checked against the
 * job's terms as of the block the check names.
 */
export async function verifyCommitment(
  job: ReservedJob,
  chain: CommitmentChain,
  now: bigint,
): Promise<CommitmentCheck> {
  const refuse = (
    code: Extract<CommitmentCheck, { ok: false }>['code'],
    block: PinnedBlock | null,
    index: number | null = null,
  ): CommitmentCheck => ({ ok: false, code, block, index })
  const read = await verifyJobVerification(
    { verification: job.verification, now },
    { readers: chain.readers },
  )
  if (read.outcome === 'refused') return refuse(read.reason, read.block, read.index)
  if (read.outcome !== 'awaiting_acceptance' && read.outcome !== 'stands') {
    return refuse('chain.reserve_missing', read.job.block)
  }
  const block = read.job.block
  if (!isAddressEqual(read.supplier, job.supplier.account)) {
    return refuse('approval.parties_mismatch', block)
  }
  const c = job.commitment
  const held = await chain.backing(c.lock, c.commitmentId, c.side, block.number)
  if (!held) return refuse('chain.reserve_missing', block)
  const fits =
    isAddressEqual(held.token, job.token.address) &&
    isAddressEqual(held.supplier, job.supplier.account) &&
    isAddressEqual(held.supplierSigner, job.supplier.signingKey) &&
    isAddressEqual(held.payee, job.supplier.payee) &&
    held.termsHash.toLowerCase() === c.termsHash.toLowerCase() &&
    held.held === held.amount &&
    lockRecordDifferences(held, lockTerms(job.terms, job.token.decimals)).length === 0
  if (!fits) return refuse('chain.reserve_mismatch', block)
  return {
    ok: true,
    state: read.outcome === 'stands' ? 'accepted' : 'reserved',
    reserve: held.amount,
    block,
    bookings: read.bookings.flatMap((b) =>
      b.standing ? [{ reference: { ...b.booking }, block: b.readAt }] : [],
    ),
  }
}

/** The checks bound to one chain, as `checkBeforeWork` gets them. */
export function serviceChecks(chain: CommitmentChain, now: () => bigint): ServiceChecks {
  return { verifyCommitment: (job) => verifyCommitment(job, chain, now()) }
}

/**
 * The chain at one block as a test or the eval holds it in memory, which a child process can't
 * read. The parent hands it over as data, and the checks read it through the same interfaces they
 * read a live chain through.
 */
export interface ChainSnapshot {
  chainId: number
  factory: Address
  block: PinnedBlock
  locks: {
    address: Address
    account: Address
    records: { commitmentId: Hex; side: Side; record: LockedBacking }[]
  }[]
}

/** A snapshot's chain, read as a live one is. */
export function snapshotChain(snapshot: ChainSnapshot): CommitmentChain {
  const lockAt = (lock: Address) => snapshot.locks.find((l) => isAddressEqual(l.address, lock))
  const recordOf = (lock: Address, commitmentId: Hex, side: Side) =>
    lockAt(lock)?.records.find(
      (r) => r.side === side && r.commitmentId.toLowerCase() === commitmentId.toLowerCase(),
    )?.record ?? null
  const reader: PinnedLockReader = {
    chainId: snapshot.chainId,
    factory: snapshot.factory,
    head: async () => snapshot.block,
    blockHash: async (n) => (n === snapshot.block.number ? snapshot.block.hash : null),
    isLock: async (lock) => lockAt(lock) !== undefined,
    lockFields: async (lock) => {
      const found = lockAt(lock)
      if (!found) throw new Error(`No contract at ${lock}`)
      return { factory: snapshot.factory, account: found.account }
    },
    commitment: async (lock, commitmentId, side): Promise<DependencyRecord | null> => {
      const r = recordOf(lock, commitmentId, side)
      return r
        ? {
            state: r.state,
            hasReport: r.hasReport,
            termsHash: r.termsHash,
            supplier: r.supplier,
            freeCancelBy: r.freeCancelBy,
          }
        : null
    },
  }
  return {
    readers: [reader],
    backing: async (lock, commitmentId, side) => recordOf(lock, commitmentId, side),
  }
}

/** The references of a job's commitment and its bookings, whose records a snapshot has to hold. */
export const snapshotReferences = (job: ReservedJob): CommitmentReference[] => [
  job.commitment,
  ...job.verification.dependencies.map((d) => d.on),
]
