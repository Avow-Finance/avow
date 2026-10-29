import type { Address, Hex } from 'viem'
import type { BlockRange, CommitmentSide, KeeperChain, SendResult, SideEvent } from '../chain.js'
import { FACTORY } from './fixtures.js'

/*
 * A chain the keeper's tests script. It holds logs at block numbers, refuses a log query that
 * covers more blocks than its limit, as Moderato's RPC does, and records every query, simulation,
 * funding and send the keeper makes.
 */

const keyOf = (s: CommitmentSide) => `${s.lock.toLowerCase()}:${s.commitmentId}:${s.side}`

/** The hash the scripted chain gives a side's landed step. */
export const landedHash = (s: CommitmentSide): Hex =>
  `0x${s.commitmentId.slice(-62)}${s.side === 'buyer' ? '0b' : '05'}`

export interface Script {
  head: bigint
  /** The most a query's last block may be past its first. */
  maxSpan: bigint
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
  faucetFails?: boolean
}

export interface Recorded {
  lockQueries: BlockRange[]
  sideQueries: { locks: readonly Address[]; range: BlockRange }[]
  simulated: CommitmentSide[]
  funded: number
  sent: CommitmentSide[]
}

export function scriptedChain(script: Script): { chain: KeeperChain; recorded: Recorded } {
  const timeOf = script.timeOf ?? ((block: bigint) => block)
  const due = new Set((script.due ?? []).map(keyOf))
  const takenFirst = new Set((script.takenFirst ?? []).map(keyOf))
  const unanswered = new Set((script.unanswered ?? []).map(keyOf))
  const recorded: Recorded = {
    lockQueries: [],
    sideQueries: [],
    simulated: [],
    funded: 0,
    sent: [],
  }
  const within = (range: BlockRange) => {
    if (range.to - range.from > script.maxSpan) {
      throw new Error(`query exceeds max block range ${script.maxSpan}`)
    }
    if (range.from > range.to || range.to > script.head) throw new Error('a range past the head')
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
      within(range)
      recorded.lockQueries.push(range)
      if (factory !== FACTORY) return []
      return (script.locks ?? []).filter((l) => inRange(l.block, range)).map((l) => l.lock)
    },
    async sideEvents(locks, range) {
      within(range)
      recorded.sideQueries.push({ locks: [...locks], range })
      const named = new Set(locks.map((l) => l.toLowerCase()))
      return (script.events ?? [])
        .filter((e) => named.has(e.lock.toLowerCase()) && inRange(e.block, range))
        .map(({ block: _, ...event }) => event)
    },
    async isDue(side) {
      recorded.simulated.push(side)
      if (unanswered.has(keyOf(side))) throw new Error('HTTP request failed. 502 Bad Gateway')
      return due.has(keyOf(side))
    },
    async fund() {
      recorded.funded++
      if (script.faucetFails) throw new Error('the faucet is resting')
    },
    async send(side) {
      recorded.sent.push(side)
      if (takenFirst.has(keyOf(side))) {
        due.delete(keyOf(side))
        return { outcome: 'failed', reason: 'The node refused to prepare the transaction' }
      }
      const result = script.send?.(side) ?? { outcome: 'landed', hash: landedHash(side) }
      if (result.outcome === 'landed') due.delete(keyOf(side))
      return result
    },
  }
  return { chain, recorded }
}
