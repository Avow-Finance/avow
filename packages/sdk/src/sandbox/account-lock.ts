import { type Address, isAddressEqual } from 'viem'
import { FACTORY_ABI } from '../lock.js'
import { trustedFactory, trustedFactoryAddresses } from './deployment.js'
import type { SandboxClient } from './fees.js'

/** A lock and the factory that made it. */
export interface AccountLock {
  factory: Address
  lock: Address
}

type Reads = Pick<SandboxClient, 'readContract' | 'getCode'>

const lockAddress = (client: Reads, factory: Address, account: Address): Promise<Address> =>
  client.readContract({
    address: factory,
    abi: FACTORY_ABI,
    functionName: 'lockAddress',
    args: [account],
  })

const onChain = async (client: Reads, lock: Address) =>
  (await client.getCode({ address: lock })) !== undefined

/**
 * The lock the current factory makes for the account, and whether it's on chain yet. A new
 * business always takes this one.
 */
export async function currentLock(m: {
  client: Reads
  factory: Address
  account: Address
}): Promise<{ lock: Address; made: boolean }> {
  const lock = await lockAddress(m.client, m.factory, m.account)
  return { lock, made: await onChain(m.client, lock) }
}

/**
 * Every lock on chain that a trusted factory made for the account, oldest factory first. A factory
 * lets anyone create any account's lock, so more than one can be there. Which is the business's
 * comes from Avow's record or the business's own, never from this list alone.
 */
export async function accountLocks(m: {
  client: Reads
  chainId: number
  account: Address
}): Promise<AccountLock[]> {
  const found: AccountLock[] = []
  for (const factory of trustedFactoryAddresses(m.chainId)) {
    const lock = await lockAddress(m.client, factory, m.account)
    if (await onChain(m.client, lock)) found.push({ factory, lock })
  }
  return found
}

/**
 * Whether a recorded lock is the account's own from a trusted factory and on chain, so a business
 * whose record names it keeps it after the sandbox moves to a newer factory. A changed record can
 * name at most another lock of the same account.
 */
export async function isAccountLock(m: {
  client: Reads
  chainId: number
  account: Address
  recorded: AccountLock
}): Promise<boolean> {
  if (!trustedFactory(m.chainId, m.recorded.factory)) return false
  const lock = await lockAddress(m.client, m.recorded.factory, m.account)
  return isAddressEqual(lock, m.recorded.lock) && (await onChain(m.client, lock))
}
