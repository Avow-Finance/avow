import type {
  ReasonCode,
  ReserveApproval,
  ReserveApprovalRequest,
  Signed,
  StartReceipt,
} from '@avow-finance/spec'
import type { Hex } from 'viem'

export type { ReserveApproval, ReserveApprovalRequest } from '@avow-finance/spec'

/**
 * Avow's records of cancellations and job starts. An `AvowApi` serves all three calls together, as
 * its `records`, or none of them. Avow's hosted API serves all three, each answer carrying Avow's
 * timestamp on the request.
 */
export interface AvowRecords {
  /**
   * Records the business cancelling a commitment, timestamped by Avow, once free cancellation has
   * ended and until the no-show charge can be reported. Before then the business cancels on the
   * lock, and Avow refuses with `commitment.cancel_on_lock`. After it a cancellation no longer
   * changes the charge, and Avow refuses with `commitment.cancel_closed`. A commitment has one
   * cancellation, so every later call gives the first one's time.
   */
  cancel(request: { commitmentId: Hex }): Promise<{ cancelledAt: bigint }>
  /**
   * Timestamps the business's request to start a job. The supplier's start receipt names the
   * request's hash, and the job can't have started before the timestamp.
   */
  requestStart(request: {
    commitmentId: Hex
  }): Promise<{ startRequestHash: Hex; requestedAt: bigint }>
  /** Records the supplier's start receipt, which a kept booking rests on, or refuses it. */
  recordStart(request: {
    commitmentId: Hex
    receipt: Signed<StartReceipt>
  }): Promise<{ ok: true } | { ok: false; reason: ReasonCode }>
}

/**
 * Avow's side of an agent's commitments. Avow's hosted API implements it over HTTP through
 * `httpAvowApi`, which signs each request with the agent's key, and a local stand-in implements it
 * for a demo or a test. Pre-release, so it may change before 1.0.
 *
 * Avow's records of cancellations and job starts are one optional group, `records`, which a
 * stand-in for a demo or a test may leave out. `createAgent` gives an agent `cancel` and `start`
 * only when its `AvowApi` has `records`.
 */
export interface AvowApi {
  /** Avow's reserve check. It signs an approval the lock takes, or refuses with a reason code. */
  approveReserve(request: ReserveApprovalRequest): Promise<ReserveApproval>
  /**
   * Has Avow's relay co-sign a transaction the agent signed with `feePayer: true`, so the relay
   * pays its fee and the business needs no fee token. It takes and returns serialized bytes, and
   * never sends them. The relay signs only when each call goes to the business's own lock or
   * approves that lock to pull the reserve token. The agent checks the co-signed bytes, sends them
   * itself and tracks their hash.
   */
  sponsor(transaction: Hex): Promise<Hex>
  /** Avow's records of cancellations and job starts, all three calls or none. */
  records?: AvowRecords
}
