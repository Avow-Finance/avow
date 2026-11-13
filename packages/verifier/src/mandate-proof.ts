import {
  type AvowDomain,
  digestOf,
  isSignedMandate,
  type MandateProof,
  mandateHash,
  mandateTypedData,
  type ReasonCode,
} from '@avow-finance/spec'
import type { Address, Hex } from 'viem'
import type { ChainReader } from './chain.js'

const same = (a: Hex, b: Hex) => a.toLowerCase() === b.toLowerCase()

/**
 * Checks that the business account authorized exactly this mandate, or says why not. A signed
 * mandate needs the account's signature over it. A mandate a transaction authorized needs that
 * transaction to be the one the agent's key went on in, and the chain to show the key put on the
 * account there with this mandate's hash as its witness. Only the account's root or an admin key
 * can put a key on, so any change to any field of the mandate, or a transaction that put on a
 * different key or a different hash, is refused. Whether the key is still active, and lasts long
 * enough, is the caller's to check.
 */
export async function mandateProofProblem(
  chain: Pick<ChainReader, 'isAccountSignature' | 'agentKey'>,
  proof: MandateProof,
  context: { account: Address; domain: AvowDomain; keyAuthorizedIn: Hex },
): Promise<ReasonCode | null> {
  const m = proof.message
  if (isSignedMandate(proof)) {
    const signed = await chain.isAccountSignature(
      context.account,
      digestOf(mandateTypedData(m, context.domain)),
      proof.signature,
    )
    return signed ? null : 'mandate.signature_invalid'
  }
  if (!same(proof.authorizedIn, context.keyAuthorizedIn)) return 'chain.mandate_mismatch'
  const key = await chain.agentKey(context.account, m.agentKey, proof.authorizedIn)
  if (key?.witness == null || !same(key.witness, mandateHash(m, context.domain))) {
    return 'chain.mandate_mismatch'
  }
  return null
}
