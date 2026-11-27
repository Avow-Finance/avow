import { type Address, type Hex, hashTypedData, isAddressEqual, zeroHash } from 'viem'
import { z } from 'zod'
import { type AvowDomain, domain, isSignedBy, type SignatureCheck, type Signed } from './eip712.js'
import { LOWER_ADDRESS, LOWER_BYTES32 } from './fields.js'
import { address, bytes32 } from './json-fields.js'
import type { ReasonCode } from './reasons.js'
import { type SellerMandate, sellerMandateHash } from './seller-mandate.js'
import { BUSINESS_ID_MAX } from './service.js'
import { isSoundText } from './text.js'
import { MESSAGE_VERSIONS } from './version.js'
import { type Parsed, parseSigned } from './wire.js'

/**
 * A revocation is the administrator's word that a selling agent's authority has ended. The
 * business account's root key signs it under the business's own lock, as it signs the mandate. It
 * names one seller's mandate by hash, and it ends that mandate and every mandate that replaces it,
 * since a signature carries no time and nothing else could say which came first.
 *
 * It repeats the business, the account and the signing key the mandate names, so someone shown
 * the revocation alone learns whose agent lost its authority without reading the mandate, whose
 * limits are the seller's own. It carries no time and never expires. Whoever records one notes
 * when it arrived.
 *
 * This module holds the message. Nothing in this package stores one, and no call an agent can
 * reach signs one.
 */
export interface SellerMandateRevocation {
  businessId: string
  /** The business's account, whose root key signs the revocation. */
  account: Address
  /** The signing key the revoked mandate binds. */
  signingKey: Address
  /** The hash of the seller's mandate it revokes. */
  mandate: Hex
}

export const SELLER_MANDATE_REVOCATION_TYPES = {
  SellerMandateRevocation: [
    { name: 'businessId', type: 'string' },
    { name: 'account', type: 'address' },
    { name: 'signingKey', type: 'address' },
    { name: 'mandate', type: 'bytes32' },
  ],
} as const

/** A revocation's EIP-712 typed data, under the selling business's own lock. */
export function sellerMandateRevocationTypedData(r: SellerMandateRevocation, d: AvowDomain) {
  return {
    domain: domain(d, MESSAGE_VERSIONS.SellerMandateRevocation),
    types: SELLER_MANDATE_REVOCATION_TYPES,
    primaryType: 'SellerMandateRevocation' as const,
    message: {
      businessId: r.businessId,
      account: r.account,
      signingKey: r.signingKey,
      mandate: r.mandate,
    },
  }
}

/** A revocation's hash, which the business account's root key signs. */
export function sellerMandateRevocationHash(r: SellerMandateRevocation, d: AvowDomain): Hex {
  return hashTypedData(sellerMandateRevocationTypedData(r, d))
}

const REVOCATION_KEYS = SELLER_MANDATE_REVOCATION_TYPES.SellerMandateRevocation.map((f) => f.name)

/**
 * Checks a revocation on its own, and gives `message.invalid` for one that isn't well formed. It
 * never throws, whatever it's given, and a revocation that passes hashes in one way only. So it
 * holds exactly the four fields the signed form names, with addresses and the hash in lower case,
 * and the hash isn't zero, which names no mandate.
 */
export function sellerMandateRevocationProblem(r: SellerMandateRevocation): ReasonCode | null {
  try {
    return isSound(r) ? null : 'message.invalid'
  } catch {
    // A value that throws when read is no revocation.
    return 'message.invalid'
  }
}

function isSound(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false
  const keys = Object.keys(v)
  if (keys.length !== REVOCATION_KEYS.length) return false
  if (!REVOCATION_KEYS.every((k) => Object.hasOwn(v, k))) return false
  const r = v as Record<string, unknown>
  if (!isSoundText(r.businessId, BUSINESS_ID_MAX)) return false
  if (typeof r.account !== 'string' || !LOWER_ADDRESS.test(r.account)) return false
  if (typeof r.signingKey !== 'string' || !LOWER_ADDRESS.test(r.signingKey)) return false
  return typeof r.mandate === 'string' && LOWER_BYTES32.test(r.mandate) && r.mandate !== zeroHash
}

/**
 * Whether a revocation names this mandate: its hash under the lock, and the same business, account
 * and signing key. It's false unless the revocation is well formed. It reads a mandate
 * `sellerMandateProblem` passes, and says nothing of the mandates that replace this one, which
 * `sellerMandateChainProblem` follows.
 */
export function revokesSellerMandate(
  r: SellerMandateRevocation,
  m: SellerMandate,
  d: AvowDomain,
): boolean {
  if (sellerMandateRevocationProblem(r)) return false
  return (
    r.businessId === m.businessId &&
    r.account === m.account &&
    r.signingKey === m.signingKey &&
    r.mandate === sellerMandateHash(m, d)
  )
}

/** A revocation as JSON, and nothing else in it. `sellerMandateRevocationProblem` holds its rules. */
export const sellerMandateRevocationJson = z.strictObject({
  businessId: z.string(),
  account: address,
  signingKey: address,
  mandate: bytes32,
})

/**
 * Reads a signed revocation from JSON, checking its envelope against the chain and, when given, the
 * selling business's lock. The signature is the caller's to check, against the business account.
 */
export function parseSellerMandateRevocation(
  json: unknown,
  expected: { chainId: number; lock?: Address },
): Parsed<Signed<SellerMandateRevocation>> {
  const signed = parseSigned(json, 'SellerMandateRevocation', sellerMandateRevocationJson, expected)
  if (!signed.ok) return signed
  const problem = sellerMandateRevocationProblem(signed.value.message)
  return problem ? { ok: false, reason: problem } : signed
}

/**
 * Checks the business account signed a revocation, for whoever records one, and gives
 * `message.signature_invalid` when it didn't or the revocation names another account. The default
 * check recovers a secp256k1 signer. An account whose root key is a passkey takes the caller's own
 * check.
 */
export async function sellerMandateRevocationSignatureProblem(
  revocation: Signed<SellerMandateRevocation>,
  expected: { domain: AvowDomain; account: Address },
  check?: SignatureCheck,
): Promise<ReasonCode | null> {
  if (sellerMandateRevocationProblem(revocation.message)) return 'message.invalid'
  if (!isAddressEqual(revocation.message.account, expected.account)) {
    return 'message.signature_invalid'
  }
  const typedData = sellerMandateRevocationTypedData(revocation.message, expected.domain)
  const signed = await isSignedBy(typedData, revocation.signature, expected.account, check)
  return signed ? null : 'message.signature_invalid'
}
