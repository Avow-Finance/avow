import type { Address, Hex } from 'viem'
import { mandateVersion, type Signed } from './eip712.js'
import { bytes32 } from './json-fields.js'
import type { FirstMandate, Mandate } from './types.js'
import { MESSAGE_VERSIONS } from './version.js'
import { mandateJson, type Parsed, parseSigned } from './wire.js'

/**
 * A mandate the business account authorized in a transaction, with no signature of its own. In
 * that transaction the account put the agent's key on with the mandate's hash as the key's
 * witness, which only the account's root or an admin key can do, so the transaction is the
 * account's word on exactly this mandate. One passkey prompt then covers the mandate, the key and
 * its limits. The envelope is the one a signed mandate carries, so a reader checks the same chain
 * and lock, and `mandateHash` hashes the message the same way. Only a first mandate can be shown
 * this way, since the transaction bound the first mandate's hash and no later one.
 */
export type AuthorizedMandate = Omit<Signed<FirstMandate>, 'signature'> & {
  /** The transaction that put the agent's key on the account with this mandate's hash. */
  authorizedIn: Hex
}

/**
 * A mandate with what shows the business account authorized it: the root's EIP-712 signature, or
 * the transaction that bound its hash to the agent's key. Readers accept both, so agents enrolled
 * with a signed mandate keep working.
 */
export type MandateProof = Signed<Mandate> | AuthorizedMandate

export const isSignedMandate = (proof: MandateProof): proof is Signed<Mandate> =>
  'signature' in proof

/**
 * Parses a mandate with its proof and checks its envelope as `parseSigned` does. A mandate
 * carries either a signature or the transaction that authorized it, never both and never neither.
 * Its envelope's version has to be the one its message signs at, so a replacement can't pass as a
 * first mandate or the reverse. A replacement needs the account's signature, since the transaction
 * that put the key on bound the first mandate's hash and no later one.
 */
export function parseMandateProof(
  json: unknown,
  expected: { chainId: number; lock?: Address },
): Parsed<MandateProof> {
  if (typeof json !== 'object' || json === null || !('authorizedIn' in json)) {
    const signed = parseSigned(json, 'Mandate', mandateJson, expected)
    if (signed.ok && signed.value.schemaVersion !== mandateVersion(signed.value.message)) {
      return { ok: false, reason: 'message.invalid' }
    }
    return signed
  }
  const { authorizedIn, ...envelope } = json as Record<string, unknown>
  const tx = bytes32.safeParse(authorizedIn)
  if (!tx.success || 'signature' in envelope) return { ok: false, reason: 'message.invalid' }
  // The envelope and the message are read exactly as a signed mandate's, with an empty
  // signature standing in for the one this kind doesn't carry, and that stand-in is dropped.
  const read = parseSigned({ ...envelope, signature: '0x' }, 'Mandate', mandateJson, expected)
  if (!read.ok) return read
  const { signature: _, message, ...rest } = read.value
  const { replaces, ...first } = message
  if (replaces !== undefined || rest.schemaVersion !== MESSAGE_VERSIONS.Mandate) {
    return { ok: false, reason: 'message.invalid' }
  }
  return { ok: true, value: { ...rest, message: first, authorizedIn: tx.data as Hex } }
}
