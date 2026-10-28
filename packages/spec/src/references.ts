import { type Address, encodeAbiParameters, type Hex, isAddressEqual, keccak256 } from 'viem'
import { canonicalJson } from './canonical.js'
import type { ReasonCode } from './reasons.js'
import type { Side } from './types.js'

/**
 * A commitment named by where its backing sits and the terms it was made under. A reader checks it
 * against the lock, which holds the terms hash for the commitment id and side.
 */
export interface CommitmentReference {
  kind: 'commitment'
  chainId: number
  lock: Address
  commitmentId: Hex
  side: Side
  termsHash: Hex
}

/**
 * A settled token transfer. The chain, transaction hash and log index identify it, and the token,
 * sender, recipient, amount and memo are what the reference says the transfer shows. A reader
 * checks each of them against the token's own `TransferWithMemo` event at that log index, in a
 * successful and finalized transaction. A payment is evidence that money moved. It never backs a
 * commitment.
 */
export interface PaymentReference {
  kind: 'payment'
  chainId: number
  transactionHash: Hex
  /** The log's index in its block, as the receipt numbers it. */
  logIndex: number
  /** The token contract that emitted the event. */
  token: Address
  from: Address
  to: Address
  /** In the token's base units. */
  amount: bigint
  /** The event's 32-byte memo. */
  memo: Hex
}

/** A typed reference. A new kind of reference is a new variant here. */
export type Reference = CommitmentReference | PaymentReference

/**
 * A payment's canonical id: its chain, transaction hash and log index. Records that cite the same
 * transfer share it, whatever else they say about the transfer.
 */
export function paymentId(p: Pick<PaymentReference, 'chainId' | 'transactionHash' | 'logIndex'>) {
  return `${p.chainId}:${p.transactionHash.toLowerCase()}:${p.logIndex}`
}

/** The label a reference's hash starts from. */
export const REFERENCE_LABEL = 'avow:reference:v1'

/**
 * A reference's hash: keccak256 of the ABI encoding of the string `avow:reference:v1` and the
 * reference's canonical JSON, with every address and hash in lower case. It names a reference in
 * 32 bytes.
 */
export function referenceHash(r: Reference): Hex {
  const lower = (h: string) => h.toLowerCase()
  const canonical =
    r.kind === 'commitment'
      ? {
          ...r,
          lock: lower(r.lock),
          commitmentId: lower(r.commitmentId),
          termsHash: lower(r.termsHash),
        }
      : {
          ...r,
          transactionHash: lower(r.transactionHash),
          token: lower(r.token),
          from: lower(r.from),
          to: lower(r.to),
          memo: lower(r.memo),
        }
  return keccak256(
    encodeAbiParameters(
      [{ type: 'string' }, { type: 'string' }],
      [REFERENCE_LABEL, canonicalJson(canonical)],
    ),
  )
}

/**
 * What a chain reader found at one log index of one transaction. `event` is the log decoded as a
 * TIP-20 `TransferWithMemo` event, or null when the log there is any other event. Nothing read
 * from calldata counts.
 */
export interface ObservedTransfer {
  chainId: number
  transactionHash: Hex
  logIndex: number
  /** Whether the transaction succeeded. */
  succeeded: boolean
  /** Whether the transaction's block is finalized. */
  finalized: boolean
  /** The contract that emitted the log. */
  emitter: Address
  event: { from: Address; to: Address; amount: bigint; memo: Hex } | null
}

/**
 * Checks a payment reference against what a chain reader found. It passes only when the
 * transaction succeeded and is finalized, and the log at the reference's index is the token's own
 * `TransferWithMemo` event with exactly the sender, recipient, amount and memo the reference
 * states. A plain transfer with no memo doesn't count. Returns the first problem, or null.
 */
export function checkPaymentReference(
  ref: PaymentReference,
  seen: ObservedTransfer | null,
): ReasonCode | null {
  if (
    !seen ||
    seen.chainId !== ref.chainId ||
    seen.transactionHash.toLowerCase() !== ref.transactionHash.toLowerCase() ||
    seen.logIndex !== ref.logIndex
  ) {
    return 'payment.not_found'
  }
  if (!seen.succeeded) return 'payment.failed'
  if (!seen.finalized) return 'payment.not_final'
  if (!seen.event) return 'payment.not_memo_transfer'
  if (!isAddressEqual(seen.emitter, ref.token)) return 'payment.token_mismatch'
  if (!isAddressEqual(seen.event.from, ref.from)) return 'payment.sender_mismatch'
  if (!isAddressEqual(seen.event.to, ref.to)) return 'payment.recipient_mismatch'
  if (seen.event.amount !== ref.amount) return 'payment.amount_mismatch'
  if (seen.event.memo.toLowerCase() !== ref.memo.toLowerCase()) return 'payment.memo_mismatch'
  return null
}

/**
 * A record's use of a payment toward an obligation. Evidence cites the payment, and any number of
 * records can. Value counts the payment's amount toward the obligation, and v1 lets a payment's
 * value count once.
 */
export interface Attribution {
  payment: PaymentReference
  obligation: CommitmentReference
  use: 'evidence' | 'value'
}

/**
 * Checks a set of attributions against the rule that a payment's value counts at most once. Citing
 * a payment as evidence any number of times passes. A second attribution of the same payment's
 * value refuses, whichever obligation it names, since v1 allows exclusive attribution only and no
 * partial allocations. No attribution backs a commitment.
 *
 * This proves uniqueness only within the set it's given. It can't see an attribution another
 * service or a later request makes. Before any version lets a payment's value be allocated, Avow
 * needs a persistent registry that records each attribution atomically.
 */
export function checkAttributions(attributions: readonly Attribution[]): ReasonCode | null {
  const valued = new Set<string>()
  for (const a of attributions) {
    if (a.use !== 'value') continue
    const id = paymentId(a.payment)
    if (valued.has(id)) return 'payment.attributed_twice'
    valued.add(id)
  }
  return null
}
