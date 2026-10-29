/**
 * Avow SDK for agents. An agent books with a supplier, has Avow approve the reserve, checks the
 * approval against the terms and funds the reserve with its own key, then cancels or starts the
 * job and reads what the lock holds. The administrator's side signs for the business account in
 * Tempo's keychain V2 envelope, which the lock and Avow's API check.
 *
 * Pre-release and testnet only. The lock it calls is unaudited, and every interface may change
 * before 1.0.
 */
export const packageName = '@avow-finance/sdk'

export {
  type HashSigner,
  keychainV2Hash,
  readKeychainEnvelope,
  signForAccount,
  wrapKeychainV2,
} from '@avow-finance/spec'
export * from './agent.js'
export * from './agent-key.js'
export * from './avow-api.js'
export * from './http.js'
export * from './lock.js'
export * from './send.js'
export * from './sign.js'
export * from './supplier.js'
