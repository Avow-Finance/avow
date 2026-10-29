import type { Hex } from 'viem'
import { describe, expect, it } from 'vitest'
import type { CommitmentSide } from './chain.js'
import { keep } from './keeper.js'
import { needsAttention } from './report.js'
import { commitment, EXPLORER, FACTORY, lockAt } from './test/fixtures.js'
import { landedHash, type Script, scriptedChain } from './test/scripted-chain.js'

// One second a block. The factory was created at block 100, the latest block is 1,000, and the
// keeper looks back 600 seconds for commitments, so it reads them from block 400 on.
const [L1, L2, L3] = [lockAt(1), lockAt(2), lockAt(3)]
const side = (lock: typeof L1, n: number, s: 'buyer' | 'supplier'): CommitmentSide => ({
  lock,
  commitmentId: commitment(n),
  side: s,
})
const RELEASED = side(L1, 1, 'buyer')
const CHARGED = side(L2, 2, 'supplier')
const RESOLVED = side(L1, 3, 'buyer')
const OPEN = side(L1, 4, 'buyer')
const OTHER = side(L2, 5, 'buyer')
const BEFORE_LOOKBACK = side(L1, 6, 'buyer')

const factory: Script = {
  head: 1000n,
  maxSpan: 99n,
  locks: [
    { lock: L1, block: 150n },
    { lock: L2, block: 450n },
    { lock: L3, block: 999n },
  ],
  events: [
    { ...BEFORE_LOOKBACK, kind: 'reserved', block: 300n },
    { ...RELEASED, kind: 'reserved', block: 420n },
    { ...CHARGED, kind: 'reserved', block: 460n },
    { ...RESOLVED, kind: 'reserved', block: 470n },
    { ...OPEN, kind: 'reserved', block: 480n },
    { ...OTHER, kind: 'reserved', block: 490n },
    { ...RELEASED, kind: 'ended', block: 500n },
    { ...CHARGED, kind: 'ended', block: 600n },
    { ...RESOLVED, kind: 'ended', block: 700n },
  ],
}

async function run(change: Partial<Script> = {}, startBlock = 100n) {
  const { chain, recorded } = scriptedChain({ ...factory, ...change })
  const lines: string[] = []
  const report = await keep({
    chain,
    factory: FACTORY,
    startBlock,
    lookback: 600n,
    limits: { blocks: 100n, addresses: 10 },
    explorer: EXPLORER,
    log: (line) => lines.push(line),
  })
  return { report, recorded, lines }
}

const which = (s: CommitmentSide) => `${s.commitmentId} (${s.side}) on lock ${s.lock}`

describe('a keeper run', () => {
  it('simulates only the sides that have not ended, and sends only the ones whose simulation succeeds', async () => {
    const { report, recorded, lines } = await run({ due: [OPEN] })
    expect(recorded.simulated).toEqual([OPEN, OTHER])
    expect(recorded.funded).toBe(1)
    expect(recorded.sent).toEqual([OPEN])
    expect(report).toMatchObject({
      locksFrom: 100n,
      commitmentsFrom: 400n,
      to: 1000n,
      locks: 3,
      reserved: 5,
      open: 2,
      due: 1,
      results: [{ ...OPEN, outcome: 'sent', hash: landedHash(OPEN) }],
    })
    expect(needsAttention(report)).toBe(false)
    expect(lines).toEqual([
      `sent the step due for ${which(OPEN)}: ${EXPLORER}/tx/${landedHash(OPEN)}`,
      'checked 3 locks created in blocks 100 to 1000 and 5 sides reserved in blocks 400 to 1000: 2 open, 1 due, 1 sent, 0 taken by another sender, 0 failed, 0 unknown, 0 unchecked',
    ])
  })

  it('searches every block since the start for locks, and the lookback alone for commitments', async () => {
    const { recorded } = await run()
    expect(recorded.lockQueries[0]).toEqual({ from: 100n, to: 199n })
    expect(recorded.lockQueries.at(-1)).toEqual({ from: 1000n, to: 1000n })
    expect(recorded.sideQueries[0]?.range).toEqual({ from: 400n, to: 499n })
    expect(recorded.simulated).not.toContainEqual(BEFORE_LOOKBACK)
  })

  it('asks the faucet for nothing and sends nothing when no step is due', async () => {
    const { report, recorded, lines } = await run()
    expect(recorded.simulated).toEqual([OPEN, OTHER])
    expect(recorded.funded).toBe(0)
    expect(recorded.sent).toEqual([])
    expect(report.results).toEqual([])
    expect(lines).toHaveLength(1)
  })

  it('counts a step another sender took first as taken, and a step still due as failed', async () => {
    const { report, lines } = await run({
      due: [OPEN, OTHER],
      takenFirst: [OPEN],
      send: () => ({ outcome: 'failed', reason: 'The transaction 0xab reverted' }),
    })
    expect(report.results).toEqual([
      { ...OPEN, outcome: 'taken' },
      { ...OTHER, outcome: 'failed', reason: 'The transaction 0xab reverted' },
    ])
    expect(needsAttention(report)).toBe(true)
    expect(lines.slice(0, 2)).toEqual([
      `another sender took the step due for ${which(OPEN)} first`,
      `could not send the step due for ${which(OTHER)}: The transaction 0xab reverted`,
    ])
  })

  it('reports a transaction whose outcome is unknown with each of its hashes, for a person to look at', async () => {
    const hashes: Hex[] = [`0x${'01'.repeat(32)}`, `0x${'02'.repeat(32)}`]
    const { report, lines } = await run({
      due: [OPEN],
      send: () => ({ outcome: 'unknown', reason: 'No receipt after waiting', hashes }),
    })
    expect(report.results).toEqual([
      { ...OPEN, outcome: 'unknown', reason: 'No receipt after waiting', hashes },
    ])
    expect(needsAttention(report)).toBe(true)
    expect(lines[0]).toBe(
      `sent the step due for ${which(OPEN)}, and its outcome is unknown, so the next run reads the chain again: ${EXPLORER}/tx/${hashes[0]} ${EXPLORER}/tx/${hashes[1]} (No receipt after waiting)`,
    )
  })

  it('reports a side it could not simulate, and still sends the steps that are due', async () => {
    const { report, recorded } = await run({ due: [OPEN], unanswered: [OTHER] })
    expect(recorded.sent).toEqual([OPEN])
    expect(report.results).toEqual([
      { ...OTHER, outcome: 'unchecked', reason: 'HTTP request failed. 502 Bad Gateway' },
      { ...OPEN, outcome: 'sent', hash: landedHash(OPEN) },
    ])
    expect(needsAttention(report)).toBe(true)
  })

  it('sends nothing when the faucet does not fund the key, and says so for each step due', async () => {
    const { report, recorded } = await run({ due: [OPEN, OTHER], faucetFails: true })
    expect(recorded.sent).toEqual([])
    const reason = "the faucet didn't fund the key: the faucet is resting"
    expect(report.results).toEqual([
      { ...OPEN, outcome: 'failed', reason },
      { ...OTHER, outcome: 'failed', reason },
    ])
  })

  it('refuses a start block past the latest block', async () => {
    await expect(run({}, 1001n)).rejects.toThrow('The start block 1001 is past the latest block')
  })
})
