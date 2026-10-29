import type { Address } from 'viem'
import type { CommitmentSide, KeeperChain } from './chain.js'
import { type KeeperReport, reasonOf, resultLine, type StepResult, summaryLine } from './report.js'
import { findLocks, findSides, firstBlockSince, type LogLimits } from './scan.js'

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
 * One run. It finds every lock the factory created since the start block, and every side reserved
 * on them within the lookback that hasn't ended, then simulates `trigger` for each. When any side
 * has a step due, it has the faucet fund the key once, then sends each step and follows it by its
 * hash. It logs a line for each result and a summary at the end.
 */
export async function keep(run: KeeperRun): Promise<KeeperReport> {
  const { chain } = run
  const head = await chain.head()
  if (run.startBlock > head.number) {
    throw new Error(`The start block ${run.startBlock} is past the latest block, ${head.number}`)
  }
  const searched = { from: run.startBlock, to: head.number }
  const locks = await findLocks(chain, run.factory, searched, run.limits)
  const commitmentsFrom = await firstBlockSince(chain, head.timestamp - run.lookback, searched)
  const sides =
    locks.length === 0
      ? { reserved: 0, open: [] }
      : await findSides(chain, locks, { from: commitmentsFrom, to: head.number }, run.limits)

  const results: StepResult[] = []
  const record = (result: StepResult) => {
    results.push(result)
    run.log(resultLine(result, run.explorer))
  }
  const due: CommitmentSide[] = []
  for (const side of sides.open) {
    try {
      if (await chain.isDue(side)) due.push(side)
    } catch (e) {
      record({ ...side, outcome: 'unchecked', reason: reasonOf(e) })
    }
  }
  if (due.length > 0) {
    const unfunded = await chain.fund().then(
      () => null,
      (e: unknown) => `the faucet didn't fund the key: ${reasonOf(e)}`,
    )
    for (const side of due) {
      record(
        unfunded === null
          ? await take(chain, side)
          : { ...side, outcome: 'failed', reason: unfunded },
      )
    }
  }

  const report: KeeperReport = {
    locksFrom: run.startBlock,
    commitmentsFrom,
    to: head.number,
    locks: locks.length,
    reserved: sides.reserved,
    open: sides.open.length,
    due: due.length,
    results,
  }
  run.log(summaryLine(report))
  return report
}
