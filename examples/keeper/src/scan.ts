import type { Address } from 'viem'
import {
  type BlockRange,
  type CommitmentSide,
  type KeeperChain,
  TooManyLogsError,
} from './chain.js'
import { OUT_OF_TIME, reasonOf, type Unread } from './report.js'

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
 * seconds and timed out on one naming 5,000, so a query names 1,000 locks at most. It refuses a
 * query that would return more than 20,000 logs too, and the keeper splits that range.
 */
export const MODERATO_LOG_LIMITS: LogLimits = { blocks: 100_000n, addresses: 1_000 }

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

/** Splits items into consecutive groups of at most `size`. */
export function groups<T>(items: readonly T[], size: number): T[][] {
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

/** Why a block a split can't make smaller stays unread. */
const CROWDED = 'it holds more logs than the node returns in one answer'

/** Whether two unread parts are the same kind of gap, so one can extend the other. */
const sameGap = (a: Unread, b: Unread) =>
  a.part === b.part &&
  a.reason === b.reason &&
  (a.part === 'factory' || (b.part === 'locks' && a.locks === b.locks))

/** Adds a part left unread, joined to the last one when it carries on from it for the same reason. */
function leave(unread: Unread[], next: Unread) {
  const last = unread.at(-1)
  if (last && sameGap(last, next) && last.range.to + 1n === next.range.from) {
    unread[unread.length - 1] = { ...last, range: { from: last.range.from, to: next.range.to } }
  } else {
    unread.push(next)
  }
}

/** What reading a range found, with each block that held more logs than one answer carries. */
export interface Read<T> {
  logs: T[]
  crowded: TooManyLogsError[]
}

/**
 * Every log `read` finds in the range, in block order. While the node answers that a range holds
 * too many logs for one answer, it reads each half on its own, so a range crowded with logs slows
 * the search without stopping it. A single block that still holds too many is left out and named
 * in `crowded`. Any other failure throws.
 */
export async function readAll<T>(
  range: BlockRange,
  read: (range: BlockRange) => Promise<T[]>,
): Promise<Read<T>> {
  try {
    return { logs: await read(range), crowded: [] }
  } catch (error) {
    if (!(error instanceof TooManyLogsError)) throw error
    if (range.from === range.to) return { logs: [], crowded: [error] }
    const middle = (range.from + range.to) / 2n
    const lower = await readAll({ from: range.from, to: middle }, read)
    const upper = await readAll({ from: middle + 1n, to: range.to }, read)
    return { logs: [...lower.logs, ...upper.logs], crowded: [...lower.crowded, ...upper.crowded] }
  }
}

/** What reading part of the chain found, and the parts it couldn't read. */
export interface Found<T> {
  found: T
  unread: Unread[]
}

/**
 * Every lock the factory created in the range, in the order it created them. A query that fails
 * leaves its own blocks unread and the search goes on. Once `inTime` says no, it starts no query
 * and leaves the rest of the range unread.
 */
export async function findLocks(
  chain: KeeperChain,
  factory: Address,
  range: BlockRange,
  limits: LogLimits,
  inTime: () => boolean,
): Promise<Found<Address[]>> {
  const locks = new Map<string, Address>()
  const unread: Unread[] = []
  for (const part of chunks(range, limits.blocks)) {
    if (!inTime()) {
      leave(unread, {
        part: 'factory',
        range: { from: part.from, to: range.to },
        reason: OUT_OF_TIME,
      })
      break
    }
    try {
      const read = await readAll(part, (r) => chain.locksCreated(factory, r))
      for (const lock of read.logs) locks.set(lock.toLowerCase(), lock)
      for (const e of read.crowded)
        leave(unread, { part: 'factory', range: e.range, reason: CROWDED })
    } catch (e) {
      leave(unread, { part: 'factory', range: part, reason: reasonOf(e) })
    }
  }
  return { found: [...locks.values()], unread }
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
 * `TRANSITIONS` say, so one ending is enough to skip a side. A query that fails leaves its blocks
 * unread, and once `inTime` says no, it starts no query and leaves the rest unread.
 */
export async function findSides(
  chain: KeeperChain,
  locks: readonly Address[],
  range: BlockRange,
  limits: LogLimits,
  inTime: () => boolean,
): Promise<Found<Sides>> {
  const reserved = new Map<string, CommitmentSide>()
  const ended = new Set<string>()
  const unread: Unread[] = []
  const skip = (from: bigint, to: bigint, reason: string) =>
    leave(unread, { part: 'locks', locks: locks.length, range: { from, to }, reason })
  for (const part of chunks(range, limits.blocks)) {
    if (!inTime()) {
      skip(part.from, range.to, OUT_OF_TIME)
      break
    }
    try {
      const read = await readAll(part, (r) => chain.sideEvents(locks, r))
      for (const { kind, ...side } of read.logs) {
        if (kind === 'reserved') reserved.set(keyOf(side), side)
        else ended.add(keyOf(side))
      }
      for (const e of read.crowded) skip(e.range.from, e.range.to, CROWDED)
    } catch (e) {
      skip(part.from, part.to, reasonOf(e))
    }
  }
  const open = [...reserved].filter(([key]) => !ended.has(key)).map(([, side]) => side)
  return { found: { reserved: reserved.size, open }, unread }
}
