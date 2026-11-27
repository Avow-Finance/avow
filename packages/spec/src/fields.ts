/**
 * The rules for a field's value that more than one message shares, each written once. They take
 * `unknown`, since a value read from JSON or a database may be anything, and never throw.
 */

/** Basis points in a whole, the unit every share of a price is written in. */
export const BPS = 10_000n

/** Whether a value is a whole count from 1 to `max`. */
export const isCount = (n: unknown, max: number): n is number =>
  Number.isSafeInteger(n) && (n as number) >= 1 && (n as number) <= max

/** Whether a value is a share in basis points, from 0 to 100%, with zero written one way. */
export const isShare = (bps: unknown): bps is number =>
  Number.isSafeInteger(bps) &&
  (bps as number) >= 0 &&
  (bps as number) <= 10_000 &&
  !Object.is(bps, -0)

/** A 32-byte value in lower-case hex, so the same value is never written two ways. */
export const LOWER_BYTES32 = /^0x[0-9a-f]{64}$/

/** An address in lower-case hex, so the same account is never written two ways. */
export const LOWER_ADDRESS = /^0x[0-9a-f]{40}$/

/** A country as an ISO 3166-1 alpha-2 code in upper case. */
export const COUNTRY_CODE = /^[A-Z]{2}$/

/** A business's id as Avow writes one, which is 1 to 100 letters, digits, hyphens and underscores. */
export const BUSINESS_ID = /^[A-Za-z0-9_-]{1,100}$/

/** Whether an object holds exactly these keys, so nothing unsigned rides along with a message. */
export const holdsOnly = (value: object, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((k) => Object.hasOwn(value, k))
