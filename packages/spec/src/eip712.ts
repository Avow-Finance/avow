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
import { DOMAIN_NAME, isSupportedSchemaVersion, SCHEMA_VERSION } from './version.js'

/**
 * Every signed message is EIP-712 typed data. The domain names the schema version, the chain and
 * the buyer's lock, and each message carries a nonce and an expiry, so it can't be replayed on
 * another chain or lock or changed without breaking the signature.
 */
export interface AvowDomain {
  chainId: number
  /** The buyer's lock, which every message for its commitments names. */
  verifyingContract: Address
}

export function domain(d: AvowDomain, version: string = SCHEMA_VERSION): TypedDataDomain {
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

/**
 * Avow's approval of the mandate check, which the lock requires before it takes a reserve.
 * Amounts are the token's base units, since the lock enforces them.
 */
export interface Approval {
  commitmentId: Hex
  side: Side
  token: Address
  amount: bigint
  payee: Address
  acceptBy: bigint
  chargeDeadline: bigint
  contestWindow: bigint
  releaseDate: bigint
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

export const APPROVAL_TYPES = {
  Approval: [
    { name: 'commitmentId', type: 'bytes32' },
    { name: 'side', type: 'uint8' },
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'payee', type: 'address' },
    { name: 'acceptBy', type: 'uint64' },
    { name: 'chargeDeadline', type: 'uint64' },
    { name: 'contestWindow', type: 'uint64' },
    { name: 'releaseDate', type: 'uint64' },
    { name: 'termsHash', type: 'bytes32' },
    { name: 'mandateHash', type: 'bytes32' },
    { name: 'capPerCommitment', type: 'uint256' },
    { name: 'capOpenReserves', type: 'uint256' },
    { name: 'fundingKey', type: 'address' },
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
    domain: domain(d),
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
    domain: domain(d),
    types: TERMS_AGREEMENT_TYPES,
    primaryType: 'TermsAgreement' as const,
    message: { ...a },
  }
}

export function approvalTypedData(a: Approval, d: AvowDomain) {
  return {
    domain: domain(d),
    types: APPROVAL_TYPES,
    primaryType: 'Approval' as const,
    message: { ...a, side: sideCode[a.side] },
  }
}

export function supplierAuthorizationTypedData(a: SupplierAuthorization, d: AvowDomain) {
  return {
    domain: domain(d),
    types: SUPPLIER_AUTHORIZATION_TYPES,
    primaryType: 'SupplierAuthorization' as const,
    message: { ...a },
  }
}

export function humanApprovalTypedData(a: HumanApproval, d: AvowDomain) {
  return {
    domain: domain(d),
    types: HUMAN_APPROVAL_TYPES,
    primaryType: 'HumanApproval' as const,
    message: { ...a },
  }
}

export function startReceiptTypedData(r: StartReceipt, d: AvowDomain) {
  return {
    domain: domain(d),
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

export type MessageType = AvowTypedData['primaryType']

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

/** How a signed message travels as data. Its version, chain and lock make up the EIP-712 domain. */
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
  if (!isSupportedSchemaVersion(env.schemaVersion)) return 'message.schema_unknown'
  if (env.type !== expected.type) return 'message.schema_unknown'
  if (env.chainId !== expected.chainId) return 'message.wrong_chain'
  if (expected.lock && !isAddressEqual(env.lock, expected.lock)) return 'message.wrong_contract'
  return null
}

/** The key a replay guard records, one per signer, message type and nonce. */
export function replayKey(type: MessageType, signer: Address, nonce: bigint): string {
  return `${type}:${signer.toLowerCase()}:${nonce}`
}
