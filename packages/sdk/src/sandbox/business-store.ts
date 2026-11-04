import type { Address } from 'viem'
import {
  isAddressText,
  readBusiness,
  readJson,
  type SandboxStore,
  type StoredBusiness,
  write,
} from './store.js'
import { isSealedKey, type SealedKey } from './vault.js'

/**
 * The business's item, which only the runner reads: the business account, its root key sealed
 * under the passphrase, and its registration. The sealed key is bound to the account, so a changed
 * account only stops the key from opening. The runner checks the registration against the chain
 * before it relies on it, since anything running as the developer can write this file. Nothing on
 * the agent's side imports this module.
 */
export interface BusinessItem {
  account: Address
  key: SealedKey
  business: StoredBusiness | null
}

/** The business's item, or null when the business has no key yet. */
export async function loadBusinessItem(store: SandboxStore): Promise<BusinessItem | null> {
  const text = await store.read('business')
  if (text === null) return null
  const json = readJson(text, 'business')
  if (!isAddressText(json.account) || !isSealedKey(json.key)) {
    throw new Error(
      "The sandbox's business file isn't in the form it writes. Restore it, or start over with npm run fresh.",
    )
  }
  return {
    account: json.account,
    key: json.key,
    business: readBusiness(json.business),
  }
}

export const saveBusinessItem = (store: SandboxStore, item: BusinessItem) =>
  write(store, 'business', item)
