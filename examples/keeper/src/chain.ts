import type { Side } from '@avow-finance/spec'
import type { Address, Hex } from 'viem'

/** A range of blocks, both ends included. */
export interface BlockRange {
  from: bigint
  to: bigint
}

/** One side of one commitment on one lock, which is what `trigger` takes a step for. */
export interface CommitmentSide {
  lock: Address
  commitmentId: Hex
  side: Side
}

/** A lock event the keeper follows. A reserve opens a side, and a release, charge or resolution ends it. */
export interface SideEvent extends CommitmentSide {
  kind: 'reserved' | 'ended'
}

/** How one send of a step went. */
export type SendResult =
  /** The transaction landed and the lock took the step. */
  | { outcome: 'landed'; hash: Hex }
  /** Nothing the keeper sent took effect, and nothing it sent still can. */
  | { outcome: 'failed'; reason: string }
  /** A transaction may have landed, and the chain didn't show whether before the wait ran out. */
  | { outcome: 'unknown'; reason: string; hashes: readonly Hex[] }

/**
 * A log query the node refused because its range holds more logs than the node returns in one
 * answer. The keeper splits the range and asks again.
 */
export class TooManyLogsError extends Error {
  constructor(readonly range: BlockRange) {
    super(`Blocks ${range.from} to ${range.to} hold more logs than the node returns in one answer`)
    this.name = 'TooManyLogsError'
  }
}

/**
 * What the keeper reads from the chain and sends to it. `tempoKeeperChain` reads and sends on
 * Tempo, and the tests script one, so the keeper's own logic never touches a chain client.
 */
export interface KeeperChain {
  /** The latest block's number and time. */
  head(): Promise<{ number: bigint; timestamp: bigint }>
  /** A block's time. */
  timestampOf(block: bigint): Promise<bigint>
  /**
   * The locks the factory created in a range that one log query may cover. It throws a
   * `TooManyLogsError` when the range holds more logs than the node returns at once.
   */
  locksCreated(factory: Address, range: BlockRange): Promise<Address[]>
  /**
   * The events that open and end sides on the locks, in a range that one log query may cover. It
   * throws a `TooManyLogsError` when the range holds more logs than the node returns at once.
   */
  sideEvents(locks: readonly Address[], range: BlockRange): Promise<SideEvent[]>
  /**
   * Whether `trigger` would take a step for the side now. It answers false only when the lock
   * reverts with `NothingDue()`, and throws on any other revert or failure.
   */
  isDue(side: CommitmentSide): Promise<boolean>
  /** Has the testnet faucet fund the key the keeper sends from. */
  fund(): Promise<void>
  /**
   * Signs `trigger` for the side and sends it, then follows the transaction by its hash until its
   * outcome is known or the wait runs out. It resolves with every outcome and never throws.
   */
  send(side: CommitmentSide): Promise<SendResult>
}
