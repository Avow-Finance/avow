import type {
  Approval,
  HumanApproval,
  ReasonCode,
  ReserveRequest,
  Signed,
  SignedAgreement,
  StartReceipt,
} from '@avow-finance/spec'
import type { Hex } from 'viem'

/**
 * What an agent asks Avow's reserve check to approve. Avow reads the business, its administrator,
 * the agent, the supplier and the mandate from its own records, and the open reserves from the
 * lock, so the request carries only what the agent and the supplier agreed.
 */
export interface ReserveApprovalRequest {
  request: ReserveRequest
  /** The commitment's salt. Avow passes it to the supplier in its authorization. */
  salt: Hex
  agreement: SignedAgreement
  /** Which key funds the reserve, the agent's or the administrator's. */
  fundedBy: 'agent' | 'administrator'
  /** The administrator's approval, when the mandate asks for one. */
  humanApproval?: Signed<HumanApproval>
}

/** Avow's answer to a reserve request, with the id of the decision Avow recorded either way. */
export type ReserveApproval =
  | { ok: true; decisionId: string; approval: Signed<Approval> }
  | { ok: false; decisionId: string; reason: ReasonCode }

/**
 * Avow's side of an agent's commitments. Avow's hosted API will implement it over HTTP, and a local
 * stand-in implements it for a demo or a test. Pre-release, so the hosted API's calls will add the
 * agent's signature over each request, and this interface will change with them.
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
  /** Records the business cancelling a commitment, timestamped by Avow. */
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
