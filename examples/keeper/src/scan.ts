import type { Address } from 'viem'
import type { BlockRange, CommitmentSide, KeeperChain } from './chain.js'

/** How much one log query may ask of the node. */
export interface LogLimits {
  /** The most blocks one query covers, both ends included. */
  blocks: bigint
  /** The most contracts one query names. */
  addresses: number
}

/**
 * Moderato's public RPC refuses a log query whose last block is more than 100,000 past its first,
 * so a query here covers 100,000 blocks. It answered a query naming 2,000 contracts in a few
 * seconds and timed out on one naming 5,000, so a query names 500 locks at most. It also refuses a
 * query that would return more than 20,000 logs, and a run that meets that limit fails with the
 * node's message, so no log goes unread.
 */
export const MODERATO_LOG_LIMITS: LogLimits = { blocks: 100_000n, addresses: 500 }

/** Splits a range into consecutive ranges of at most `size` blocks that cover it exactly. */
export function chunks(range: BlockRange, size: bigint): BlockRange[] {
  if (size < 1n) throw new RangeError('A log query has to cover at least one block')
  const parts: BlockRange[] = []
  for (let from = range.from; from <= range.to; from += size) {
    const last = from + size - 1n
    parts.push({ from, to: last < range.to ? last : range.to })
  }
  return parts
}

function groups<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) {
    throw new RangeError('A log query has to name at least one contract')
  }
  const parts: T[][] = []
  for (let i = 0; i < items.length; i += size) parts.push(items.slice(i, i + size))
  return parts
}

/**
 * The first block in the range whose time is at or after `time`. The range's last block has to be
 * at or after it, as the latest block is for any time before it.
 */
export async function firstBlockSince(
  chain: KeeperChain,
  time: bigint,
  range: BlockRange,
): Promise<bigint> {
  if ((await chain.timestampOf(range.from)) >= time) return range.from
  // The block at `before` is earlier than the time, and the block at `since` isn't.
  let before = range.from
  let since = range.to
  while (since - before > 1n) {
    const middle = (before + since) / 2n
    if ((await chain.timestampOf(middle)) >= time) since = middle
    else before = middle
  }
  return since
}

/** Every lock the factory created in the range, in the order it created them. */
export async function findLocks(
  chain: KeeperChain,
  factory: Address,
  range: BlockRange,
  limits: LogLimits,
): Promise<Address[]> {
  const locks = new Map<string, Address>()
  for (const part of chunks(range, limits.blocks)) {
    for (const lock of await chain.locksCreated(factory, part)) locks.set(lock.toLowerCase(), lock)
  }
  return [...locks.values()]
}

/** How many sides were reserved in a range, and those of them that haven't ended. */
export interface Sides {
  reserved: number
  open: CommitmentSide[]
}

const keyOf = (s: CommitmentSide) =>
  `${s.lock.toLowerCase()}:${s.commitmentId.toLowerCase()}:${s.side}`

/**
 * Every side reserved on the locks in the range, and those of them that no release, charge or
 * resolution has ended. A side's end always comes after its reserve, so the range holds the end of
 * every side it holds the reserve of, up to its last block. An ending moves nowhere, as the spec's
 * `TRANSITIONS` say, so one ending is enough to skip a side.
 */
export async function findSides(
  chain: KeeperChain,
  locks: readonly Address[],
  range: BlockRange,
  limits: LogLimits,
): Promise<Sides> {
  const reserved = new Map<string, CommitmentSide>()
  const ended = new Set<string>()
  for (const group of groups(locks, limits.addresses)) {
    for (const part of chunks(range, limits.blocks)) {
      for (const { kind, ...side } of await chain.sideEvents(group, part)) {
        if (kind === 'reserved') reserved.set(keyOf(side), side)
        else ended.add(keyOf(side))
      }
    }
  }
  return {
    reserved: reserved.size,
    open: [...reserved].filter(([key]) => !ended.has(key)).map(([, side]) => side),
  }
}
