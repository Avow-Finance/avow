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
  /** The time, in milliseconds, after which the run starts no query, simulation or send. */
  stopAt: number
}

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
 * group at a time over the lookback, starting at a group that moves with the latest block, so a
 * run that can't read them all reaches different locks each time. For each side in a group that
 * was reserved and hasn't ended, it simulates `trigger`, and it sends each step that's due before
 * it reads the next group. The first step due has the faucet fund the key, once a run. After
 * `stopAt` it starts nothing new. It logs a line for each result and each part it didn't read, and
 * a summary at the end.
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
    if (!inTime()) {
      record({ ...side, outcome: 'unchecked', reason: OUT_OF_TIME })
      return
    }
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
  const first = batches.length === 0 ? 0 : Number(head.number % BigInt(batches.length))
  const order = batches.map((_, i) => batches[(first + i) % batches.length] ?? [])
  for (const [i, batch] of order.entries()) {
    if (!inTime()) {
      const left = order.slice(i).reduce((n, b) => n + b.length, 0)
      skip({ part: 'locks', locks: left, range: lookback, reason: OUT_OF_TIME })
      break
    }
    const sides = await findSides(chain, batch, lookback, limits, inTime)
    sides.unread.forEach(skip)
    if (sides.unread.length === 0) report.scanned += batch.length
    report.reserved += sides.found.reserved
    report.open += sides.found.open.length
    for (const side of sides.found.open) await serve(side)
  }

  run.log(summaryLine(report))
  return report
}
