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
  SellerMandate: '1',
  SellerKeyRevocation: '1',
  TermsAgreement: '1',
  SupplierAuthorization: '1',
  HumanApproval: '1',
  StartReceipt: '1',
  NegotiationMove: '1',
  ApiRequest: '1',
  Timestamp: '1',
  ApprovalDecision: '1',
} as const

/**
 * The domain version of a mandate that replaces another, which carries `replaces`. A first mandate
 * keeps version 1 byte for byte, so a reader that knows only version 1 still checks every agent
 * whose limits were never changed.
 */
export const MANDATE_REPLACEMENT_VERSION = '2'

/**
 * The domain version of a terms agreement that names the seller's mandate the supplier's agent
 * agreed under. An agreement that names none keeps version 1 byte for byte, so every sale made
 * under no seller's mandate signs and reads exactly as before.
 */
export const TERMS_AGREEMENT_SELLER_VERSION = '2'

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
  Mandate: [MESSAGE_VERSIONS.Mandate, MANDATE_REPLACEMENT_VERSION],
  SellerMandate: [MESSAGE_VERSIONS.SellerMandate],
  SellerKeyRevocation: [MESSAGE_VERSIONS.SellerKeyRevocation],
  TermsAgreement: [MESSAGE_VERSIONS.TermsAgreement, TERMS_AGREEMENT_SELLER_VERSION],
  SupplierAuthorization: [MESSAGE_VERSIONS.SupplierAuthorization],
  HumanApproval: [MESSAGE_VERSIONS.HumanApproval],
  StartReceipt: [MESSAGE_VERSIONS.StartReceipt],
  NegotiationMove: [MESSAGE_VERSIONS.NegotiationMove],
  ApiRequest: [MESSAGE_VERSIONS.ApiRequest],
  Timestamp: [MESSAGE_VERSIONS.Timestamp],
  ApprovalDecision: [MESSAGE_VERSIONS.ApprovalDecision],
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
 * versions 1 and 2 recorded as kept, as they did the supplier's consent. A version 1 or 2 record
 * reads as version 3, citing nothing when it's version 1. One that ended as kept stays version 2,
 * so writing it back keeps its meaning. The record's terms carry their own version.
 */
export const COMMITMENT_RECORD_VERSION = '3'

/** The version of the mandate check in `checkMandate`, recorded on every decision. */
export const POLICY_VERSION = 'mandate-check/1'

/** The version of the seller's mandate check in `checkSellerMandate`, for a decision to record. */
export const SELLER_POLICY_VERSION = 'seller-mandate-check/1'

/**
 * The version of a commitment event, the notice of one change in a commitment's life. An event is
 * no signed message and no lock checks it, so it has a version of its own. A reader refuses any
 * other version, and a new code, a new field or a change to how an event hashes takes a new one.
 */
export const COMMITMENT_EVENT_VERSION = '1'
