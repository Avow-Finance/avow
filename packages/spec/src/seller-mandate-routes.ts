import { type Address, type Hex, zeroHash } from 'viem'
import { z } from 'zod'
import type { Signed } from './eip712.js'
import { LOWER_BYTES32 } from './fields.js'
import { u64 } from './json-fields.js'
import { MAX_MANDATE_CHAIN } from './mandate-chain.js'
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
 */
export interface SellerMandateReceipt {
  /** The hash of the mandate recorded, in lower case. */
  mandateHash: Hex
  /** The hash of the mandate it replaces, in lower case, or null when it replaces none. */
  replaces: Hex | null
  /** When the mandate was first recorded, in unix seconds by the clock of whoever records it. */
  recordedAt: bigint
  /** Whether the mandate is the signing key's current one once it is recorded. */
  current: boolean
}

/** The body of a selling agent's read of its own mandates, which is an empty object. */
export type SellerMandatesRequest = Record<string, never>

const objectJson = z.record(z.string(), z.unknown())

/**
 * A signed message inside a body, which its parser checks against its own schema and domain after
 * the outer shape passes.
 */
const signedJson = (description: string) => objectJson.describe(description)

/** A 32-byte hash written one way, in lower case, so two receipts for one mandate are equal text. */
const lowerHash = z
  .string()
  .regex(LOWER_BYTES32)
  .transform((s) => s as Hex)

export const sellerMandatePostJson = z.strictObject({
  mandate: signedJson(
    "The seller's mandate, as a signed SellerMandate the business account's root key signed",
  ),
})

export const sellerMandateReceiptJson = z.strictObject({
  mandateHash: lowerHash,
  // A mandate that replaces none says null, so a zero hash would say the same thing a second way.
  replaces: lowerHash.refine((h) => h !== zeroHash, "a seller's mandate hash").nullable(),
  recordedAt: u64,
  current: z.boolean(),
})

export const sellerMandatesRequestJson = z.strictObject({})

/**
 * The outer shape of the `SellerMandates` served to a selling agent, which `parseSellerMandates`
 * reads whole. A chain holds at most `MAX_MANDATE_CHAIN` mandates, the current one among them.
 */
export const sellerMandatesJson = z.strictObject({
  current: signedJson("The seller's mandate the agent sells under now, as a signed SellerMandate"),
  earlier: z
    .array(signedJson("A seller's mandate a later one replaced, as a signed SellerMandate"))
    .max(MAX_MANDATE_CHAIN - 1),
  revocation: signedJson(
    "The administrator's revocation of the signing key, as a signed SellerKeyRevocation",
  ).nullable(),
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
 * reason. The route is unsigned, so the lock comes from the business the mandate names, and the
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
 * Parses the receipt for a posted seller's mandate. Its hashes are in lower case and its time is a
 * decimal string, and it holds no other field. It never throws.
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
