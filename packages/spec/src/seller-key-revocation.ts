import { type Address, type Hex, hashTypedData, isAddressEqual } from 'viem'
import { z } from 'zod'
import {
  type AvowDomain,
  checkEnvelope,
  domain,
  isSignedBy,
  type SignatureCheck,
  type Signed,
} from './eip712.js'
import { holdsOnly, LOWER_ADDRESS } from './fields.js'
import { address } from './json-fields.js'
import type { ReasonCode } from './reasons.js'
import { BUSINESS_ID_MAX } from './service.js'
import { isSoundText } from './text.js'
import { MESSAGE_VERSIONS } from './version.js'
import { type Parsed, parseSigned } from './wire.js'

/**
 * A revocation is the administrator's word that one selling agent's authority has ended, for good.
 * The business account's root key signs it under the business's own lock, as it signs a seller's
 * mandate. It names the agent's signing key and no mandate, and it ends every seller's mandate the
 * account signed for that key under that lock, whenever each was signed. A signature carries no
 * time, so nothing could say whether a mandate came before a revocation or after it, and a rule
 * that needs no order is the only one a reader can hold. A revoked key is never given a seller's
 * mandate again, as a buyer's revoked agent key can never be authorized again. An agent sells
 * again under a new key.
 *
 * It carries no time and never expires. Whoever records one notes when it arrived. It ends the
 * authority to make new promises. It takes no key off a lock, and a commitment already made stays
 * in force.
 *
 * This module holds the message. Nothing in this package stores one, and no call an agent can
 * reach signs one.
 */
export interface SellerKeyRevocation {
  businessId: string
  /** The business's account, whose root key signs the revocation. */
  account: Address
  /** The selling agent's signing key, which loses its authority. */
  signingKey: Address
}

export const SELLER_KEY_REVOCATION_TYPES = {
  SellerKeyRevocation: [
    { name: 'businessId', type: 'string' },
    { name: 'account', type: 'address' },
    { name: 'signingKey', type: 'address' },
  ],
} as const

/** A revocation's EIP-712 typed data, under the selling business's own lock. */
export function sellerKeyRevocationTypedData(r: SellerKeyRevocation, d: AvowDomain) {
  return {
    domain: domain(d, MESSAGE_VERSIONS.SellerKeyRevocation),
    types: SELLER_KEY_REVOCATION_TYPES,
    primaryType: 'SellerKeyRevocation' as const,
    message: { businessId: r.businessId, account: r.account, signingKey: r.signingKey },
  }
}

/** A revocation's hash, which the business account's root key signs. */
export function sellerKeyRevocationHash(r: SellerKeyRevocation, d: AvowDomain): Hex {
  return hashTypedData(sellerKeyRevocationTypedData(r, d))
}

const REVOCATION_KEYS = SELLER_KEY_REVOCATION_TYPES.SellerKeyRevocation.map((f) => f.name)

/**
 * Checks a revocation on its own, and gives `message.invalid` for one that isn't well formed. It
 * never throws, whatever it's given, and a revocation that passes hashes in one way only. So it
 * holds exactly the three fields the signed form names, with both addresses in lower case.
 */
export function sellerKeyRevocationProblem(r: SellerKeyRevocation): ReasonCode | null {
  try {
    return isSound(r) ? null : 'message.invalid'
  } catch {
    // A value that throws when read is no revocation.
    return 'message.invalid'
  }
}

function isSound(v: unknown): boolean {
  if (typeof v !== 'object' || v === null || !holdsOnly(v, REVOCATION_KEYS)) return false
  const r = v as Record<string, unknown>
  if (!isSoundText(r.businessId, BUSINESS_ID_MAX)) return false
  if (typeof r.account !== 'string' || !LOWER_ADDRESS.test(r.account)) return false
  return typeof r.signingKey === 'string' && LOWER_ADDRESS.test(r.signingKey)
}

/** Whose selling agent a revocation or a seller's mandate names. */
export interface SellingAgent {
  businessId: string
  account: Address
  signingKey: Address
}

/**
 * Whether a revocation names this selling agent: the same business, account and signing key. A
 * seller's mandate is one such, so this says whether a revocation ends a given mandate, under the
 * lock both were signed for. It never throws, and it's false unless the revocation is well formed
 * and the agent's addresses are addresses.
 */
export function revokesSellerKey(r: SellerKeyRevocation, agent: SellingAgent): boolean {
  try {
    if (sellerKeyRevocationProblem(r)) return false
    return (
      r.businessId === agent.businessId &&
      isAddressEqual(r.account, agent.account) &&
      isAddressEqual(r.signingKey, agent.signingKey)
    )
  } catch {
    return false
  }
}

/** A revocation as JSON, and nothing else in it. `sellerKeyRevocationProblem` holds its rules. */
export const sellerKeyRevocationJson = z.strictObject({
  businessId: z.string(),
  account: address,
  signingKey: address,
})

/**
 * Reads a signed revocation from JSON, checking its envelope against the chain and, when given, the
 * selling business's lock. The signature is the caller's to check, against the business account.
 */
export function parseSellerKeyRevocation(
  json: unknown,
  expected: { chainId: number; lock?: Address },
): Parsed<Signed<SellerKeyRevocation>> {
  const signed = parseSigned(json, 'SellerKeyRevocation', sellerKeyRevocationJson, expected)
  if (!signed.ok) return signed
  const problem = sellerKeyRevocationProblem(signed.value.message)
  return problem ? { ok: false, reason: problem } : signed
}

/**
 * Checks a signed revocation whole, for whoever records one: its envelope is a revocation's for
 * the lock, it's well formed, it names the expected selling agent, and the business account signed
 * it. It gives `message.signature_invalid` when the account didn't. The default check recovers a
 * secp256k1 signer, and an account whose root key is a passkey takes the caller's own check. It
 * throws only what that check throws.
 */
export async function sellerKeyRevocationSignatureProblem(
  revocation: Signed<SellerKeyRevocation>,
  expected: { domain: AvowDomain } & SellingAgent,
  check?: SignatureCheck,
): Promise<ReasonCode | null> {
  let message: SellerKeyRevocation
  let signature: Hex
  try {
    const envelope = checkEnvelope(revocation, {
      type: 'SellerKeyRevocation',
      chainId: expected.domain.chainId,
      lock: expected.domain.verifyingContract,
    })
    if (envelope) return envelope
    // Read once, so what's checked is what's hashed.
    message = structuredClone(revocation.message)
    signature = revocation.signature
    if (!revokesSellerKey(message, expected)) return 'message.invalid'
  } catch {
    return 'message.invalid'
  }
  const typedData = sellerKeyRevocationTypedData(message, expected.domain)
  const signed = await isSignedBy(typedData, signature, expected.account, check)
  return signed ? null : 'message.signature_invalid'
}
