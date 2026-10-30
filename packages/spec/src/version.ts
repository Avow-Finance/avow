/** The EIP-712 domain name of every Avow message. */
export const DOMAIN_NAME = 'Avow'

/**
 * The domain version of every message a lock checks. The lock's code fixes it and a lock can't be
 * upgraded, so it changes only with a new lock.
 */
export const LOCK_MESSAGE_VERSION = '1'

/**
 * Each message type's EIP-712 domain version. The messages a lock checks share the lock's version.
 * Each message the lock never sees has its own, so it can change without the others and without a
 * new lock. The terms carry their own version inside the terms hash.
 */
export const MESSAGE_VERSIONS = {
  Approval: LOCK_MESSAGE_VERSION,
  Acceptance: LOCK_MESSAGE_VERSION,
  Report: LOCK_MESSAGE_VERSION,
  ReleaseConsent: LOCK_MESSAGE_VERSION,
  Evidence: LOCK_MESSAGE_VERSION,
  BusinessAction: LOCK_MESSAGE_VERSION,
  SupplierAction: LOCK_MESSAGE_VERSION,
  Mandate: '1',
  TermsAgreement: '1',
  SupplierAuthorization: '1',
  HumanApproval: '1',
  StartReceipt: '1',
  ApiRequest: '1',
  Timestamp: '1',
} as const

type VersionedType = keyof typeof MESSAGE_VERSIONS

/** The domain versions this package reads for each message type. */
export const SUPPORTED_MESSAGE_VERSIONS: { readonly [T in VersionedType]: readonly string[] } = {
  Approval: [MESSAGE_VERSIONS.Approval],
  Acceptance: [MESSAGE_VERSIONS.Acceptance],
  Report: [MESSAGE_VERSIONS.Report],
  ReleaseConsent: [MESSAGE_VERSIONS.ReleaseConsent],
  Evidence: [MESSAGE_VERSIONS.Evidence],
  BusinessAction: [MESSAGE_VERSIONS.BusinessAction],
  SupplierAction: [MESSAGE_VERSIONS.SupplierAction],
  Mandate: [MESSAGE_VERSIONS.Mandate],
  TermsAgreement: [MESSAGE_VERSIONS.TermsAgreement],
  SupplierAuthorization: [MESSAGE_VERSIONS.SupplierAuthorization],
  HumanApproval: [MESSAGE_VERSIONS.HumanApproval],
  StartReceipt: [MESSAGE_VERSIONS.StartReceipt],
  ApiRequest: [MESSAGE_VERSIONS.ApiRequest],
  Timestamp: [MESSAGE_VERSIONS.Timestamp],
}

/**
 * Whether this package reads a message of this type at this domain version. The type comes from
 * whoever sent the message, so only the table's own keys count, never a name every object inherits
 * such as `constructor`.
 */
export function isSupportedMessageVersion(type: string, version: string): boolean {
  if (!Object.hasOwn(SUPPORTED_MESSAGE_VERSIONS, type)) return false
  return SUPPORTED_MESSAGE_VERSIONS[type as VersionedType].includes(version)
}

/**
 * The version of a stored commitment record. Version 2 added the references a record cites.
 * Version 3 gave a reserve that went back at its release date its own kind of outcome, which
 * version 2 recorded as kept. A version 1 record reads as version 3 with no references, and a
 * version 2 record reads as version 3 unchanged. The record's terms carry their own version.
 */
export const COMMITMENT_RECORD_VERSION = '3'

/** The version of the mandate check in `checkMandate`, recorded on every decision. */
export const POLICY_VERSION = 'mandate-check/1'
