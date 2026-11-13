import { canonicalJson } from './canonical.js'
import { type CommitmentReference, commitmentReferenceJson } from './references.js'
import { type Parsed, toWire } from './wire.js'

/** The longest token `decodeCommitmentReference` reads, well above any reference's. */
const MAX_TOKEN = 1024

const TOKEN = /^[A-Za-z0-9_-]+$/

/**
 * A value as one URL-safe token for a link: its canonical JSON in UTF-8, in base64url without
 * padding. Canonical JSON has one encoding for each value, so a value has one token.
 */
export function encodeLinkToken(value: unknown): string {
  const bytes = new TextEncoder().encode(canonicalJson(toWire(value)))
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/**
 * The JSON a token from `encodeLinkToken` carries, or null when the token is empty, longer than
 * `max`, or isn't base64url holding UTF-8 JSON.
 */
export function decodeLinkToken(token: string, max: number): { json: unknown } | null {
  if (token.length === 0 || token.length > max || !TOKEN.test(token)) return null
  try {
    const base64 = token.replace(/-/g, '+').replace(/_/g, '/')
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
    return { json: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  } catch {
    return null
  }
}

/**
 * A commitment reference as one URL-safe token, for a link such as `#verify=<token>`: the
 * reference's canonical JSON in base64url, without padding. It names where the backing sits and
 * the terms hash, which anyone can check against the lock, so the token carries nothing private.
 */
export function encodeCommitmentReference(reference: CommitmentReference): string {
  const parsed = commitmentReferenceJson.safeParse(toWire(reference))
  if (!parsed.success) throw new RangeError("That isn't a commitment reference")
  return encodeLinkToken(parsed.data)
}

/** Reads the commitment reference a token from `encodeCommitmentReference` carries. */
export function decodeCommitmentReference(token: string): Parsed<CommitmentReference> {
  // A terminal wraps a long link, and copying it can carry the breaks along as spaces, which a
  // browser sends as %20. Neither is ever part of a token, so both go before it's read.
  const decoded = decodeLinkToken(token.replace(/%20|\s/g, ''), MAX_TOKEN)
  if (!decoded) return { ok: false, reason: 'message.invalid' }
  const parsed = commitmentReferenceJson.safeParse(decoded.json)
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, reason: 'message.invalid' }
}
