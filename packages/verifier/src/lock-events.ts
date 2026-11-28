import {
  type BlockEvent,
  LOCK_LOG_ABI,
  lockReceiptEvents,
  type ReceiptLog,
} from '@avow-finance/spec'
import { type Address, type Client, type Hex, toEventSelector } from 'viem'
import { getBlock, getLogs, getTransactionReceipt } from 'viem/actions'

/**
 * The most blocks one log query covers. RPC endpoints refuse a query over too wide a range, and
 * ten thousand blocks sits well inside the limits public endpoints set.
 */
export const LOCK_EVENTS_RANGE = 10_000n

/** The most log queries one read makes, so one read covers at most 100,000 blocks. */
export const LOCK_EVENTS_QUERIES = 10

/** What a read of the chain needs: the final block, a lock's logs for one commitment, a receipt. */
export interface LockEventSource {
  chainId: number
  /** The latest final block's number and time. */
  finalBlock(): Promise<{ number: bigint; at: bigint }>
  /** A block's time, in unix seconds, for finding where a commitment starts. */
  blockTime(number: bigint): Promise<bigint>
  /** The transactions in which the lock logged anything for the commitment, between two blocks. */
  transactions(lock: Address, commitmentId: Hex, from: bigint, to: bigint): Promise<Hex[]>
  /** A transaction's block, the block's time and every log in its receipt. */
  receipt(hash: Hex): Promise<{ blockNumber: bigint; at: bigint; logs: ReceiptLog[] }>
}

/** What one read found, and where the next one starts. */
export interface LockEventsRead {
  /** The commitment's events in the blocks read, in the order the lock logged them. */
  events: BlockEvent[]
  /** The last block read. */
  readTo: bigint
  /** Where to read from next, or null once the read reached the final block. */
  next: bigint | null
  /**
   * The place of each log of the lock for the commitment that makes no event this package can
   * write, so a reader knows it holds a step it can't state.
   */
  unread: { transactionHash: Hex; logIndex: number }[]
}

/**
 * Reads what the lock logged for one commitment from the chain, from block `from`, through final
 * blocks only, so no event names a log a reorganization drops. A read covers at most
 * `LOCK_EVENTS_QUERIES` queries of `LOCK_EVENTS_RANGE` blocks, so a long-lived lock never meets an
 * endpoint's limits, and `next` says where to carry on.
 *
 * It reads the lock and nothing else. Avow's own records, such as an approval it signed, aren't
 * logged by a lock and never appear here. An event is a notice: it grants nothing, and it's true
 * only as far as the lock it was read from is the lock you think it is, which `findCommitment`
 * checks.
 */
export async function readLockEvents(
  source: LockEventSource,
  r: { lock: Address; commitmentId: Hex; from: bigint },
): Promise<LockEventsRead> {
  const final = await source.finalBlock()
  if (r.from > final.number) return { events: [], readTo: r.from - 1n, next: r.from, unread: [] }
  const hashes: Hex[] = []
  let at = r.from
  for (let q = 0; q < LOCK_EVENTS_QUERIES && at <= final.number; q++) {
    const to = minimum(at + LOCK_EVENTS_RANGE - 1n, final.number)
    for (const h of await source.transactions(r.lock, r.commitmentId, at, to)) {
      if (!hashes.includes(h.toLowerCase() as Hex)) hashes.push(h.toLowerCase() as Hex)
    }
    at = to + 1n
  }
  const id = r.commitmentId.toLowerCase()
  const events: BlockEvent[] = []
  const unread: LockEventsRead['unread'] = []
  for (const hash of hashes) {
    const receipt = await source.receipt(hash)
    const read = lockReceiptEvents(receipt.logs, {
      chainId: source.chainId,
      lock: r.lock,
      blockNumber: receipt.blockNumber,
      at: receipt.at,
      transactionHash: hash,
    })
    events.push(...read.events.filter((e) => e.commitment.commitmentId === id))
    // A log the receipt couldn't state counts only when it names this commitment.
    for (const i of read.unread) {
      const log = receipt.logs.find((l) => l.logIndex === i)
      if (log?.topics[1]?.toLowerCase() === id) unread.push({ transactionHash: hash, logIndex: i })
    }
  }
  events.sort((a, b) =>
    a.blockNumber === b.blockNumber
      ? a.logIndex - b.logIndex
      : a.blockNumber < b.blockNumber
        ? -1
        : 1,
  )
  const readTo = at - 1n
  return { events, readTo, next: readTo >= final.number ? null : readTo + 1n, unread }
}

/**
 * The first block whose time is at or after `time`, found by halving the range between the first
 * block and the final one, so a read can start where a commitment did with a few dozen reads.
 */
export async function firstBlockAt(source: LockEventSource, time: bigint): Promise<bigint> {
  const final = await source.finalBlock()
  if (final.at < time) return final.number
  let low = 0n
  let high = final.number
  while (low < high) {
    const mid = (low + high) / 2n
    if ((await source.blockTime(mid)) < time) low = mid + 1n
    else high = mid
  }
  return low
}

const minimum = (a: bigint, b: bigint) => (a < b ? a : b)

/** The first topic of each of the lock's logs, any of which a commitment's step can leave. */
const SELECTORS = LOCK_LOG_ABI.filter((item) => item.type === 'event').map((e) =>
  toEventSelector(e),
)

/** The source for a Tempo node, through a viem client. */
export function tempoLockEventSource(client: Client, chainId: number): LockEventSource {
  return {
    chainId,
    async finalBlock() {
      const block = await getBlock(client, { blockTag: 'finalized' })
      if (block.number === null) throw new Error('The node named no final block')
      return { number: block.number, at: block.timestamp }
    },
    async blockTime(number) {
      return (await getBlock(client, { blockNumber: number })).timestamp
    },
    async transactions(lock, commitmentId, from, to) {
      const logs = await getLogs(client, {
        address: lock,
        // Every log of the lock names the commitment as its first indexed argument.
        topics: [SELECTORS, commitmentId],
        fromBlock: from,
        toBlock: to,
      } as Parameters<typeof getLogs>[1])
      return logs.flatMap((l) => (l.transactionHash ? [l.transactionHash] : []))
    },
    async receipt(hash) {
      const receipt = await getTransactionReceipt(client, { hash })
      const block = await getBlock(client, { blockNumber: receipt.blockNumber })
      return {
        blockNumber: receipt.blockNumber,
        at: block.timestamp,
        logs: receipt.logs.map((l) => ({
          address: l.address,
          logIndex: l.logIndex,
          topics: l.topics,
          data: l.data,
        })),
      }
    },
  }
}
