import {
  type Charge,
  type ChargeKind,
  keychainSignatureCheck,
  type LockTiming,
  type ObservedTransfer,
  type RailState,
  type Side,
} from '@avow-finance/spec'
import type { Address, Hex } from 'viem'

/** What a lock stores for one side of a commitment. */
export interface LockedBacking {
  state: RailState
  /** The lock's one token. */
  token: Address
  /** Base units of the token, as funded. */
  amount: bigint
  /** What the lock still holds for the commitment, less any part already returned or paid. */
  held: bigint
  /** The supplier's payout address, copied from the approval. */
  payee: Address
  /** The supplier's account, which consents to releases. */
  supplier: Address
  /** The supplier's signing key, which accepts the reserve and reports charges. */
  supplierSigner: Address
  freeCancelBy: bigint
  acceptBy: bigint
  chargeDeadline: bigint
  contestWindow: bigint
  releaseDate: bigint
  charges: readonly Charge[]
  day90SupplierShareBps: number
  arbiter: Address
  termsHash: Hex
  mandateHash: Hex
  /** The digest of Avow's approval the lock took, which the supplier's acceptance names. */
  approvalHash: Hex
  /** The key that funded the reserve, or the zero address when the account's root key did. */
  fundingKey: Address
  /** Every report ever filed on the commitment, which a release consent names. */
  reportCount: number
  /** The kind of charge the latest report names, or null before any report is filed. */
  reportKind: ChargeKind | null
  /** The latest report's amount in base units of the token, or zero before any report is filed. */
  reportAmount: bigint
  /**
   * Whether a report stands on the commitment, filed and not withdrawn. The lock takes no other
   * report while one does, and on an accepted commitment it's open, waiting for Avow's answer.
   */
  hasReport: boolean
  /**
   * Whether the business has contested a charge on the commitment. The contest stays on record
   * when the supplier withdraws the report, so the lock takes no second one, and a later report
   * pauses at once.
   */
  contested: boolean
  /** When a confirmed charge became pending and its contest window opened, or zero if one never did. */
  chargeStart: bigint
  /** When the charge paused, which days 30 and 90 count from, or zero if it never paused. */
  pausedAt: bigint
  /** Whether a ruling has been posted on the commitment. */
  hasRuling: boolean
}

/** A contest a lock logged, as the `Paused` event its contest wrote shows it. */
export interface ObservedContest {
  commitmentId: Hex
  side: Side
  /** The reason's code, which `contestReasonOf` reads as one of the six reasons or as none. */
  reasonCode: number
  /** The hash of the business's statement, which the event logs as its `evidenceHash`. */
  statementHash: Hex
  /** When the lock paused the charge, which days 30 and 90 count from. */
  pausedAt: bigint
}

/** A contest read from the chain, with where it landed and the report it named. */
export interface ContestOnChain extends ObservedContest {
  /** The block the contest landed in. */
  blockNumber: bigint
  /**
   * Whether that block is at or below the chain's finalized block and is the chain's block at its
   * height, so no reorganization can drop the contest.
   */
  finalized: boolean
  /**
   * The report the contest named, as the lock held it at the end of the contest's block: its
   * number, which the lock checked the contest against, its kind and its amount in base units.
   */
  report: { number: number; kind: ChargeKind; amount: bigint }
}

/** The most reports a lock takes for one commitment, which the spec defines for every package. */
export { MAX_REPORTS } from '@avow-finance/spec'

export interface LockInfo {
  /** True when Avow's factory, as the reader was set up with it, created the lock. */
  fromFactory: boolean
  /** The business account that owns the lock. */
  account: Address
  /** The token the lock holds reserves in. */
  token: Address
  /** The timing the factory fixed in the lock. */
  timing: LockTiming
}

export interface AgentKeyInfo {
  /** False once the key is revoked. */
  active: boolean
  /** When the key stops working, or null when it doesn't expire. */
  expiry: bigint | null
  /** The mandate hash bound into the key's authorization, or null when there is none. */
  witness: Hex | null
}

/**
 * Everything the verifier reads from the chain. Nothing here comes from Avow, so a supplier's
 * check doesn't depend on Avow's database. `tempoChainReader` reads Tempo, and `MemoryChain` stands
 * in for it in tests. A supplier trusts whichever node it reads through, so it picks that node.
 */
export interface ChainReader {
  readonly chainId: number
  lock(lock: Address): Promise<LockInfo | null>
  backing(lock: Address, commitmentId: Hex, side: Side): Promise<LockedBacking | null>
  /**
   * A key on an account, with the mandate hash logged in the transaction that authorized it.
   * Returns null when the account has no such key.
   */
  agentKey(account: Address, key: Address, authorizedIn: Hex): Promise<AgentKeyInfo | null>
  /**
   * Whether the account's root key or one of its admin keys signed the digest, in the keychain
   * envelope Tempo requires. On Tempo this asks the chain's own signature verifier.
   */
  isAccountSignature(account: Address, digest: Hex, signature: Hex): Promise<boolean>
  /**
   * The log at one index of one transaction, decoded as a TIP-20 `TransferWithMemo` event when it
   * is one, with whether the transaction succeeded and whether its block is finalized. Returns
   * null when the chain has no such transaction or log. Nothing is read from calldata.
   */
  transfer(transactionHash: Hex, logIndex: number): Promise<ObservedTransfer | null>
  /**
   * The contest of one side of a commitment that one transaction carried, from the `Paused` event
   * the lock logged with a contest as its cause, with whether its block is final and the report it
   * named. Returns null when the chain has no such transaction, when it failed, or when it holds no
   * contest of that side from that lock.
   */
  contest(
    lock: Address,
    commitmentId: Hex,
    side: Side,
    transactionHash: Hex,
  ): Promise<ContestOnChain | null>
}

/** A chain reader held in memory, for tests and dry runs. */
export class MemoryChain implements ChainReader {
  readonly #locks = new Map<string, LockInfo>()
  readonly #backings = new Map<string, LockedBacking>()
  readonly #keys = new Map<string, AgentKeyInfo & { authorizedIn: Hex | null }>()
  readonly #admins = new Set<string>()
  readonly #transfers = new Map<string, ObservedTransfer>()
  readonly #contests = new Map<string, ContestOnChain>()
  readonly #check = keychainSignatureCheck((account, key) =>
    this.#admins.has(`${account.toLowerCase()}:${key.toLowerCase()}`),
  )

  constructor(readonly chainId: number) {}

  setLock(lock: Address, info: LockInfo): void {
    this.#locks.set(lock.toLowerCase(), info)
  }

  setBacking(lock: Address, commitmentId: Hex, side: Side, backing: LockedBacking | null): void {
    const key = `${lock.toLowerCase()}:${commitmentId.toLowerCase()}:${side}`
    if (backing) this.#backings.set(key, backing)
    else this.#backings.delete(key)
  }

  /** Records a key. With `authorizedIn`, the witness reads back only for that transaction. */
  setAgentKey(account: Address, key: Address, info: AgentKeyInfo, authorizedIn?: Hex): void {
    this.#keys.set(`${account.toLowerCase()}:${key.toLowerCase()}`, {
      ...info,
      authorizedIn: authorizedIn ?? null,
    })
  }

  /** Records what the chain holds at one log index of one transaction. */
  setTransfer(seen: ObservedTransfer): void {
    this.#transfers.set(`${seen.transactionHash.toLowerCase()}:${seen.logIndex}`, seen)
  }

  /** Records a contest a successful transaction carried to a lock. */
  setContest(lock: Address, transactionHash: Hex, contest: ContestOnChain): void {
    const { commitmentId, side } = contest
    this.#contests.set(contestKey(lock, commitmentId, side, transactionHash), contest)
  }

  addAdminKey(account: Address, key: Address): void {
    this.#admins.add(`${account.toLowerCase()}:${key.toLowerCase()}`)
  }

  async lock(lock: Address): Promise<LockInfo | null> {
    return this.#locks.get(lock.toLowerCase()) ?? null
  }

  async backing(lock: Address, commitmentId: Hex, side: Side): Promise<LockedBacking | null> {
    return this.#backings.get(`${lock.toLowerCase()}:${commitmentId.toLowerCase()}:${side}`) ?? null
  }

  async agentKey(account: Address, key: Address, authorizedIn: Hex): Promise<AgentKeyInfo | null> {
    const stored = this.#keys.get(`${account.toLowerCase()}:${key.toLowerCase()}`)
    if (!stored) return null
    const { authorizedIn: tx, ...info } = stored
    const sameTx = tx === null || tx.toLowerCase() === authorizedIn.toLowerCase()
    return sameTx ? info : { ...info, witness: null }
  }

  async isAccountSignature(account: Address, digest: Hex, signature: Hex): Promise<boolean> {
    return this.#check({ signer: account, digest, signature })
  }

  async transfer(transactionHash: Hex, logIndex: number): Promise<ObservedTransfer | null> {
    return this.#transfers.get(`${transactionHash.toLowerCase()}:${logIndex}`) ?? null
  }

  async contest(
    lock: Address,
    commitmentId: Hex,
    side: Side,
    transactionHash: Hex,
  ): Promise<ContestOnChain | null> {
    return this.#contests.get(contestKey(lock, commitmentId, side, transactionHash)) ?? null
  }
}

/** One side of one commitment's contest in one transaction to one lock, as a map's key. */
const contestKey = (lock: Address, commitmentId: Hex, side: Side, transactionHash: Hex) =>
  `${lock.toLowerCase()}:${commitmentId.toLowerCase()}:${side}:${transactionHash.toLowerCase()}`
