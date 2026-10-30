import { BaseError, type Hex } from 'viem'
import type { BlockRange, CommitmentSide } from './chain.js'

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

/** A part of the search a run didn't read, and why, so a later run or a person picks it up. */
export type Unread =
  /** Factory blocks whose new locks the run didn't read. */
  | { part: 'factory'; range: BlockRange; reason: string }
  /** Blocks of the lookback whose events the run didn't read for some of the locks. */
  | { part: 'locks'; locks: number; range: BlockRange; reason: string }

/** Why a run stops starting queries and sends before it has read everything. */
export const OUT_OF_TIME = 'the run ran out of time'

/** What one run checked and did. */
export interface KeeperReport {
  /** The first block searched for locks, which is the start block. */
  locksFrom: bigint
  /** The last block searched, the latest when the run began. */
  to: bigint
  /** The locks the factory created, as far as the run read its logs. */
  locks: number
  /** The locks whose events over the whole lookback the run read. */
  scanned: number
  /** The first block of the lookback, and its time, so the oldest reserve the run reaches. */
  commitmentsFrom: bigint
  commitmentsSince: bigint
  /** Sides reserved within the lookback on the locks read, and how many of them haven't ended. */
  reserved: number
  open: number
  /** Open sides whose `trigger` would take a step. */
  due: number
  /** Every side found due, and every open side the keeper couldn't check. */
  results: StepResult[]
  /** Every part of the search the run didn't read. */
  unread: Unread[]
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

/** The line a run prints for a part of the search it didn't read. */
export function unreadLine(unread: Unread): string {
  const blocks = `blocks ${unread.range.from} to ${unread.range.to}`
  switch (unread.part) {
    case 'factory':
      return `did not read ${blocks} for new locks: ${unread.reason}`
    case 'locks':
      return `did not read ${blocks} for ${unread.locks} locks: ${unread.reason}`
  }
}

/** A block's time as a date. */
const dateOf = (timestamp: bigint) => new Date(Number(timestamp) * 1000).toISOString()

/** The line a run ends with, saying what it searched, what it reached and what it did. */
export function summaryLine(report: KeeperReport): string {
  const count = (outcome: StepResult['outcome']) =>
    report.results.filter((r) => r.outcome === outcome).length
  return [
    `checked ${report.scanned} of ${report.locks} locks created in blocks ${report.locksFrom} to ${report.to},`,
    `and ${report.reserved} sides reserved since ${dateOf(report.commitmentsSince)} (block ${report.commitmentsFrom}):`,
    `${report.open} open, ${report.due} due, ${count('sent')} sent,`,
    `${count('taken')} taken by another sender, ${count('failed')} failed,`,
    `${count('unknown')} unknown, ${count('unchecked')} unchecked, ${report.unread.length} parts unread`,
  ].join(' ')
}

/**
 * Whether the run leaves something for a person to look at: a step that failed, a transaction
 * whose outcome is unknown, a side it couldn't check, or a part of the search it didn't read. A
 * step another sender took counts as done.
 */
export function needsAttention(report: KeeperReport): boolean {
  return (
    report.unread.length > 0 ||
    report.results.some((r) => r.outcome !== 'sent' && r.outcome !== 'taken')
  )
}
