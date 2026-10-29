import { BaseError, type Hex } from 'viem'
import type { CommitmentSide } from './chain.js'

/** How a side the keeper found due ended up, or why it couldn't check one. */
export type StepResult = CommitmentSide &
  (
    | { outcome: 'sent'; hash: Hex }
    /** The keeper's send failed because another sender took the step first. */
    | { outcome: 'taken' }
    | { outcome: 'failed'; reason: string }
    | { outcome: 'unknown'; reason: string; hashes: readonly Hex[] }
    | { outcome: 'unchecked'; reason: string }
  )

/** What one run checked and did. */
export interface KeeperReport {
  /** The first block searched for locks, which is the start block. */
  locksFrom: bigint
  /** The first block searched for commitments, the first within the lookback. */
  commitmentsFrom: bigint
  /** The last block searched for both, the latest when the run began. */
  to: bigint
  locks: number
  /** Sides reserved from `commitmentsFrom` on, and how many of them haven't ended. */
  reserved: number
  open: number
  /** Open sides whose `trigger` would take a step. */
  due: number
  /** Every side found due, and every open side the keeper couldn't check. */
  results: StepResult[]
}

/**
 * An error's message on one line, short enough for a log line. A viem error gives its summary and
 * the node's own words, without the request it repeats.
 */
export function reasonOf(error: unknown): string {
  const message =
    error instanceof BaseError
      ? error.details && error.details !== error.shortMessage
        ? `${error.shortMessage} ${error.details}`
        : error.shortMessage
      : error instanceof Error
        ? error.message
        : String(error)
  return message.replace(/\s+/g, ' ').trim().slice(0, 300)
}

/** The line a run prints for one result, with a link into the block explorer for each transaction. */
export function resultLine(result: StepResult, explorer: string): string {
  const link = (hash: Hex) => `${explorer}/tx/${hash}`
  const which = `${result.commitmentId} (${result.side}) on lock ${result.lock}`
  switch (result.outcome) {
    case 'sent':
      return `sent the step due for ${which}: ${link(result.hash)}`
    case 'taken':
      return `another sender took the step due for ${which} first`
    case 'failed':
      return `could not send the step due for ${which}: ${result.reason}`
    case 'unknown':
      return `sent the step due for ${which}, and its outcome is unknown, so the next run reads the chain again: ${result.hashes.map(link).join(' ')} (${result.reason})`
    case 'unchecked':
      return `could not check ${which}: ${result.reason}`
  }
}

/** The line a run ends with, saying what it searched and what it did. */
export function summaryLine(report: KeeperReport): string {
  const count = (outcome: StepResult['outcome']) =>
    report.results.filter((r) => r.outcome === outcome).length
  return [
    `checked ${report.locks} locks created in blocks ${report.locksFrom} to ${report.to}`,
    `and ${report.reserved} sides reserved in blocks ${report.commitmentsFrom} to ${report.to}:`,
    `${report.open} open, ${report.due} due, ${count('sent')} sent,`,
    `${count('taken')} taken by another sender, ${count('failed')} failed,`,
    `${count('unknown')} unknown, ${count('unchecked')} unchecked`,
  ].join(' ')
}

/**
 * Whether the run leaves something for a person to look at: a step that failed, a transaction
 * whose outcome is unknown, or a side it couldn't check. A step another sender took counts as done.
 */
export function needsAttention(report: KeeperReport): boolean {
  return report.results.some((r) => r.outcome !== 'sent' && r.outcome !== 'taken')
}
