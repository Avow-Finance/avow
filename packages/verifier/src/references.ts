import {
  type AnyTerms,
  CHARGE_KINDS,
  type Charge,
  type CommitmentReference,
  checkPaymentReference,
  lockTerms,
  type PaymentReference,
  type ReasonCode,
  termsHash,
} from '@avow-finance/spec'
import { type Hex, isAddressEqual } from 'viem'
import type { ChainReader } from './chain.js'

export type ReferenceCheck = { ok: true } | { ok: false; reason: ReasonCode }

const refuse = (reason: ReasonCode): ReferenceCheck => ({ ok: false, reason })
const same = (a: Hex, b: Hex) => a.toLowerCase() === b.toLowerCase()

/**
 * Checks a payment reference against the chain the reader reads. It passes only when the
 * transaction succeeded and is finalized, and the log at the reference's index is the TIP-20
 * `TransferWithMemo` event from the reference's token, with exactly its sender, recipient, amount
 * and memo. A payment is evidence that money moved and never backs a commitment.
 */
export async function verifyPaymentReference(
  ref: PaymentReference,
  chain: ChainReader,
): Promise<ReferenceCheck> {
  if (ref.chainId !== chain.chainId) return refuse('payment.not_found')
  const seen = await chain.transfer(ref.transactionHash, ref.logIndex)
  const problem = checkPaymentReference(ref, seen)
  return problem ? refuse(problem) : { ok: true }
}

/**
 * Checks that a commitment reference names a lock Avow's factory created, and that the lock holds
 * that commitment and side under the reference's terms hash.
 */
export async function verifyCommitmentReference(
  ref: CommitmentReference,
  chain: ChainReader,
): Promise<ReferenceCheck> {
  if (ref.chainId !== chain.chainId) return refuse('message.wrong_chain')
  const info = await chain.lock(ref.lock)
  if (!info?.fromFactory) return refuse('chain.lock_unknown')
  const held = await chain.backing(ref.lock, ref.commitmentId, ref.side)
  if (!held || !same(held.termsHash, ref.termsHash)) return refuse('reference.commitment_mismatch')
  return { ok: true }
}

/**
 * Checks a commitment on the chain against its terms, for any terms version this code reads. The
 * terms and salt have to give the terms hash the lock holds, and every field the lock enforces has
 * to be what those terms map to, the same mapping Avow's API signs with. It lets anyone holding
 * the terms check a commitment made under version 1 or 2 without asking Avow.
 */
export async function verifyCommitmentTerms(
  input: { reference: CommitmentReference; terms: AnyTerms; salt: Hex; decimals: number },
  chain: ChainReader,
): Promise<ReferenceCheck> {
  const ref = input.reference
  const found = await verifyCommitmentReference(ref, chain)
  if (!found.ok) return found
  if (!same(termsHash(input.terms, input.salt), ref.termsHash)) return refuse('terms.hash_mismatch')
  const held = await chain.backing(ref.lock, ref.commitmentId, ref.side)
  if (!held) return refuse('reference.commitment_mismatch')
  let expected: ReturnType<typeof lockTerms>
  try {
    expected = lockTerms(input.terms, input.decimals)
  } catch {
    return refuse('authorization.token_not_accepted')
  }
  const byKind = (x: Charge, y: Charge) => CHARGE_KINDS[x.kind] - CHARGE_KINDS[y.kind]
  const heldCharges = [...held.charges].sort(byKind)
  const sameCharges =
    heldCharges.length === expected.charges.length &&
    heldCharges.every((c, i) => {
      const e = expected.charges[i]
      return e !== undefined && c.kind === e.kind && c.most === e.most && c.earliest === e.earliest
    })
  const matches =
    held.amount === expected.amount &&
    held.freeCancelBy === expected.freeCancelBy &&
    held.acceptBy === expected.acceptBy &&
    held.chargeDeadline === expected.chargeDeadline &&
    held.releaseDate === expected.releaseDate &&
    held.contestWindow === expected.contestWindow &&
    sameCharges &&
    held.day90SupplierShareBps === expected.day90SupplierShareBps &&
    isAddressEqual(held.arbiter, expected.arbiter)
  return matches ? { ok: true } : refuse('chain.reserve_mismatch')
}
