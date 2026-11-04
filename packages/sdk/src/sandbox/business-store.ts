import type { Address } from 'viem'
import {
  isAddressText,
  readBusiness,
  readJson,
  type SandboxStore,
  type StoredBusiness,
  write,
} from './store.js'
import { isSealedBlob, isSealedKey, type SealedBlob, type SealedKey } from './vault.js'

/**
 * The business's item, which only the runner reads: the business account, its root key sealed
 * under the passphrase, a record sealed under the same passphrase, and its registration. Nothing on
 * the agent's side imports this module.
 */
export interface BusinessItem {
  account: Address
  key: SealedKey
  /**
   * The block the business was set up from, sealed so nothing that can write the file can move it.
   * The runner reads every agent key the account's keychain authorized since then from the chain.
   */
  record: SealedBlob | null
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
    record: isSealedBlob(json.record) ? json.record : null,
    business: readBusiness(json.business),
  }
}

export const saveBusinessItem = (store: SandboxStore, item: BusinessItem) =>
  write(store, 'business', item)
