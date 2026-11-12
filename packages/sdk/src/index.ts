/**
 * Avow SDK for agents. An agent books with a supplier, has Avow approve the reserve, checks the
 * approval against the terms and funds the reserve with its own key, then reads what the lock
 * holds, and cancels or starts the job through an `AvowApi` that serves those records. The
 * administrator's side signs for the business account in Tempo's keychain V2 envelope, which the
 * lock and Avow's API check, and the account's root key contests a charge on its own lock.
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
export * from './contest.js'
export * from './http.js'
export * from './job/accept.js'
export * from './job/customer.js'
export * from './job/quote.js'
export * from './lock.js'
export * from './moderato.js'
export {
  dailyLimitOf,
  fundingRefusal,
  keyLeftToday,
  Refusal,
  type SandboxAgent,
  type SandboxAgentOptions,
  type SandboxBooking,
  type SandboxCheck,
  type SandboxCommitment,
  type SandboxCommitmentRecord,
  type SandboxPlatform,
  type SandboxSession,
  sandboxAgent,
  setSandboxPlatform,
} from './sandbox/agent.js'
export * from './sandbox/business.js'
export {
  type ConnectEvent,
  type ConnectOptions,
  connectToBusiness,
  SANDBOX_CONSOLE_URL,
} from './sandbox/connect.js'
export { loadSandboxDeployment, madeOn, trustedFactory } from './sandbox/deployment.js'
export {
  approvedSuppliers,
  liveKeys,
  lockCreatedIn,
  revokeKeyCalls,
  revokeOtherKeys,
} from './sandbox/keys.js'
export {
  type BuyOutcome,
  type BuyStep,
  MAILBOX_ORDER_SECONDS,
  type MailboxOptions,
  type SandboxMailbox,
  type SellStep,
  sandboxMailbox,
} from './sandbox/mailbox.js'
export * from './sandbox/mandate.js'
export { sandbox } from './sandbox/namespace.js'
export * from './sandbox/session.js'
export {
  cancelSandboxCommitment,
  type PreparedSandboxBusiness,
  type PrepareSandboxBusinessOptions,
  prepareSandboxBusiness,
  type SandboxBusinessConfig,
  type SandboxPrompts,
} from './sandbox/setup.js'
export {
  memoryStore,
  type SandboxStore,
  type SandboxStoreItem,
  type SandboxSupplier,
} from './sandbox/store.js'
export * from './sandbox/terms.js'
export * from './send.js'
export * from './sign.js'
export * from './supplier.js'
