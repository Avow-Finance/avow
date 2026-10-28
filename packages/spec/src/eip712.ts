import {
  type Address,
  type Hex,
  hashTypedData,
  isAddressEqual,
  recoverAddress,
  type TypedDataDomain,
} from 'viem'
import type { ReasonCode } from './reasons.js'
import type { ApprovalRule, Mandate, Side } from './types.js'
import { DOMAIN_NAME, isSupportedMessageVersion, MESSAGE_VERSIONS } from './version.js'

/**
 * Every signed message is EIP-712 typed data. The domain names the message type's version, the
 * chain and the buyer's lock, and each message carries a nonce and an expiry, so it can't be
 * replayed on another chain or lock or changed without breaking the signature.
 */
export interface AvowDomain {
  chainId: number
  /** The buyer's lock, which every message for its commitments names. */
  verifyingContract: Address
}

export function domain(d: AvowDomain, version: string): TypedDataDomain {
  return {
    name: DOMAIN_NAME,
    version,
    chainId: d.chainId,
    verifyingContract: d.verifyingContract,
  }
}

const sideCode = { buyer: 0, supplier: 1 } as const satisfies Record<Side, number>
const ruleCode = { never: 0, above: 1, always: 2 } as const satisfies Record<
  ApprovalRule['kind'],
  number
>

/**
 * The kinds of charge a lock can hold, by the code the lock stores. A commitment's terms carry up
 * to four kinds, and the demo terms use these two.
 */
export const CHARGE_KINDS = { lateCancellation: 0, noShow: 1 } as const
export type ChargeKind = keyof typeof CHARGE_KINDS

/** Why the supplier account consents to give a reserve back. */
export const RELEASE_REASONS = { kept: 1, supplierFailed: 2 } as const
export type ReleaseReason = keyof typeof RELEASE_REASONS

/** What a business signs as a `BusinessAction`, by the code the lock reads. */
export const BUSINESS_ACTIONS = {
  contest: 0,
  evidence: 1,
  approveSupplier: 2,
  removeSupplier: 3,
} as const
export type BusinessActionKind = keyof typeof BUSINESS_ACTIONS

/** What a supplier account signs as a `SupplierAction`. The demo lock takes only a withdrawal. */
export const SUPPLIER_ACTIONS = { withdrawReport: 0 } as const
export type SupplierActionKind = keyof typeof SUPPLIER_ACTIONS

/**
 * Both sides sign the same agreement, which moves a commitment from draft to agreed. The buyer's
 * agent key signs under its mandate, and the supplier's signing key signs for the supplier.
 */
export interface TermsAgreement {
  commitmentId: Hex
  termsHash: Hex
  category: string
  buyerBusinessId: string
  supplierBusinessId: string
  mandateHash: Hex
  nonce: bigint
  /** When the offer lapses. */
  expiry: bigint
}

/** One kind of charge in a commitment's terms: the most it can take, and when it can first be reported. */
export interface Charge {
  kind: ChargeKind
  /** Base units of the token, never more than the reserve. */
  most: bigint
  /** From `freeCancelBy` and before `chargeDeadline`. */
  earliest: bigint
}

/**
 * Avow's approval of the mandate check, which the lock requires before it takes a reserve. It
 * carries every field the lock stores for the commitment, in the lock's order. Amounts are the
 * token's base units, since the lock enforces them. In the demo factory, which has no supplier
 * directory, it also names the supplier's account, signing key and payout.
 */
export interface Approval {
  commitmentId: Hex
  side: Side
  token: Address
  amount: bigint
  /** The supplier's account, on the business's approved list, which consents to releases. */
  supplier: Address
  /** The supplier's signing key, which accepts reserves and reports charges. */
  supplierSigner: Address
  /** Where any charge is paid, copied into the commitment. */
  payee: Address
  freeCancelBy: bigint
  acceptBy: bigint
  chargeDeadline: bigint
  releaseDate: bigint
  contestWindow: bigint
  charges: readonly Charge[]
  /** The supplier's share of a confirmed charge still unruled at day 90, in basis points. */
  day90SupplierShareBps: number
  /** The fallback arbiter from the agreed terms, who can rule from day 30 to day 90. */
  arbiter: Address
  termsHash: Hex
  mandateHash: Hex
  capPerCommitment: bigint
  capOpenReserves: bigint
  /**
   * The key the reserve must come from, so the lock can check which key signed (rule 4). The
   * zero address means the account's root key, the administrator's passkey.
   */
  fundingKey: Address
  nonce: bigint
  expiry: bigint
}

/**
 * The supplier's acceptance of a funded reserve, signed by its signing key. It names the digest of
 * Avow's approval that funded the reserve, which covers every term that approval sets for the
 * commitment, and the lock's own settings through the lock's address in its domain. Any change to
 * the approval gives another digest, and the lock refuses the acceptance. The supplier is bound by
 * everything the approval says, so it gets an acceptance to sign from the verifier's
 * `prepareAcceptance`, which checks the approval against the supplier's own terms and the lock
 * first. The lock checks only the signature and the digest, so it takes a correctly signed
 * acceptance however it was built.
 */
export interface Acceptance {
  commitmentId: Hex
  side: Side
  /** `approvalDigest` of the approval the lock took, which the lock stores and emits as `approvalHash`. */
  approvalHash: Hex
  termsHash: Hex
  /** Base units of the token. */
  amount: bigint
  token: Address
  acceptBy: bigint
  nonce: bigint
  expiry: bigint
}

/** The supplier's report of a charge, signed by its signing key. Avow confirms it or refers it. */
export interface ChargeReport {
  commitmentId: Hex
  side: Side
  kind: ChargeKind
  /** Base units of the token, within the kind's most. */
  amount: bigint
  evidenceHash: Hex
  nonce: bigint
  expiry: bigint
}

/**
 * The supplier account's consent to give a reserve back, signed by its root key or an admin key. It
 * names a report count, and the lock takes it only while the commitment's count is that number, so
 * a report filed after the supplier signed for the current count voids it. A consent that names a
 * later count than the commitment has becomes valid once reports reach that count, which is
 * preauthorization, so the verifier's `prepareReleaseConsent` makes the signer confirm it.
 */
export interface ReleaseConsent {
  commitmentId: Hex
  side: Side
  /** The lock's `reportCount` for the commitment, which counts every report ever filed. */
  reportCount: number
  reason: ReleaseReason
  evidenceHash: Hex
  nonce: bigint
  expiry: bigint
}

/** One piece of the supplier's evidence on a paused charge, signed by its signing key. */
export interface SupplierEvidence {
  commitmentId: Hex
  side: Side
  /**
   * The supplier's next evidence number on this commitment. Each side numbers its own evidence,
   * so the business's filings never void the supplier's signed evidence.
   */
  number: number
  evidenceHash: Hex
  nonce: bigint
  expiry: bigint
}

/**
 * An action the business signs with its root key or an admin key, which any account can send to
 * the lock. Each action reads only its own fields, and the rest are zero. For a change to the
 * approved suppliers, the nonce is the supplier's change count on the lock when the business
 * signs, so a change signed before a later one can't land after it.
 */
export interface BusinessAction {
  action: BusinessActionKind
  commitmentId: Hex
  side: Side
  /** A contest names the report it contests. */
  reportNumber: number
  /** A contest's reason code. */
  reasonCode: number
  /** The business's next evidence number on the commitment. */
  evidenceNumber: number
  /** A contest's statement hash, or evidence's hash. */
  dataHash: Hex
  /** The supplier account to approve or remove. */
  supplier: Address
  nonce: bigint
  expiry: bigint
}

/** An action the supplier account signs with its root key or an admin key. */
export interface SupplierAction {
  supplier: Address
  action: SupplierActionKind
  commitmentId: Hex
  side: Side
  reportNumber: number
  nonce: bigint
  expiry: bigint
}

/** What a supplier receives before it grants capacity, valid for five minutes. */
export interface SupplierAuthorization {
  commitmentId: Hex
  termsHash: Hex
  salt: Hex
  /** Base units of the token. */
  amount: bigint
  token: Address
  buyerBusinessId: string
  kybReference: string
  kybTestData: boolean
  agentKey: Address
  /** The transaction that authorized the agent's key, where Tempo logged the mandate's hash. */
  agentKeyAuthorizedIn: Hex
  mandateHash: Hex
  payee: Address
  acceptBy: bigint
  chargeDeadline: bigint
  releaseDate: bigint
  nonce: bigint
  expiry: bigint
}

/**
 * The administrator's approval of one reserve. It approves only the commitment, terms, amount
 * and supplier it names. The amount is micros of the terms' currency.
 */
export interface HumanApproval {
  mandateHash: Hex
  commitmentId: Hex
  termsHash: Hex
  supplier: string
  payee: Address
  amount: bigint
  nonce: bigint
  expiry: bigint
}

/** The supplier's receipt for a start request Avow timestamped. */
export interface StartReceipt {
  commitmentId: Hex
  side: Side
  startRequestHash: Hex
  startedAt: bigint
  nonce: bigint
  expiry: bigint
}

export const MANDATE_TYPES = {
  PaymentLimit: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'period', type: 'uint64' },
  ],
  Mandate: [
    { name: 'mandateId', type: 'bytes32' },
    { name: 'businessId', type: 'string' },
    { name: 'agentId', type: 'string' },
    { name: 'account', type: 'address' },
    { name: 'agentKey', type: 'address' },
    { name: 'actions', type: 'string[]' },
    { name: 'currency', type: 'string' },
    { name: 'capPerCommitment', type: 'uint256' },
    { name: 'capOpenReserves', type: 'uint256' },
    { name: 'suppliers', type: 'string[]' },
    { name: 'categories', type: 'string[]' },
    { name: 'paymentLimits', type: 'PaymentLimit[]' },
    { name: 'approvalRule', type: 'uint8' },
    { name: 'approvalAbove', type: 'uint256' },
    { name: 'expiry', type: 'uint64' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const

export const TERMS_AGREEMENT_TYPES = {
  TermsAgreement: [
    { name: 'commitmentId', type: 'bytes32' },
    { name: 'termsHash', type: 'bytes32' },
    { name: 'category', type: 'string' },
    { name: 'buyerBusinessId', type: 'string' },
    { name: 'supplierBusinessId', type: 'string' },
    { name: 'mandateHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'expiry', type: 'uint64' },
  ],
} as const

const CHARGE_FIELDS = [
  { name: 'kind', type: 'uint8' },
  { name: 'most', type: 'uint256' },
  { name: 'earliest', type: 'uint64' },
] as const

/** The lock's `Approval`, field for field, as the lock checks it. */
export const APPROVAL_TYPES = {
  Approval: [
    { name: 'commitmentId', type: 'bytes32' },
    { name: 'side', type: 'uint8' },
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'supplier', type: 'address' },
    { name: 'supplierSigner', type: 'address' },
    { name: 'payee', type: 'address' },
    { name: 'freeCancelBy', type: 'uint64' },
    { name: 'acceptBy', type: 'uint64' },
    { name: 'chargeDeadline', type: 'uint64' },
    { name: 'releaseDate', type: 'uint64' },
    { name: 'contestWindow', type: 'uint64' },
    { name: 'charges', type: 'Charge[]' },
    { name: 'day90SupplierShareBps', type: 'uint16' },
    { name: 'arbiter', type: 'address' },
    { name: 'termsHash', type: 'bytes32' },
    { name: 'mandateHash', type: 'bytes32' },
    { name: 'capPerCommitment', type: 'uint256' },
    { name: 'capOpenReserves', type: 'uint256' },
    { name: 'fundingKey', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'expiry', type: 'uint64' },
  ],
  Charge: CHARGE_FIELDS,
} as const

export const ACCEPTANCE_TYPES = {
  Acceptance: [
    { name: 'commitmentId', type: 'bytes32' },
    { name: 'side', type: 'uint8' },
    { name: 'approvalHash', type: 'bytes32' },
    { name: 'termsHash', type: 'bytes32' },
    { name: 'amount', type: 'uint256' },
    { name: 'token', type: 'address' },
    { name: 'acceptBy', type: 'uint64' },
    { name: 'nonce', type: 'uint256' },
    { name: 'expiry', type: 'uint64' },
  ],
} as const

export const REPORT_TYPES = {
  Report: [
    { name: 'commitmentId', type: 'bytes32' },
    { name: 'side', type: 'uint8' },
    { name: 'kind', type: 'uint8' },
    { name: 'amount', type: 'uint256' },
    { name: 'evidenceHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'expiry', type: 'uint64' },
  ],
} as const

export const RELEASE_CONSENT_TYPES = {
  ReleaseConsent: [
    { name: 'commitmentId', type: 'bytes32' },
    { name: 'side', type: 'uint8' },
    { name: 'reportCount', type: 'uint8' },
    { name: 'reason', type: 'uint8' },
    { name: 'evidenceHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'expiry', type: 'uint64' },
  ],
} as const

export const EVIDENCE_TYPES = {
  Evidence: [
    { name: 'commitmentId', type: 'bytes32' },
    { name: 'side', type: 'uint8' },
    { name: 'number', type: 'uint16' },
    { name: 'evidenceHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'expiry', type: 'uint64' },
  ],
} as const

export const BUSINESS_ACTION_TYPES = {
  BusinessAction: [
    { name: 'action', type: 'uint8' },
    { name: 'commitmentId', type: 'bytes32' },
    { name: 'side', type: 'uint8' },
    { name: 'reportNumber', type: 'uint8' },
    { name: 'reasonCode', type: 'uint16' },
    { name: 'evidenceNumber', type: 'uint16' },
    { name: 'dataHash', type: 'bytes32' },
    { name: 'supplier', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'expiry', type: 'uint64' },
  ],
} as const

export const SUPPLIER_ACTION_TYPES = {
  SupplierAction: [
    { name: 'supplier', type: 'address' },
    { name: 'action', type: 'uint8' },
    { name: 'commitmentId', type: 'bytes32' },
    { name: 'side', type: 'uint8' },
    { name: 'reportNumber', type: 'uint8' },
    { name: 'nonce', type: 'uint256' },
    { name: 'expiry', type: 'uint64' },
  ],
} as const

export const SUPPLIER_AUTHORIZATION_TYPES = {
  SupplierAuthorization: [
    { name: 'commitmentId', type: 'bytes32' },
    { name: 'termsHash', type: 'bytes32' },
    { name: 'salt', type: 'bytes32' },
    { name: 'amount', type: 'uint256' },
    { name: 'token', type: 'address' },
    { name: 'buyerBusinessId', type: 'string' },
    { name: 'kybReference', type: 'string' },
    { name: 'kybTestData', type: 'bool' },
    { name: 'agentKey', type: 'address' },
    { name: 'agentKeyAuthorizedIn', type: 'bytes32' },
    { name: 'mandateHash', type: 'bytes32' },
    { name: 'payee', type: 'address' },
    { name: 'acceptBy', type: 'uint64' },
    { name: 'chargeDeadline', type: 'uint64' },
    { name: 'releaseDate', type: 'uint64' },
    { name: 'nonce', type: 'uint256' },
    { name: 'expiry', type: 'uint64' },
  ],
} as const

export const HUMAN_APPROVAL_TYPES = {
  HumanApproval: [
    { name: 'mandateHash', type: 'bytes32' },
    { name: 'commitmentId', type: 'bytes32' },
    { name: 'termsHash', type: 'bytes32' },
    { name: 'supplier', type: 'string' },
    { name: 'payee', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'expiry', type: 'uint64' },
  ],
} as const

export const START_RECEIPT_TYPES = {
  StartReceipt: [
    { name: 'commitmentId', type: 'bytes32' },
    { name: 'side', type: 'uint8' },
    { name: 'startRequestHash', type: 'bytes32' },
    { name: 'startedAt', type: 'uint64' },
    { name: 'nonce', type: 'uint256' },
    { name: 'expiry', type: 'uint64' },
  ],
} as const

export function mandateTypedData(m: Mandate, d: AvowDomain) {
  return {
    domain: domain(d, MESSAGE_VERSIONS.Mandate),
    types: MANDATE_TYPES,
    primaryType: 'Mandate' as const,
    message: {
      mandateId: m.mandateId,
      businessId: m.businessId,
      agentId: m.agentId,
      account: m.account,
      agentKey: m.agentKey,
      actions: [...m.actions],
      currency: m.currency,
      capPerCommitment: m.capPerCommitment,
      capOpenReserves: m.capOpenReserves,
      suppliers: [...m.suppliers],
      categories: [...m.categories],
      paymentLimits: m.paymentLimits.map((l) => ({
        token: l.token,
        amount: l.amount,
        period: l.period,
      })),
      approvalRule: ruleCode[m.approvalRule.kind],
      approvalAbove: m.approvalRule.kind === 'above' ? m.approvalRule.amount : 0n,
      expiry: m.expiry,
      nonce: m.nonce,
    },
  }
}

export function termsAgreementTypedData(a: TermsAgreement, d: AvowDomain) {
  return {
    domain: domain(d, MESSAGE_VERSIONS.TermsAgreement),
    types: TERMS_AGREEMENT_TYPES,
    primaryType: 'TermsAgreement' as const,
    message: { ...a },
  }
}

export function approvalTypedData(a: Approval, d: AvowDomain) {
  return {
    domain: domain(d, MESSAGE_VERSIONS.Approval),
    types: APPROVAL_TYPES,
    primaryType: 'Approval' as const,
    message: {
      ...a,
      side: sideCode[a.side],
      charges: a.charges.map((c) => ({
        kind: CHARGE_KINDS[c.kind],
        most: c.most,
        earliest: c.earliest,
      })),
    },
  }
}

/**
 * The digest of an approval as the lock computes it, under the lock's domain. The lock stores it at
 * the reserve and emits it as `approvalHash`, and the supplier's acceptance names it. The
 * verifier's `prepareAcceptance` computes it, checks it against the lock's, and checks the
 * approval's terms against the supplier's own before it builds an acceptance.
 */
export function approvalDigest(a: Approval, d: AvowDomain): Hex {
  return digestOf(approvalTypedData(a, d))
}

/**
 * The EIP-712 encoding of an acceptance, with no checks. A supplier gets an acceptance to sign from
 * the verifier's `prepareAcceptance`, and signs it with `signAcceptance`.
 */
export function acceptanceTypedData(a: Acceptance, d: AvowDomain) {
  return {
    domain: domain(d, MESSAGE_VERSIONS.Acceptance),
    types: ACCEPTANCE_TYPES,
    primaryType: 'Acceptance' as const,
    message: { ...a, side: sideCode[a.side] },
  }
}

export function reportTypedData(r: ChargeReport, d: AvowDomain) {
  return {
    domain: domain(d, MESSAGE_VERSIONS.Report),
    types: REPORT_TYPES,
    primaryType: 'Report' as const,
    message: { ...r, side: sideCode[r.side], kind: CHARGE_KINDS[r.kind] },
  }
}

export function releaseConsentTypedData(c: ReleaseConsent, d: AvowDomain) {
  return {
    domain: domain(d, MESSAGE_VERSIONS.ReleaseConsent),
    types: RELEASE_CONSENT_TYPES,
    primaryType: 'ReleaseConsent' as const,
    message: { ...c, side: sideCode[c.side], reason: RELEASE_REASONS[c.reason] },
  }
}

export function evidenceTypedData(e: SupplierEvidence, d: AvowDomain) {
  return {
    domain: domain(d, MESSAGE_VERSIONS.Evidence),
    types: EVIDENCE_TYPES,
    primaryType: 'Evidence' as const,
    message: { ...e, side: sideCode[e.side] },
  }
}

export function businessActionTypedData(a: BusinessAction, d: AvowDomain) {
  return {
    domain: domain(d, MESSAGE_VERSIONS.BusinessAction),
    types: BUSINESS_ACTION_TYPES,
    primaryType: 'BusinessAction' as const,
    message: { ...a, action: BUSINESS_ACTIONS[a.action], side: sideCode[a.side] },
  }
}

export function supplierActionTypedData(a: SupplierAction, d: AvowDomain) {
  return {
    domain: domain(d, MESSAGE_VERSIONS.SupplierAction),
    types: SUPPLIER_ACTION_TYPES,
    primaryType: 'SupplierAction' as const,
    message: { ...a, action: SUPPLIER_ACTIONS[a.action], side: sideCode[a.side] },
  }
}

const ZERO_HASH: Hex = `0x${'00'.repeat(32)}`
const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000'

/** The business's contest of a report or a pending charge, as a signed action. */
export function contestAction(args: {
  commitmentId: Hex
  reportNumber: number
  reasonCode: number
  statementHash: Hex
  nonce: bigint
  expiry: bigint
}): BusinessAction {
  return {
    action: 'contest',
    commitmentId: args.commitmentId,
    side: 'buyer',
    reportNumber: args.reportNumber,
    reasonCode: args.reasonCode,
    evidenceNumber: 0,
    dataHash: args.statementHash,
    supplier: ZERO_ADDRESS,
    nonce: args.nonce,
    expiry: args.expiry,
  }
}

/** One piece of the business's evidence on a paused charge, as a signed action. */
export function evidenceAction(args: {
  commitmentId: Hex
  evidenceNumber: number
  evidenceHash: Hex
  nonce: bigint
  expiry: bigint
}): BusinessAction {
  return {
    action: 'evidence',
    commitmentId: args.commitmentId,
    side: 'buyer',
    reportNumber: 0,
    reasonCode: 0,
    evidenceNumber: args.evidenceNumber,
    dataHash: args.evidenceHash,
    supplier: ZERO_ADDRESS,
    nonce: args.nonce,
    expiry: args.expiry,
  }
}

/**
 * A change to the business's approved suppliers, as a signed action. `changeCount` is the lock's
 * `supplierChanges(supplier)` when the business signs.
 */
export function supplierListAction(args: {
  supplier: Address
  approve: boolean
  changeCount: bigint
  expiry: bigint
}): BusinessAction {
  return {
    action: args.approve ? 'approveSupplier' : 'removeSupplier',
    commitmentId: ZERO_HASH,
    side: 'buyer',
    reportNumber: 0,
    reasonCode: 0,
    evidenceNumber: 0,
    dataHash: ZERO_HASH,
    supplier: args.supplier,
    nonce: args.changeCount,
    expiry: args.expiry,
  }
}

export function supplierAuthorizationTypedData(a: SupplierAuthorization, d: AvowDomain) {
  return {
    domain: domain(d, MESSAGE_VERSIONS.SupplierAuthorization),
    types: SUPPLIER_AUTHORIZATION_TYPES,
    primaryType: 'SupplierAuthorization' as const,
    message: { ...a },
  }
}

export function humanApprovalTypedData(a: HumanApproval, d: AvowDomain) {
  return {
    domain: domain(d, MESSAGE_VERSIONS.HumanApproval),
    types: HUMAN_APPROVAL_TYPES,
    primaryType: 'HumanApproval' as const,
    message: { ...a },
  }
}

export function startReceiptTypedData(r: StartReceipt, d: AvowDomain) {
  return {
    domain: domain(d, MESSAGE_VERSIONS.StartReceipt),
    types: START_RECEIPT_TYPES,
    primaryType: 'StartReceipt' as const,
    message: { ...r, side: sideCode[r.side] },
  }
}

/**
 * The mandate's hash, bound into the agent key's authorization on Tempo as its witness. It
 * includes the domain, so a mandate for one lock or chain can't stand in for another.
 */
export function mandateHash(m: Mandate, d: AvowDomain): Hex {
  return hashTypedData(mandateTypedData(m, d))
}

export type AvowTypedData =
  | ReturnType<typeof mandateTypedData>
  | ReturnType<typeof termsAgreementTypedData>
  | ReturnType<typeof approvalTypedData>
  | ReturnType<typeof supplierAuthorizationTypedData>
  | ReturnType<typeof humanApprovalTypedData>
  | ReturnType<typeof startReceiptTypedData>
  | ReturnType<typeof acceptanceTypedData>
  | ReturnType<typeof reportTypedData>
  | ReturnType<typeof releaseConsentTypedData>
  | ReturnType<typeof evidenceTypedData>
  | ReturnType<typeof businessActionTypedData>
  | ReturnType<typeof supplierActionTypedData>

export type MessageType = AvowTypedData['primaryType']

// Every message type has a version, and no version names a type that doesn't exist.
const _everyTypeVersioned: { readonly [T in MessageType]: string } = MESSAGE_VERSIONS
const _noUnknownTypes: {
  readonly [T in keyof typeof MESSAGE_VERSIONS]: T extends MessageType ? string : never
} = MESSAGE_VERSIONS
void _everyTypeVersioned
void _noUnknownTypes

/** The EIP-712 digest a signer signs. */
export function digestOf(td: AvowTypedData): Hex {
  switch (td.primaryType) {
    case 'Mandate':
      return hashTypedData(td)
    case 'TermsAgreement':
      return hashTypedData(td)
    case 'Approval':
      return hashTypedData(td)
    case 'SupplierAuthorization':
      return hashTypedData(td)
    case 'HumanApproval':
      return hashTypedData(td)
    case 'StartReceipt':
      return hashTypedData(td)
    case 'Acceptance':
      return hashTypedData(td)
    case 'Report':
      return hashTypedData(td)
    case 'ReleaseConsent':
      return hashTypedData(td)
    case 'Evidence':
      return hashTypedData(td)
    case 'BusinessAction':
      return hashTypedData(td)
    case 'SupplierAction':
      return hashTypedData(td)
  }
}

/**
 * Checks a signature over a digest. The default recovers a secp256k1 signer. A passkey or an
 * admin key signing for a Tempo account goes through the keychain's verifier instead, so callers
 * that accept those pass their own check.
 */
export type SignatureCheck = (args: {
  signer: Address
  digest: Hex
  signature: Hex
}) => Promise<boolean>

export async function isSignedBy(
  typedData: AvowTypedData,
  signature: Hex,
  signer: Address,
  check?: SignatureCheck,
): Promise<boolean> {
  let digest: Hex
  try {
    digest = digestOf(typedData)
  } catch {
    // A value EIP-712 can't encode, such as a time above uint64, signs nothing.
    return false
  }
  if (check) return check({ signer, digest, signature })
  try {
    const recovered = await recoverAddress({ hash: digest, signature })
    return isAddressEqual(recovered, signer)
  } catch {
    return false
  }
}

/**
 * How a signed message travels as data. Its version, chain and lock make up the EIP-712 domain, and
 * `schemaVersion` is the message type's own version (`MESSAGE_VERSIONS`).
 */
export interface Signed<T> {
  type: MessageType
  schemaVersion: string
  chainId: number
  lock: Address
  message: T
  signature: Hex
}

/**
 * Checks a signed message's envelope before its signature. The lock is checked when the reader
 * already knows it, and a supplier who learns the lock from the message checks it on-chain.
 */
export function checkEnvelope(
  env: Pick<Signed<unknown>, 'type' | 'schemaVersion' | 'chainId' | 'lock'>,
  expected: { type: MessageType; chainId: number; lock?: Address },
): ReasonCode | null {
  // The type is checked first, so the version lookup only ever sees a type this code names.
  if (env.type !== expected.type) return 'message.schema_unknown'
  if (!isSupportedMessageVersion(env.type, env.schemaVersion)) return 'message.schema_unknown'
  if (env.chainId !== expected.chainId) return 'message.wrong_chain'
  if (expected.lock && !isAddressEqual(env.lock, expected.lock)) return 'message.wrong_contract'
  return null
}

/**
 * A replay guard's key for one exact message: its type and EIP-712 digest. The digest covers the
 * chain, the lock, the commitment and every field, so two different messages never share a key,
 * whatever nonces their signers chose.
 */
export function messageKey(td: AvowTypedData): string {
  return `${td.primaryType}:${digestOf(td)}`
}

/** A replay guard's key for something a commitment may have only once, such as an authorization. */
export function commitmentKey(type: MessageType, d: AvowDomain, commitmentId: Hex): string {
  return `${type}:${d.chainId}:${d.verifyingContract.toLowerCase()}:${commitmentId.toLowerCase()}`
}
