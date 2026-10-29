import { describe, expect, it } from 'vitest'
import type { BlockRange } from './chain.js'
import { chunks, findLocks, findSides, firstBlockSince } from './scan.js'
import { commitment, FACTORY, lockAt } from './test/fixtures.js'
import { scriptedChain } from './test/scripted-chain.js'

// A node that refuses a query whose last block is more than 9 past its first, and limits that
// cover 10 blocks a query, so the boundaries fall at blocks ending in 9 and 0.
const LIMITS = { blocks: 10n, addresses: 2 }
const MAX_SPAN = 9n

/** Whether the ranges cover `whole` exactly, in order, each within the node's limit. */
function tiles(ranges: BlockRange[], whole: BlockRange) {
  let next = whole.from
  for (const r of ranges) {
    if (r.from !== next || r.to < r.from || r.to - r.from > MAX_SPAN) return false
    next = r.to + 1n
  }
  return next === whole.to + 1n
}

describe('chunks', () => {
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
    expect(await findLocks(chain, FACTORY, whole, LIMITS)).toEqual(
      created.map((_, i) => lockAt(i + 1)),
    )
    expect(tiles(recorded.lockQueries, whole)).toBe(true)
  })

  it('fails when a query is over the node limit, so no block goes unread', async () => {
    const { chain } = scriptedChain({ head: 125n, maxSpan: MAX_SPAN })
    await expect(
      findLocks(chain, FACTORY, { from: 100n, to: 125n }, { ...LIMITS, blocks: 11n }),
    ).rejects.toThrow('query exceeds max block range 9')
  })
})

describe('finding sides', () => {
  const [L1, L2, L3] = [lockAt(1), lockAt(2), lockAt(3)]
  const side = (lock: typeof L1, n: number, s: 'buyer' | 'supplier') => ({
    lock,
    commitmentId: commitment(n),
    side: s,
  })

  it('follows each side across chunks and groups of locks, and keeps only the ones not ended', async () => {
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
        { ...side(L3, 4, 'buyer'), kind: 'reserved', block: 100n },
        { ...side(L3, 4, 'supplier'), kind: 'reserved', block: 105n },
        { ...side(L3, 4, 'buyer'), kind: 'ended', block: 125n },
        // An ending whose reserve came before the range.
        { ...side(L2, 5, 'buyer'), kind: 'ended', block: 101n },
      ],
    })
    const whole = { from: 100n, to: 125n }
    const sides = await findSides(chain, [L1, L2, L3], whole, LIMITS)
    expect(sides.reserved).toBe(5)
    expect(sides.open).toEqual([side(L1, 2, 'buyer'), side(L3, 4, 'supplier')])
    // Two locks a query at most, and each group's queries cover the whole range.
    const groups = [[L1, L2], [L3]]
    for (const group of groups) {
      const ranges = recorded.sideQueries
        .filter((q) => q.locks.join() === group.join())
        .map((q) => q.range)
      expect(tiles(ranges, whole)).toBe(true)
    }
    expect(recorded.sideQueries.every((q) => q.locks.length <= LIMITS.addresses)).toBe(true)
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
