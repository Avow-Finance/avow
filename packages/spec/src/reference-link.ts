import { canonicalJson } from './canonical.js'
import { type CommitmentReference, commitmentReferenceJson } from './references.js'
import { type Parsed, toWire } from './wire.js'

/** The longest token `decodeCommitmentReference` reads, well above any reference's. */
const MAX_TOKEN = 1024

const toBase64Url = (text: string) =>
  btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/**
 * A commitment reference as one URL-safe token, for a link such as `#verify=<token>`: the
 * reference's canonical JSON in base64url, without padding. It names where the backing sits and
 * the terms hash, which anyone can check against the lock, so the token carries nothing private.
 */
export function encodeCommitmentReference(reference: CommitmentReference): string {
  const parsed = commitmentReferenceJson.safeParse(toWire(reference))
  if (!parsed.success) throw new RangeError("That isn't a commitment reference")
  return toBase64Url(canonicalJson(toWire(parsed.data)))
}

/** Reads the commitment reference a token from `encodeCommitmentReference` carries. */
export function decodeCommitmentReference(token: string): Parsed<CommitmentReference> {
  if (token.length === 0 || token.length > MAX_TOKEN || !/^[A-Za-z0-9_-]+$/.test(token)) {
    return { ok: false, reason: 'message.invalid' }
  }
  let json: unknown
  try {
    const base64 = token.replace(/-/g, '+').replace(/_/g, '/')
    json = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')))
  } catch {
    return { ok: false, reason: 'message.invalid' }
  }
  const parsed = commitmentReferenceJson.safeParse(json)
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, reason: 'message.invalid' }
}
