import { describe, expect, it } from 'vitest'
import { type BlockRange, TooManyLogsError } from './chain.js'
import { chunks, findLocks, findSides, firstBlockSince, groups, readAll } from './scan.js'
import { commitment, FACTORY, lockAt } from './test/fixtures.js'
import { scriptedChain } from './test/scripted-chain.js'

// A node that refuses a query whose last block is more than 9 past its first, and limits that
// cover 10 blocks a query, so the boundaries fall at blocks ending in 9 and 0.
const LIMITS = { blocks: 10n, addresses: 2 }
const MAX_SPAN = 9n
const always = () => true

/** Whether the ranges cover `whole` exactly, in order, each within the node's limit. */
function tiles(ranges: BlockRange[], whole: BlockRange) {
  let next = whole.from
  for (const r of ranges) {
    if (r.from !== next || r.to < r.from || r.to - r.from > MAX_SPAN) return false
    next = r.to + 1n
  }
  return next === whole.to + 1n
}

describe('chunks and groups', () => {
  it('cover a range exactly, in order, each with at most the size of blocks', () => {
    expect(chunks({ from: 10n, to: 34n }, 10n)).toEqual([
      { from: 10n, to: 19n },
      { from: 20n, to: 29n },
      { from: 30n, to: 34n },
    ])
    expect(chunks({ from: 7n, to: 7n }, 10n)).toEqual([{ from: 7n, to: 7n }])
    expect(chunks({ from: 0n, to: 9n }, 10n)).toEqual([{ from: 0n, to: 9n }])
    expect(chunks({ from: 0n, to: 10n }, 10n)).toEqual([
      { from: 0n, to: 9n },
      { from: 10n, to: 10n },
    ])
    expect(() => chunks({ from: 0n, to: 10n }, 0n)).toThrow(RangeError)
  })

  it('split items into groups of at most the size, in order', () => {
    expect(groups([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(groups([], 2)).toEqual([])
    expect(() => groups([1], 0)).toThrow(RangeError)
  })
})

describe('reading a range', () => {
  it('halves a range the node holds too many logs for, until each part fits, in block order', async () => {
    const asked: BlockRange[] = []
    const logs = [100n, 101n, 102n, 103n, 107n]
    const read = async (range: BlockRange) => {
      asked.push(range)
      const found = logs.filter((b) => b >= range.from && b <= range.to)
      if (found.length > 2) throw new TooManyLogsError(range)
      return found
    }
    expect(await readAll({ from: 100n, to: 109n }, read)).toEqual({ logs, crowded: [] })
    expect(asked[0]).toEqual({ from: 100n, to: 109n })
    expect(asked.slice(1)).toEqual([
      { from: 100n, to: 104n },
      { from: 100n, to: 102n },
      { from: 100n, to: 101n },
      { from: 102n, to: 102n },
      { from: 103n, to: 104n },
      { from: 105n, to: 109n },
    ])
  })

  it('names a block that alone holds too many logs, keeps the rest, and throws any other failure', async () => {
    const read = async (range: BlockRange) => {
      if (range.from <= 5n && range.to >= 5n) throw new TooManyLogsError(range)
      return [range.from]
    }
    const { logs, crowded } = await readAll({ from: 4n, to: 7n }, read)
    expect(logs).toEqual([4n, 6n])
    expect(crowded.map((e) => e.range)).toEqual([{ from: 5n, to: 5n }])
    const down = async (): Promise<bigint[]> => {
      throw new Error('HTTP request failed. 502 Bad Gateway')
    }
    await expect(readAll({ from: 5n, to: 6n }, down)).rejects.toThrow('502')
  })
})

describe('finding locks', () => {
  it('finds a lock on each side of every chunk boundary, each query inside the node limit', async () => {
    const created = [100n, 109n, 110n, 119n, 120n, 125n]
    const { chain, recorded } = scriptedChain({
      head: 125n,
      maxSpan: MAX_SPAN,
      locks: created.map((block, i) => ({ lock: lockAt(i + 1), block })),
    })
    const whole = { from: 100n, to: 125n }
    const { found, unread } = await findLocks(chain, FACTORY, whole, LIMITS, always)
    expect(found).toEqual(created.map((_, i) => lockAt(i + 1)))
    expect(unread).toEqual([])
    expect(tiles(recorded.lockQueries, whole)).toBe(true)
  })

  it('finds every lock in a chunk that holds more than one query may return', async () => {
    // Anyone can create locks, so a chunk can hold more than the node returns at once.
    const created = [101n, 102n, 103n, 104n, 105n, 106n, 107n]
    const { chain } = scriptedChain({
      head: 110n,
      maxSpan: MAX_SPAN,
      maxResults: 2,
      locks: created.map((block, i) => ({ lock: lockAt(i + 1), block })),
    })
    const { found, unread } = await findLocks(
      chain,
      FACTORY,
      { from: 100n, to: 110n },
      LIMITS,
      always,
    )
    expect(found).toEqual(created.map((_, i) => lockAt(i + 1)))
    expect(unread).toEqual([])
  })

  it('leaves a block it cannot read unread, and reads the rest', async () => {
    // Three locks in block 104 are more than one answer holds, so that block can't be read.
    const { chain } = scriptedChain({
      head: 125n,
      maxSpan: MAX_SPAN,
      maxResults: 2,
      locks: [
        { lock: lockAt(1), block: 100n },
        { lock: lockAt(2), block: 104n },
        { lock: lockAt(3), block: 104n },
        { lock: lockAt(4), block: 104n },
        { lock: lockAt(5), block: 120n },
      ],
    })
    const { found, unread } = await findLocks(
      chain,
      FACTORY,
      { from: 100n, to: 125n },
      LIMITS,
      always,
    )
    expect(found).toEqual([lockAt(1), lockAt(5)])
    expect(unread).toEqual([
      {
        part: 'factory',
        range: { from: 104n, to: 104n },
        reason: 'it holds more logs than the node returns in one answer',
      },
    ])
  })

  it('starts no query once time is up, and leaves the rest of the range unread', async () => {
    const { chain, recorded } = scriptedChain({
      head: 125n,
      maxSpan: MAX_SPAN,
      locks: [{ lock: lockAt(1), block: 125n }],
    })
    let queries = 0
    const inTime = () => queries++ < 2
    const { found, unread } = await findLocks(
      chain,
      FACTORY,
      { from: 100n, to: 125n },
      LIMITS,
      inTime,
    )
    expect(found).toEqual([])
    expect(recorded.lockQueries).toHaveLength(2)
    expect(unread).toEqual([
      { part: 'factory', range: { from: 120n, to: 125n }, reason: 'the run ran out of time' },
    ])
  })
})

describe('finding sides', () => {
  const [L1, L2] = [lockAt(1), lockAt(2)]
  const side = (lock: typeof L1, n: number, s: 'buyer' | 'supplier') => ({
    lock,
    commitmentId: commitment(n),
    side: s,
  })

  it('follows each side across chunks, and keeps only the ones not ended', async () => {
    const { chain, recorded } = scriptedChain({
      head: 125n,
      maxSpan: MAX_SPAN,
      events: [
        // Reserved at the end of one chunk and released at the start of the next.
        { ...side(L1, 1, 'buyer'), kind: 'reserved', block: 109n },
        { ...side(L1, 1, 'buyer'), kind: 'ended', block: 110n },
        // Reserved at the start of a chunk, and still open.
        { ...side(L1, 2, 'buyer'), kind: 'reserved', block: 110n },
        // Reserved at the end of a chunk and charged in the next.
        { ...side(L2, 3, 'supplier'), kind: 'reserved', block: 119n },
        { ...side(L2, 3, 'supplier'), kind: 'ended', block: 120n },
        // One side of a commitment ends, and the other side stays open.
        { ...side(L2, 4, 'buyer'), kind: 'reserved', block: 100n },
        { ...side(L2, 4, 'supplier'), kind: 'reserved', block: 105n },
        { ...side(L2, 4, 'buyer'), kind: 'ended', block: 125n },
        // An ending whose reserve came before the range.
        { ...side(L2, 5, 'buyer'), kind: 'ended', block: 101n },
      ],
    })
    const whole = { from: 100n, to: 125n }
    const { found, unread } = await findSides(chain, [L1, L2], whole, LIMITS, always)
    expect(found.reserved).toBe(5)
    expect(found.open).toHaveLength(2)
    expect(found.open).toEqual(
      expect.arrayContaining([side(L1, 2, 'buyer'), side(L2, 4, 'supplier')]),
    )
    expect(unread).toEqual([])
    expect(
      tiles(
        recorded.sideQueries.map((q) => q.range),
        whole,
      ),
    ).toBe(true)
  })

  it('leaves the blocks of a failed query unread, and reads the rest', async () => {
    const { chain } = scriptedChain({
      head: 125n,
      maxSpan: MAX_SPAN,
      refused: [L2],
      events: [{ ...side(L2, 1, 'buyer'), kind: 'reserved', block: 101n }],
    })
    const { found, unread } = await findSides(chain, [L2], { from: 100n, to: 115n }, LIMITS, always)
    expect(found.open).toEqual([])
    // Both chunks failed the same way, so they read as one gap.
    expect(unread).toEqual([
      {
        part: 'locks',
        locks: 1,
        range: { from: 100n, to: 115n },
        reason: 'HTTP request failed. 502 Bad Gateway',
      },
    ])
  })
})

describe('the first block since a time', () => {
  it('is the first block whose time is at or after it', async () => {
    // Two seconds a block, with a gap of a minute after block 50.
    const timeOf = (b: bigint) => (b <= 50n ? b * 2n : b * 2n + 60n)
    const { chain } = scriptedChain({ head: 100n, maxSpan: MAX_SPAN, timeOf })
    const range = { from: 10n, to: 100n }
    expect(await firstBlockSince(chain, 51n, range)).toBe(26n)
    expect(await firstBlockSince(chain, 52n, range)).toBe(26n)
    expect(await firstBlockSince(chain, 101n, range)).toBe(51n)
    expect(await firstBlockSince(chain, 162n, range)).toBe(51n)
    expect(await firstBlockSince(chain, 163n, range)).toBe(52n)
    // A time before the range starts at its first block, and the latest block's time at itself.
    expect(await firstBlockSince(chain, 5n, range)).toBe(10n)
    expect(await firstBlockSince(chain, timeOf(100n), range)).toBe(100n)
  })
})
