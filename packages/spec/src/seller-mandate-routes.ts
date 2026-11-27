import { type Address, type Hex, zeroHash } from 'viem'
import { z } from 'zod'
import type { Signed } from './eip712.js'
import { bytes32, signedJson, u64 } from './json-fields.js'
import { parseSellerMandate, type SellerMandate } from './seller-mandate.js'
import type { Parsed } from './wire.js'

/**
 * What the two routes for a seller's mandate take and answer, at `SANDBOX_PATHS.sellerMandate` and
 * `SANDBOX_PATHS.sellerMandates`. The first is to record a mandate the business account signed, and
 * the second is to serve a selling agent every mandate its signing key has held. Avow takes neither
 * yet. Both are to keep and hand back what an administrator signed and no more, so neither is to
 * hold a sale to a mandate's limits.
 */

/** The body that posts a seller's mandate, which carries the mandate and nothing else. */
export interface SellerMandatePost {
  /** The mandate the business account's root key signed, under the business's own lock. */
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

/** The body of a selling agent's read of its own mandates, which is an empty object. */
export type SellerMandatesRequest = Record<string, never>

export const sellerMandatePostJson = z.strictObject({
  mandate: signedJson(
    "The seller's mandate, as a signed SellerMandate the business account's root key signed",
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
