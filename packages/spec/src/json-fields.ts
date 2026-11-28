import type { Address, Hex } from 'viem'
import { z } from 'zod'

/**
 * The JSON field forms every parser in this package shares. JSON has no bigint, so amounts and
 * times travel as decimal strings and parse into bigints here. Hex parses to lower case, so a relay
 * that changes letter case can't make two equal values compare as different, and a mixed-case
 * address with a bad checksum can't make a check throw.
 */
const uint = (bits: number) =>
  z
    .string()
    .regex(/^(0|[1-9][0-9]*)$/, 'a whole number as a decimal string')
    .transform((s) => BigInt(s))
    .refine((v) => v < 2n ** BigInt(bits), `a whole number below 2^${bits}`)

/** Times, durations and expiries, which signed messages carry as uint64. */
export const u64 = uint(64)
/** Amounts and nonces. */
export const u256 = uint(256)
/** A business id as every message names one. */
export const businessIdJson = z.string().min(1).max(100)
export const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((s) => s.toLowerCase() as Address)
export const bytes32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((s) => s.toLowerCase() as Hex)
export const hexBytes = z
  .string()
  .regex(/^0x([0-9a-fA-F]{2})*$/)
  .transform((s) => s.toLowerCase() as Hex)
export const side = z.enum(['buyer', 'supplier'])

/** Any JSON object, whose fields a parser reads on its own afterwards. */
export const objectJson = z.record(z.string(), z.unknown())

/**
 * A signed message inside a body, which the body's parser checks against the message's own schema
 * and domain after the outer shape passes. The description names it, for the API reference.
 */
export const signedJson = (description: string) => objectJson.describe(description)

/** Whether two hex strings hold the same bytes, whatever case each is written in. */
export const sameHex = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
