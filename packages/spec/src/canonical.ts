import { type Hex, toHex } from 'viem'

/**
 * Canonical JSON as RFC 8785 (the JSON Canonicalization Scheme) writes it, for the values Avow
 * hashes. Object keys are sorted by their UTF-16 code units, nothing is indented, and strings and
 * numbers are written as JSON.stringify writes them, which RFC 8785 adopts.
 *
 * Three rules keep any value from having two encodings. A bigint is written as a JSON string of
 * its decimal digits, so amounts, times and durations are integers that never pass through a
 * float. Any other number has to be a safe integer, such as a count or a share in basis points.
 * Every string and key has to be well-formed Unicode. Undefined fields are left out, as JSON
 * would leave them.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'bigint':
      return JSON.stringify(value.toString())
    case 'number':
      if (!Number.isSafeInteger(value)) {
        throw new TypeError('Numbers in canonical JSON must be safe integers')
      }
      return JSON.stringify(value)
    case 'string':
      return JSON.stringify(wellFormed(value))
    case 'boolean':
      return JSON.stringify(value)
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      return `{${entries
        .map(([k, v]) => `${JSON.stringify(wellFormed(k))}:${canonicalJson(v)}`)
        .join(',')}}`
    }
    default:
      throw new TypeError(`Canonical JSON can't hold a ${typeof value}`)
  }
}

/** A lone surrogate is a string half of a character, which RFC 8785 refuses. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

function wellFormed(s: string): string {
  if (LONE_SURROGATE.test(s)) throw new TypeError('Strings in canonical JSON must be well-formed')
  return s
}

/**
 * A fresh 32-byte salt from the platform's cryptographic random source, so nobody can guess
 * standard terms from their hash. Each commitment gets its own.
 */
export function newSalt(): Hex {
  return toHex(crypto.getRandomValues(new Uint8Array(32)))
}
