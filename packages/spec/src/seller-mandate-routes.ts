import { type Address, type Hex, zeroHash } from 'viem'
import { z } from 'zod'
import type { Signed } from './eip712.js'
import { address, bytes32, signedJson, u64 } from './json-fields.js'
import { parseSellerKeyRevocation, type SellerKeyRevocation } from './seller-key-revocation.js'
import { parseSellerMandate, type SellerMandate } from './seller-mandate.js'
import type { Parsed } from './wire.js'

/**
 * What the three routes for a seller's mandate take and answer, at `SANDBOX_PATHS.sellerMandate`,
 * `SANDBOX_PATHS.sellerMandates` and `SANDBOX_PATHS.sellerKeyRevocation`. The first is to record a
 * mandate the business account signed, the second is to serve a selling agent every mandate its
 * signing key has held, and the third is to record the account's revocation of a selling agent's
 * key. Avow takes none of them yet. They are to keep and hand back what an administrator signed and
 * no more, so none is to hold a sale to a mandate's limits.
 */

/** The body that posts a seller's mandate, which carries the mandate and nothing else. */
export interface SellerMandatePost {
  /**
   * The mandate the business account's root key or one of its admin keys signed, under the
   * business's own lock.
   */
  mandate: Signed<SellerMandate>
}

/**
 * The answer to a posted seller's mandate, once it is recorded. It holds nothing of the mandate's
 * terms, since whoever posts one isn't authenticated and a seller's limits are its own. A caller
 * that holds the mandate works out `mandateHash` itself with `sellerMandateHash` and compares.
 * Posting the same mandate again answers the same `mandateHash`, `replaces` and `recordedAt`, and
 * only `current` may differ.
 */
export interface SellerMandateReceipt {
  /** The hash of the mandate recorded. */
  mandateHash: Hex
  /** The hash of the mandate it replaces, or null when it replaces none. */
  replaces: Hex | null
  /** When the mandate was first recorded, in unix seconds by the clock of whoever records it. */
  recordedAt: bigint
  /**
   * Whether the mandate is the signing key's current one when the answer is given. It is false
   * once a later mandate replaces it, and once the key is revoked.
   */
  current: boolean
}

/** The body that posts a revocation of a selling agent's key, which carries it and nothing else. */
export interface SellerKeyRevocationPost {
  /** The revocation the business account signed, under the business's own lock. */
  revocation: Signed<SellerKeyRevocation>
}

/**
 * The answer to a posted revocation, once it is recorded. Posting the same revocation again answers
 * the same receipt. A revocation stops new approvals and new quotes under the key, and it can't
 * invalidate a commitment already made or an approval already issued on-chain.
 */
export interface SellerKeyRevocationReceipt {
  /** The signing key revoked, in lower case. */
  signingKey: Address
  /** When the revocation was first recorded, in unix seconds by the clock of whoever records it. */
  recordedAt: bigint
}

/** The body of a selling agent's read of its own mandates, which is an empty object. */
export type SellerMandatesRequest = Record<string, never>

export const sellerMandatePostJson = z.strictObject({
  mandate: signedJson(
    "The seller's mandate, as a signed SellerMandate the business account's root key or one of its admin keys signed",
  ),
})

export const sellerMandateReceiptJson = z.strictObject({
  mandateHash: bytes32,
  // A mandate that replaces none says null, so a zero hash would say the same thing a second way.
  replaces: bytes32.refine((h) => h !== zeroHash, "a seller's mandate hash").nullable(),
  recordedAt: u64,
  current: z.boolean(),
})

export const sellerMandatesRequestJson = z.strictObject({})

export const sellerKeyRevocationPostJson = z.strictObject({
  revocation: signedJson(
    "The revocation of the selling agent's key, as a signed SellerKeyRevocation the business account signed",
  ),
})

export const sellerKeyRevocationReceiptJson = z.strictObject({
  signingKey: address,
  recordedAt: u64,
})

const invalid = { ok: false, reason: 'message.invalid' } as const

/** Reads a value that may be anything, and answers `message.invalid` for one that throws when read. */
function reading<T>(read: () => Parsed<T>): Parsed<T> {
  try {
    return read()
  } catch {
    return invalid
  }
}

/**
 * Parses the body that posts a seller's mandate. The mandate has to parse as `parseSellerMandate`
 * reads one, for this chain and, when given, the selling business's lock, and a refusal keeps that
 * reason. The route is unsigned, so the lock comes from the business the mandate names. A caller
 * that reads the body before it knows that business leaves `lock` out, and then has to compare
 * `mandate.lock` with the named business's lock before it does anything else with the mandate. The
 * signature is the caller's to check against that business's account. It never throws.
 */
export function parseSellerMandatePost(
  json: unknown,
  expected: { chainId: number; lock?: Address },
): Parsed<SellerMandatePost> {
  return reading(() => {
    const outer = sellerMandatePostJson.safeParse(json)
    if (!outer.success) return invalid
    const mandate = parseSellerMandate(outer.data.mandate, expected)
    if (!mandate.ok) return mandate
    return { ok: true, value: { mandate: mandate.value } }
  })
}

/**
 * Parses the receipt for a posted seller's mandate. Its hashes read in either case and come back in
 * lower case, its time is a decimal string, and it holds no other field. It never throws.
 */
export function parseSellerMandateReceipt(json: unknown): Parsed<SellerMandateReceipt> {
  return reading(() => {
    const parsed = sellerMandateReceiptJson.safeParse(json)
    return parsed.success ? { ok: true, value: parsed.data } : invalid
  })
}

/** Parses the body of a selling agent's read of its own mandates. It never throws. */
export function parseSellerMandatesRequest(json: unknown): Parsed<SellerMandatesRequest> {
  return reading(() => {
    const parsed = sellerMandatesRequestJson.safeParse(json)
    return parsed.success ? { ok: true, value: {} } : invalid
  })
}

/**
 * Parses the body that posts a revocation of a selling agent's key. The revocation has to parse as
 * `parseSellerKeyRevocation` reads one, for this chain and, when given, the selling business's
 * lock, and a refusal keeps that reason. The route is unsigned, so the lock comes from the business
 * the revocation names, and a caller that leaves `lock` out has to compare `revocation.lock` with
 * that business's lock before it does anything else with it. The signature is the caller's to
 * check against that business's account. It never throws.
 */
export function parseSellerKeyRevocationPost(
  json: unknown,
  expected: { chainId: number; lock?: Address },
): Parsed<SellerKeyRevocationPost> {
  return reading(() => {
    const outer = sellerKeyRevocationPostJson.safeParse(json)
    if (!outer.success) return invalid
    const revocation = parseSellerKeyRevocation(outer.data.revocation, expected)
    if (!revocation.ok) return revocation
    return { ok: true, value: { revocation: revocation.value } }
  })
}

/**
 * Parses the receipt for a posted revocation. Its key reads in either case and comes back in lower
 * case, its time is a decimal string, and it holds no other field. It never throws.
 */
export function parseSellerKeyRevocationReceipt(json: unknown): Parsed<SellerKeyRevocationReceipt> {
  return reading(() => {
    const parsed = sellerKeyRevocationReceiptJson.safeParse(json)
    return parsed.success ? { ok: true, value: parsed.data } : invalid
  })
}
