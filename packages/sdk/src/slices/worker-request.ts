import {
  type Approval,
  canonicalJson,
  isKeySignature,
  newRequestId,
  type ReasonCode,
  type ReserveRequest,
  type Signed,
  type Terms,
  type TermsAgreement,
  toWire,
} from '@avow-finance/spec'
import { type Address, encodeAbiParameters, type Hex, keccak256 } from 'viem'

/**
 * What a worker asks the agent that started it to sign with the agent's key, which the worker
 * never holds. `agreement` asks for the buyer's side of a terms agreement, and `fund` for the
 * transaction that funds a reserve Avow approved under that agreement.
 */
export type WorkerAsk =
  | {
      kind: 'agreement'
      agreement: TermsAgreement
      /** The reserve request the worker will send Avow, whose terms the agreement hashes. */
      request: Omit<ReserveRequest, 'terms'> & { terms: Terms }
      salt: Hex
    }
  | { kind: 'fund'; approval: Signed<Approval> }

/** A worker's ask, signed by the worker's own key, with an id and an expiry so it lands once. */
export interface WorkerRequest {
  ask: WorkerAsk
  subKey: Address
  requestId: Hex
  expiry: bigint
  signature: Hex
}

/** What the agent's process answers a worker. */
export type WorkerAnswer =
  | { ok: true; kind: 'agreement'; buyerSignature: Hex }
  | { ok: true; kind: 'fund'; transactionHash: Hex; blockNumber: bigint }
  | { ok: false; reason: ReasonCode }

/** The label a worker's request is signed under, which nothing else signs. */
export const WORKER_REQUEST_LABEL = 'avow:worker-request:v1'

/** The longest a worker's request stays valid, in seconds. */
export const WORKER_REQUEST_MAX_VALIDITY = 120n

/**
 * The digest a worker's key signs: the label and the canonical JSON of the ask, the worker's key,
 * the id and the expiry, so a signature over one request is no signature over any other.
 */
export function workerRequestDigest(r: Omit<WorkerRequest, 'signature'>): Hex {
  const body = canonicalJson(
    toWire({
      ask: r.ask,
      subKey: r.subKey.toLowerCase(),
      requestId: r.requestId,
      expiry: r.expiry,
    }),
  )
  return keccak256(
    encodeAbiParameters([{ type: 'string' }, { type: 'string' }], [WORKER_REQUEST_LABEL, body]),
  )
}

/** A key that signs a digest bare, as a worker's own key does. */
export interface WorkerKey {
  readonly address: Address
  sign(args: { hash: Hex }): Promise<Hex>
}

/** Signs a worker's ask with its own key, valid for `validity` seconds from `now`. */
export async function signWorkerRequest(
  ask: WorkerAsk,
  key: WorkerKey,
  now: bigint,
  validity = 60n,
): Promise<WorkerRequest> {
  const unsigned = { ask, subKey: key.address, requestId: newRequestId(), expiry: now + validity }
  return { ...unsigned, signature: await key.sign({ hash: workerRequestDigest(unsigned) }) }
}

/** Whether the worker's key named in a request signed it. */
export function isWorkerRequestSigned(r: WorkerRequest): boolean {
  const { signature, ...unsigned } = r
  try {
    return isKeySignature(workerRequestDigest(unsigned), signature, r.subKey)
  } catch {
    return false
  }
}
