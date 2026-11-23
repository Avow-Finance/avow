import { type Address, isAddressEqual } from 'viem'
import { FACTORY_ABI } from '../lock.js'
import { trustedFactories } from './deployment.js'
import type { SandboxClient } from './fees.js'

/** An account's lock, the factory that makes it, and whether it's on chain yet. */
export interface AccountLock {
  factory: Address
  lock: Address
  made: boolean
}

/**
 * The account's lock. Each trusted factory gives an account one lock, so an account set up under
 * an earlier factory keeps the lock it has after the sandbox moves to a newer one. The trusted
 * factories are asked oldest first, and the first that made a lock for the account answers. With
 * none made, the answer is the lock the current factory would make, which the caller creates.
 */
export async function accountLock(m: {
  client: Pick<SandboxClient, 'readContract' | 'getCode'>
  chainId: number
  /** The factory the sandbox makes new locks from. */
  current: Address
  account: Address
}): Promise<AccountLock> {
  const trusted = trustedFactories(m.chainId).map((f) => f.address)
  const factories = trusted.some((f) => isAddressEqual(f, m.current))
    ? trusted
    : [...trusted, m.current]
  let fresh: Address | null = null
  for (const factory of factories) {
    const lock = await m.client.readContract({
      address: factory,
      abi: FACTORY_ABI,
      functionName: 'lockAddress',
      args: [m.account],
    })
    if ((await m.client.getCode({ address: lock })) !== undefined) {
      return { factory, lock, made: true }
    }
    if (isAddressEqual(factory, m.current)) fresh = lock
  }
  return { factory: m.current, lock: fresh as Address, made: false }
}
