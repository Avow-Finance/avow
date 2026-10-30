import type { Address, Hex } from 'viem'
import {
  type BlockRange,
  type CommitmentSide,
  type KeeperChain,
  type SendResult,
  type SideEvent,
  TooManyLogsError,
} from '../chain.js'
import { FACTORY } from './fixtures.js'

/*
 * A chain the keeper's tests script. It holds logs at block numbers, refuses a log query that
 * covers more blocks than its limit or would return more logs than its limit, as Moderato's RPC
 * does, and keeps a clock that each call moves on. It records every call the keeper makes, in
 * order.
 */

const keyOf = (s: CommitmentSide) => `${s.lock.toLowerCase()}:${s.commitmentId}:${s.side}`

/** The hash the scripted chain gives a side's landed step. */
export const landedHash = (s: CommitmentSide): Hex =>
  `0x${s.commitmentId.slice(-62)}${s.side === 'buyer' ? '0b' : '05'}`

export interface Script {
  head: bigint
  /** The most a query's last block may be past its first. */
  maxSpan: bigint
  /** The most logs one query may return. */
  maxResults?: number
  /** Each block's time, one second per block by default. */
  timeOf?: (block: bigint) => bigint
  locks?: { lock: Address; block: bigint }[]
  events?: (SideEvent & { block: bigint })[]
  /** The sides whose simulation succeeds. A step that lands takes its side out. */
  due?: CommitmentSide[]
  /**
   * Sides another sender takes after the keeper's simulation and before its send, so the node
   * refuses to prepare the keeper's transaction.
   */
  takenFirst?: CommitmentSide[]
  /** How the keeper's send goes for a side, when it reaches the node. It lands by default. */
  send?: (side: CommitmentSide) => SendResult
  /** Sides whose simulation the node doesn't answer. */
  unanswered?: CommitmentSide[]
  /** Sides whose simulation the node stops answering once the keeper has sent their step. */
  unansweredAfterSend?: CommitmentSide[]
  /** Locks whose event queries the node fails. */
  refused?: Address[]
  faucetFails?: boolean
  /** Milliseconds each call to the chain moves the clock on. */
  tick?: number
}

export interface Recorded {
  lockQueries: BlockRange[]
  sideQueries: { locks: readonly Address[]; range: BlockRange }[]
  simulated: CommitmentSide[]
  funded: number
  sent: CommitmentSide[]
  /** Every call, in order, as `kind detail`. */
  calls: string[]
}

export function scriptedChain(script: Script): {
  chain: KeeperChain
  recorded: Recorded
  now: () => number
} {
  const timeOf = script.timeOf ?? ((block: bigint) => block)
  const due = new Set((script.due ?? []).map(keyOf))
  const takenFirst = new Set((script.takenFirst ?? []).map(keyOf))
  const unanswered = new Set((script.unanswered ?? []).map(keyOf))
  const unansweredAfterSend = new Set((script.unansweredAfterSend ?? []).map(keyOf))
  const refused = new Set((script.refused ?? []).map((l) => l.toLowerCase()))
  const sentKeys = new Set<string>()
  let clock = 0
  const recorded: Recorded = {
    lockQueries: [],
    sideQueries: [],
    simulated: [],
    funded: 0,
    sent: [],
    calls: [],
  }
  const call = (entry: string) => {
    clock += script.tick ?? 0
    recorded.calls.push(entry)
  }
  const within = <T>(range: BlockRange, found: T[]): T[] => {
    if (range.to - range.from > script.maxSpan) {
      throw new Error(`query exceeds max block range ${script.maxSpan}`)
    }
    if (range.from > range.to || range.to > script.head) throw new Error('a range past the head')
    if (found.length > (script.maxResults ?? Number.POSITIVE_INFINITY)) {
      throw new TooManyLogsError(range)
    }
    return found
  }
  const inRange = (block: bigint, range: BlockRange) => block >= range.from && block <= range.to

  const chain: KeeperChain = {
    async head() {
      return { number: script.head, timestamp: timeOf(script.head) }
    },
    async timestampOf(block) {
      if (block > script.head) throw new Error(`no block ${block} yet`)
      return timeOf(block)
    },
    async locksCreated(factory, range) {
      call(`locks ${range.from}-${range.to}`)
      recorded.lockQueries.push(range)
      const found = factory === FACTORY ? (script.locks ?? []) : []
      return within(
        range,
        found.filter((l) => inRange(l.block, range)).map((l) => l.lock),
      )
    },
    async sideEvents(locks, range) {
      call(`sides ${locks.join(',')} ${range.from}-${range.to}`)
      recorded.sideQueries.push({ locks: [...locks], range })
      if (locks.some((l) => refused.has(l.toLowerCase()))) {
        throw new Error('HTTP request failed. 502 Bad Gateway')
      }
      const named = new Set(locks.map((l) => l.toLowerCase()))
      return within(
        range,
        (script.events ?? [])
          .filter((e) => named.has(e.lock.toLowerCase()) && inRange(e.block, range))
          .map(({ block: _, ...event }) => event),
      )
    },
    async isDue(side) {
      call(`isDue ${keyOf(side)}`)
      recorded.simulated.push(side)
      const key = keyOf(side)
      if (unanswered.has(key) || (sentKeys.has(key) && unansweredAfterSend.has(key))) {
        throw new Error('HTTP request failed. 502 Bad Gateway')
      }
      return due.has(key)
    },
    async fund() {
      call('fund')
      recorded.funded++
      if (script.faucetFails) throw new Error('the faucet is resting')
    },
    async send(side) {
      call(`send ${keyOf(side)}`)
      recorded.sent.push(side)
      sentKeys.add(keyOf(side))
      if (takenFirst.has(keyOf(side))) {
        due.delete(keyOf(side))
        return { outcome: 'failed', reason: 'The node refused to prepare the transaction' }
      }
      const result = script.send?.(side) ?? { outcome: 'landed', hash: landedHash(side) }
      if (result.outcome === 'landed') due.delete(keyOf(side))
      return result
    },
  }
  return { chain, recorded, now: () => clock }
}
