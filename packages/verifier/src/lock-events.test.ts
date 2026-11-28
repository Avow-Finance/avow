import { type LockLogName, lockLogSignature, type ReceiptLog } from '@avow-finance/spec'
import {
  type AbiEvent,
  type Address,
  encodeAbiParameters,
  encodeEventTopics,
  type Hex,
  parseAbiItem,
} from 'viem'
import { describe, expect, it } from 'vitest'
import {
  firstBlockAt,
  LOCK_EVENTS_QUERIES,
  LOCK_EVENTS_RANGE,
  type LockEventSource,
  readLockEvents,
} from './lock-events.js'

const LOCK = '0x00000000000000000000000000000000000010c4' as Address
const h = (byte: string): Hex => `0x${byte.repeat(32)}`
const ID = h('c1')
const OTHER = h('c2')

/** One of the lock's logs, as a receipt holds it. */
function log(name: LockLogName, args: Record<string, unknown>, logIndex: number): ReceiptLog {
  const event = parseAbiItem(lockLogSignature(name)) as AbiEvent
  const topics = encodeEventTopics({
    abi: [event],
    eventName: name,
    args: { commitmentId: args.commitmentId },
  } as never) as Hex[]
  const data = event.inputs.filter((input) => !input.indexed)
  return {
    address: LOCK,
    logIndex,
    topics,
    data: encodeAbiParameters(
      data,
      data.map((input) => args[input.name ?? '']),
    ),
  }
}

const reserved = (commitmentId: Hex, logIndex = 0) =>
  log(
    'Reserved',
    {
      commitmentId,
      side: 0,
      termsHash: h('7e'),
      mandateHash: h('3a'),
      amount: 500_000_000n,
      supplier: '0x00000000000000000000000000000000000000aa',
      payout: '0x00000000000000000000000000000000000000bb',
      fundedBy: '0x00000000000000000000000000000000000000cc',
      approvalNonce: 1n,
      approvalHash: h('a9'),
    },
    logIndex,
  )
const accepted = (commitmentId: Hex, logIndex = 0) =>
  log('Accepted', { commitmentId, side: 0, termsHash: h('7e'), acceptanceHash: h('ad') }, logIndex)

/** A chain of `final` blocks a second apart, holding the receipts given, read as a node would. */
function chain(
  final: bigint,
  receipts: Record<Hex, { blockNumber: bigint; logs: ReceiptLog[] }>,
): LockEventSource & { queries: [bigint, bigint][] } {
  const queries: [bigint, bigint][] = []
  return {
    chainId: 42431,
    queries,
    finalBlock: async () => ({ number: final, at: 1_000n + final }),
    blockTime: async (n) => 1_000n + n,
    async transactions(lock, commitmentId, from, to) {
      queries.push([from, to])
      return Object.entries(receipts)
        .filter(
          ([, r]) =>
            r.blockNumber >= from &&
            r.blockNumber <= to &&
            r.logs.some((l) => l.address === lock && l.topics[1] === commitmentId),
        )
        .map(([hash]) => hash as Hex)
    },
    async receipt(hash) {
      const r = receipts[hash]
      if (!r) throw new Error('no receipt')
      return { blockNumber: r.blockNumber, at: 1_000n + r.blockNumber, logs: r.logs }
    },
  }
}

describe('readLockEvents', () => {
  it("reads one commitment's events from its receipts, oldest first, and no other commitment's", async () => {
    const source = chain(500n, {
      [h('02')]: { blockNumber: 300n, logs: [accepted(ID, 3), accepted(OTHER, 4)] },
      [h('01')]: { blockNumber: 100n, logs: [reserved(OTHER, 0), reserved(ID, 1)] },
    })
    const read = await readLockEvents(source, { lock: LOCK, commitmentId: ID, from: 0n })
    expect(read.events.map((e) => [e.code, e.blockNumber, e.logIndex])).toEqual([
      ['reserve.locked', 100n, 1],
      ['reserve.accepted', 300n, 3],
    ])
    expect(read.events.every((e) => e.commitment.commitmentId === ID)).toBe(true)
    expect(read.events[0]?.at).toBe(1_100n)
    expect(read).toMatchObject({ readTo: 500n, next: null, unread: [] })
  })

  it('reads only up to the final block, and in queries no wider than the range', async () => {
    const final = LOCK_EVENTS_RANGE * 3n
    const source = chain(final, {})
    await readLockEvents(source, { lock: LOCK, commitmentId: ID, from: 0n })
    expect(source.queries.length).toBe(4)
    for (const [from, to] of source.queries) expect(to - from + 1n <= LOCK_EVENTS_RANGE).toBe(true)
    expect(source.queries.at(-1)?.[1]).toBe(final)
  })

  it('stops after a bounded number of queries on a long-lived lock, and says where to carry on', async () => {
    const final = LOCK_EVENTS_RANGE * BigInt(LOCK_EVENTS_QUERIES) * 2n
    const source = chain(final, {})
    const first = await readLockEvents(source, { lock: LOCK, commitmentId: ID, from: 0n })
    expect(source.queries.length).toBe(LOCK_EVENTS_QUERIES)
    const readTo = LOCK_EVENTS_RANGE * BigInt(LOCK_EVENTS_QUERIES) - 1n
    expect(first).toMatchObject({ readTo, next: readTo + 1n })
    const second = await readLockEvents(source, {
      lock: LOCK,
      commitmentId: ID,
      from: first.next ?? 0n,
    })
    expect(source.queries[LOCK_EVENTS_QUERIES]?.[0]).toBe(readTo + 1n)
    expect(second.next).toBe(final)
    const third = await readLockEvents(source, { lock: LOCK, commitmentId: ID, from: final })
    expect(third).toMatchObject({ readTo: final, next: null })
  })

  it('reads nothing past the final block when asked to start beyond it', async () => {
    const source = chain(10n, {})
    expect(await readLockEvents(source, { lock: LOCK, commitmentId: ID, from: 11n })).toEqual({
      events: [],
      readTo: 10n,
      next: 11n,
      unread: [],
    })
    expect(source.queries).toEqual([])
  })

  it("names a log of the commitment that makes no event, and leaves another commitment's alone", async () => {
    const broken = { ...accepted(ID, 2), data: '0x' as Hex }
    const elsewhere = { ...accepted(OTHER, 3), data: '0x' as Hex }
    const source = chain(50n, { [h('03')]: { blockNumber: 20n, logs: [broken, elsewhere] } })
    const read = await readLockEvents(source, { lock: LOCK, commitmentId: ID, from: 0n })
    expect(read.events).toEqual([])
    expect(read.unread).toEqual([{ transactionHash: h('03'), logIndex: 2 }])
  })
})

describe('firstBlockAt', () => {
  it('finds the first block at or after a time', async () => {
    const source = chain(1_000n, {})
    expect(await firstBlockAt(source, 1_250n)).toBe(250n)
    expect(await firstBlockAt(source, 0n)).toBe(0n)
    expect(await firstBlockAt(source, 99_999n)).toBe(1_000n)
  })
})
