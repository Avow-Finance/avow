import type { Address } from 'viem'
import type { CommitmentSide, KeeperChain } from './chain.js'
import {
  type KeeperReport,
  OUT_OF_TIME,
  reasonOf,
  resultLine,
  type StepResult,
  summaryLine,
  type Unread,
  unreadLine,
} from './report.js'
import { findLocks, findSides, firstBlockSince, groups, type LogLimits } from './scan.js'

/** What one run of the keeper needs. */
export interface KeeperRun {
  chain: KeeperChain
  /** The lock factory whose locks the keeper serves. */
  factory: Address
  /** The block the factory was created in, where the search for its locks starts. */
  startBlock: bigint
  /** How far back in the chain's time, in seconds, the keeper looks for commitments. */
  lookback: bigint
  limits: LogLimits
  /** The block explorer that each sent step's link points into. */
  explorer: string
  log: (line: string) => void
  /** The time now, in milliseconds. */
  now: () => number
  /** The time, in milliseconds, after which the run starts no query and checks no further side. */
  stopAt: number
  /** How many open sides further along a group's checks start each time it reads that group first. */
  stride: number
}

/** A run's turn is the chain's time in these, ten minutes, the workflow's schedule. */
const TURN_SECONDS = 600n

/**
 * How far a group's checks move on each time the group comes first. A run that comes to a group
 * first has nearly all its time left, so it gets through this many checks.
 */
export const CHECK_STRIDE = 100

/** The items starting at `start`, wrapping round to the ones before it. */
const rotated = <T>(items: readonly T[], start: number): T[] => [
  ...items.slice(start),
  ...items.slice(0, start),
]

/**
 * Sends the step due for a side. When nothing the keeper sent took effect and the lock no longer
 * has a step due for the side, another sender took it first.
 */
async function take(chain: KeeperChain, side: CommitmentSide): Promise<StepResult> {
  const sent = await chain.send(side)
  switch (sent.outcome) {
    case 'landed':
      return { ...side, outcome: 'sent', hash: sent.hash }
    case 'unknown':
      return { ...side, outcome: 'unknown', reason: sent.reason, hashes: sent.hashes }
    case 'failed': {
      // A check that fails counts the step as still due, so a failure is never hidden.
      const stillDue = await chain.isDue(side).catch(() => true)
      return stillDue
        ? { ...side, outcome: 'failed', reason: sent.reason }
        : { ...side, outcome: 'taken' }
    }
  }
}

/**
 * One run. It finds every lock the factory created since the start block, then reads the locks a
 * group at a time over the lookback. The run's turn, which moves on every ten minutes of chain
 * time, picks the group it reads first, so each group comes first once every as many turns as
 * there are groups. Each time a group comes first, its checks start `stride` open sides further
 * along, wrapping round, so a side anywhere in a group gets checked within a bounded number of
 * turns. For each side in a group that was reserved and hasn't ended, it simulates `trigger`, and it
 * sends each step that's due before it reads the next group. The first step due has the faucet fund
 * the key, once a run. After `stopAt` it starts nothing new and counts what it didn't reach. It
 * logs a line for each result and each part it didn't reach, and a summary at the end.
 */
export async function keep(run: KeeperRun): Promise<KeeperReport> {
  const { chain, limits } = run
  const inTime = () => run.now() < run.stopAt
  const head = await chain.head()
  if (run.startBlock > head.number) {
    throw new Error(`The start block ${run.startBlock} is past the latest block, ${head.number}`)
  }
  const searched = { from: run.startBlock, to: head.number }
  const commitmentsFrom = await firstBlockSince(chain, head.timestamp - run.lookback, searched)
  const lookback = { from: commitmentsFrom, to: head.number }
  const report: KeeperReport = {
    locksFrom: run.startBlock,
    to: head.number,
    locks: 0,
    scanned: 0,
    commitmentsFrom,
    commitmentsSince: await chain.timestampOf(commitmentsFrom),
    reserved: 0,
    open: 0,
    due: 0,
    results: [],
    unread: [],
  }
  const record = (result: StepResult) => {
    report.results.push(result)
    run.log(resultLine(result, run.explorer))
  }
  const skip = (unread: Unread) => {
    report.unread.push(unread)
    run.log(unreadLine(unread))
  }

  const locks = await findLocks(chain, run.factory, searched, limits, inTime)
  locks.unread.forEach(skip)
  report.locks = locks.found.length

  let funding: Promise<string | null> | undefined
  const unfunded = () => {
    funding ??= chain.fund().then(
      () => null,
      (e: unknown) => `the faucet didn't fund the key: ${reasonOf(e)}`,
    )
    return funding
  }
  const serve = async (side: CommitmentSide) => {
    let due: boolean
    try {
      due = await chain.isDue(side)
    } catch (e) {
      record({ ...side, outcome: 'unchecked', reason: reasonOf(e) })
      return
    }
    if (!due) return
    report.due++
    const faucet = await unfunded()
    record(
      faucet === null ? await take(chain, side) : { ...side, outcome: 'failed', reason: faucet },
    )
  }

  const batches = groups(locks.found, limits.addresses)
  const count = BigInt(Math.max(batches.length, 1))
  const turn = head.timestamp / TURN_SECONDS
  // Each group comes first once every `count` turns, and `visit` counts those times.
  const visit = turn / count
  const order = rotated(batches, Number(turn % count))
  for (const [i, batch] of order.entries()) {
    if (!inTime()) {
      const left = order.slice(i).reduce((n, b) => n + b.length, 0)
      skip({ part: 'locks', locks: left, range: lookback, reason: OUT_OF_TIME })
      break
    }
    const sides = await findSides(chain, batch, lookback, limits, inTime)
    sides.unread.forEach(skip)
    if (sides.unread.length === 0) report.scanned += batch.length
    const { open } = sides.found
    report.reserved += sides.found.reserved
    report.open += open.length
    const start = open.length === 0 ? 0 : Number((visit * BigInt(run.stride)) % BigInt(open.length))
    for (const [j, side] of rotated(open, start).entries()) {
      if (!inTime()) {
        skip({ part: 'sides', sides: open.length - j, reason: OUT_OF_TIME })
        break
      }
      await serve(side)
    }
  }

  run.log(summaryLine(report))
  return report
}
