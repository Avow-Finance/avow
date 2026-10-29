import type { Address } from 'viem'
import type { BuyerStore } from './store.js'

/** What making the business's lock needs from the chain and the faucet. */
export interface InitDeps {
  store: BuyerStore
  /** The business account, which pays the lock's creation from the fees the faucet funds. */
  account: Address
  /** The lock the factory gives the business account, created or not. */
  lockAddress: () => Promise<Address>
  /** Funds the account's fees from Moderato's faucet. */
  fundFees: () => Promise<void>
  /** Whether the lock has been created already. */
  lockExists: (lock: Address) => Promise<boolean>
  /** Creates the lock from the factory, in a transaction the account sends. */
  createLock: () => Promise<void>
  log: (line: string) => void
}

/**
 * Funds the account's fees and creates the business's lock, then saves it. A saved mandate is
 * signed for the saved lock, so a factory that gives another lock is refused before the faucet is
 * asked or anything is sent. Returns the lock.
 */
export async function initBusiness(deps: InitDeps): Promise<Address> {
  const lock = await deps.lockAddress()
  deps.store.checkLock(lock)
  deps.log(`funding the business account ${deps.account} from Moderato's faucet, for fees`)
  await deps.fundFees()
  if (!(await deps.lockExists(lock))) {
    deps.log('creating the business lock')
    await deps.createLock()
  }
  deps.store.saveSetup({ lock })
  return lock
}
