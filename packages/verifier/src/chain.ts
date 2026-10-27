import { keychainSignatureCheck, type RailState, type Side } from '@avow-finance/spec'
import type { Address, Hex } from 'viem'

/** What a lock stores for one side of a commitment. */
export interface LockedBacking {
  state: RailState
  token: Address
  /** Base units of the token. */
  amount: bigint
  payee: Address
  acceptBy: bigint
  chargeDeadline: bigint
  contestWindow: bigint
  releaseDate: bigint
  termsHash: Hex
  /** The key that funded the reserve, or the zero address when the account's root key did. */
  fundingKey: Address
}

export interface LockInfo {
  /** True when the lock runs the code Avow's factory deploys. */
  fromFactory: boolean
  /** The business account that owns the lock. */
  account: Address
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
 * check doesn't depend on Avow's database. The Tempo reader arrives with the lock contract, and
 * `MemoryChain` stands in for it in tests.
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
}

/** A chain reader held in memory, for tests and dry runs. */
export class MemoryChain implements ChainReader {
  readonly #locks = new Map<string, LockInfo>()
  readonly #backings = new Map<string, LockedBacking>()
  readonly #keys = new Map<string, AgentKeyInfo & { authorizedIn: Hex | null }>()
  readonly #admins = new Set<string>()
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
}
