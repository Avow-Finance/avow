import {
  type AnyTerms,
  acceptsPaymentToken,
  type CommitmentReference,
  checkPaymentReference,
  enforceableTerms,
  isTermsV1,
  type LockTerms,
  lockRecordDifferences,
  lockTerms,
  type PaymentReference,
  type PaymentToken,
  type RailToken,
  type ReasonCode,
  termsHash,
  termsShapeProblem,
} from '@avow-finance/spec'
import { type Hex, isAddressEqual } from 'viem'
import type { ChainReader, LockedBacking, LockInfo } from './chain.js'

export type ReferenceCheck = { ok: true } | { ok: false; reason: ReasonCode }

const refuse = (reason: ReasonCode): ReferenceCheck => ({ ok: false, reason })
const same = (a: Hex, b: Hex) => a.toLowerCase() === b.toLowerCase()

/**
 * Checks a payment reference against the chain the reader reads. The reference names its own
 * token, so the caller says which tokens it accepts, and a reference to any other token is refused
 * before the chain is read. It passes only when the transaction succeeded and is finalized, and the
 * log at the reference's index is that token's own TIP-20 `TransferWithMemo` event, with exactly
 * the reference's sender, recipient, amount and memo. A payment is evidence that money moved and
 * never backs a commitment.
 */
export async function verifyPaymentReference(
  ref: PaymentReference,
  chain: ChainReader,
  accepted: readonly PaymentToken[],
): Promise<ReferenceCheck> {
  if (!acceptsPaymentToken(ref, accepted)) return refuse('payment.token_not_accepted')
  if (ref.chainId !== chain.chainId) return refuse('payment.not_found')
  const seen = await chain.transfer(ref.transactionHash, ref.logIndex)
  const problem = checkPaymentReference(ref, seen, accepted)
  return problem ? refuse(problem) : { ok: true }
}

type Found = { ok: true; info: LockInfo; held: LockedBacking } | { ok: false; reason: ReasonCode }

/** The lock and the commitment a reference names, or why the chain shows neither. */
async function findCommitment(ref: CommitmentReference, chain: ChainReader): Promise<Found> {
  const missing = (reason: ReasonCode): Found => ({ ok: false, reason })
  if (ref.chainId !== chain.chainId) return missing('message.wrong_chain')
  const info = await chain.lock(ref.lock)
  if (!info?.fromFactory) return missing('chain.lock_unknown')
  const held = await chain.backing(ref.lock, ref.commitmentId, ref.side)
  if (!held || !same(held.termsHash, ref.termsHash)) return missing('reference.commitment_mismatch')
  return { ok: true, info, held }
}

/**
 * Checks that a commitment reference names a lock Avow's factory created, and that the lock holds
 * that commitment and side under the reference's terms hash.
 */
export async function verifyCommitmentReference(
  ref: CommitmentReference,
  chain: ChainReader,
): Promise<ReferenceCheck> {
  const found = await findCommitment(ref, chain)
  return found.ok ? { ok: true } : found
}

/**
 * Checks a commitment on the chain against its terms, for any terms version this code reads. The
 * terms and salt have to give the terms hash the lock holds, the reference has to name the side
 * the terms' backing secures, the lock's token has to be one the caller accepts for the terms'
 * currency, and every field the lock enforces has to be what those terms map to in that token's
 * units, the same mapping Avow's API signs with. It lets anyone holding the terms check a
 * commitment made under version 1 or 2 without asking Avow.
 */
export async function verifyCommitmentTerms(
  input: {
    reference: CommitmentReference
    terms: AnyTerms
    salt: Hex
    acceptedTokens: readonly RailToken[]
  },
  chain: ChainReader,
): Promise<ReferenceCheck> {
  const ref = input.reference
  const t = input.terms
  const found = await findCommitment(ref, chain)
  if (!found.ok) return found
  const { info, held } = found
  const shape = termsShapeProblem(t)
  if (shape) return refuse(shape)
  // Version 1 terms written before the dispute block existed can't be checked against a lock.
  if (isTermsV1(t) && !(t as { dispute?: unknown }).dispute) return refuse('terms.incomplete')
  let hash: Hex
  try {
    hash = termsHash(t, input.salt)
  } catch {
    // A salt the hash refuses, such as a short one or all zeros, can't give the hash the lock holds.
    return refuse('terms.hash_mismatch')
  }
  if (!same(hash, ref.termsHash)) return refuse('terms.hash_mismatch')
  const enforced = enforceableTerms(t)
  if (ref.side !== enforced.side) return refuse('reference.commitment_mismatch')
  const token = input.acceptedTokens.find(
    (a) =>
      a.chainId === ref.chainId &&
      isAddressEqual(a.token, info.token) &&
      isAddressEqual(a.token, held.token) &&
      a.currency === enforced.currency,
  )
  if (!token) return refuse('authorization.token_not_accepted')
  let expected: LockTerms
  try {
    expected = lockTerms(t, token.decimals)
  } catch {
    return refuse('authorization.token_not_accepted')
  }
  const differs = lockRecordDifferences(held, expected)
  return differs.length === 0 ? { ok: true } : refuse('chain.reserve_mismatch')
}
