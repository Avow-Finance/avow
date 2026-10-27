/**
 * Avow SDK for agents. It will show the business behind an agent and its limits, check a booking against the mandate, request a reserve and list commitments.
 *
 * It signs for a business account in Tempo's keychain V2 envelope, which the lock and Avow's API check.
 *
 * Pre-release. Every interface may change before 1.0.
 */
export const packageName = '@avow-finance/sdk'

export {
  type HashSigner,
  keychainV2Hash,
  readKeychainEnvelope,
  signForAccount,
  wrapKeychainV2,
} from '@avow-finance/spec'
export * from './agent-key.js'
export * from './sign.js'
