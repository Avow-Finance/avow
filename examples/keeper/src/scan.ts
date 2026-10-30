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

/** A stretch of blocks a read left unread, and why. */
export interface Gap {
  range: BlockRange
  reason: string
}

/** Adds a gap, joined to the last one when it carries straight on from it for the same reason. */
function leave(gaps: Gap[], next: Gap) {
  const last = gaps.at(-1)
  if (last && last.reason === next.reason && last.range.to + 1n === next.range.from) {
    gaps[gaps.length - 1] = {
      reason: last.reason,
      range: { from: last.range.from, to: next.range.to },
    }
  } else {
    gaps.push(next)
  }
}

/** What reading a range found, and the stretches of it left unread. */
export interface Read<T> {
  logs: T[]
  gaps: Gap[]
}

/**
 * Every log `read` finds in the range, in block order, with the stretches it couldn't read. While
 * the node answers that a range holds too many logs for one answer, it reads each half on its own,
 * so a range crowded with logs slows the search without stopping it. It asks `inTime` before every
 * query, halves included. A single block that still holds too many, a query that fails and a query
 * there's no time for each leave only their own blocks unread, and every log read before them is
 * kept. It never throws.
 */
export async function readAll<T>(
  range: BlockRange,
  read: (range: BlockRange) => Promise<T[]>,
  inTime: () => boolean,
): Promise<Read<T>> {
  if (!inTime()) return { logs: [], gaps: [{ range, reason: OUT_OF_TIME }] }
  try {
    return { logs: await read(range), gaps: [] }
  } catch (error) {
    if (!(error instanceof TooManyLogsError)) {
      return { logs: [], gaps: [{ range, reason: reasonOf(error) }] }
    }
    if (range.from === range.to) return { logs: [], gaps: [{ range, reason: CROWDED }] }
    const middle = (range.from + range.to) / 2n
    const lower = await readAll({ from: range.from, to: middle }, read, inTime)
    const upper = await readAll({ from: middle + 1n, to: range.to }, read, inTime)
    const gaps: Gap[] = []
    for (const gap of [...lower.gaps, ...upper.gaps]) leave(gaps, gap)
    return { logs: lower.logs.concat(upper.logs), gaps }
  }
}

/**
 * Reads a range one chunk at a time, keeping every log and joining the gaps. Once time is up, each
 * chunk left is one more gap, so the rest of the range reads as a single gap.
 */
async function readChunks<T>(
  range: BlockRange,
  limits: LogLimits,
  read: (range: BlockRange) => Promise<T[]>,
  inTime: () => boolean,
): Promise<Read<T>> {
  let logs: T[] = []
  const gaps: Gap[] = []
  for (const part of chunks(range, limits.blocks)) {
    const found = await readAll(part, read, inTime)
    logs = logs.concat(found.logs)
    for (const gap of found.gaps) leave(gaps, gap)
  }
  return { logs, gaps }
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
  const read = await readChunks(range, limits, (r) => chain.locksCreated(factory, r), inTime)
  const locks = new Map<string, Address>()
  for (const lock of read.logs) locks.set(lock.toLowerCase(), lock)
  return {
    found: [...locks.values()],
    unread: read.gaps.map((gap): Unread => ({ part: 'factory', ...gap })),
  }
}

/** How many sides were reserved in a range, and those of them that haven't ended. */
export interface Sides {
  reserved: number
  /** In the order they were reserved. */
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
  const read = await readChunks(range, limits, (r) => chain.sideEvents(locks, r), inTime)
  const reserved = new Map<string, CommitmentSide>()
  const ended = new Set<string>()
  for (const { kind, ...side } of read.logs) {
    if (kind === 'reserved') reserved.set(keyOf(side), side)
    else ended.add(keyOf(side))
  }
  const open = [...reserved].filter(([key]) => !ended.has(key)).map(([, side]) => side)
  return {
    found: { reserved: reserved.size, open },
    unread: read.gaps.map((gap): Unread => ({ part: 'locks', locks: locks.length, ...gap })),
  }
}
