import {
  type AvowDomain,
  parseWorkerSlicesAnswer,
  type RequestKey,
  SANDBOX_PATHS,
  type Signed,
  type Slice,
  type SliceRevocation,
  type WorkerSlicesAnswer,
} from '@avow-finance/spec'
import type { Address, Hex } from 'viem'
import { type AvowRequestConfig, avowRequests } from '../http.js'

/**
 * The three slice routes of Avow's API, each signed by the key the route asks for: a slice by the
 * key that hands it out, a read by the worker or a key above it, and a revocation by its signer.
 * Every answer with slices is parsed under the business's lock, and a reader trusts the slices
 * only once `sliceChainProblem` reads them as one chain.
 */
export function sliceApi(config: Omit<AvowRequestConfig, 'key'> & { domain: AvowDomain }) {
  const { domain } = config
  const expected = { chainId: domain.chainId, lock: domain.verifyingContract }
  const as = (key: RequestKey) => avowRequests({ ...config, key })
  return {
    /** Posts a slice, or its next version, signed by its issuer, and answers the worker's slices. */
    post: (issuer: RequestKey, slice: Signed<Slice>): Promise<WorkerSlicesAnswer> =>
      as(issuer)({
        domain,
        path: SANDBOX_PATHS.slices,
        body: slice,
        read: (json) => parseWorkerSlicesAnswer(json, expected),
      }),
    /**
     * Reads a worker's slices with what each level holds, leaving out the commitment `excluding`
     * names, which the agent's signer is about to fund.
     */
    read: (
      reader: RequestKey,
      subKey: Address,
      excluding: Hex | null = null,
    ): Promise<WorkerSlicesAnswer> =>
      as(reader)({
        domain,
        path: SANDBOX_PATHS.workerSlices,
        body: excluding === null ? { subKey } : { subKey, excluding },
        read: (json) => parseWorkerSlicesAnswer(json, expected),
      }),
    /** Posts a revocation of a worker key, signed by its signer. */
    revoke: (by: RequestKey, revocation: Signed<SliceRevocation>): Promise<{ revoked: Address }> =>
      as(by)({
        domain,
        path: SANDBOX_PATHS.sliceRevocations,
        body: revocation,
        read: (json) => {
          const revoked = (json as { revoked?: unknown } | null)?.revoked
          return typeof revoked === 'string' && /^0x[0-9a-fA-F]{40}$/.test(revoked)
            ? { ok: true, value: { revoked: revoked as Address } }
            : { ok: false, reason: 'message.invalid' }
        },
      }),
  }
}

export type SliceApi = ReturnType<typeof sliceApi>
