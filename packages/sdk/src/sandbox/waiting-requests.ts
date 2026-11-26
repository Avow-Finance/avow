import {
  type ApprovalRequestList,
  type AvowDomain,
  parseApprovalRequestList,
  type RequestKey,
  SANDBOX_PATHS,
} from '@avow-finance/spec'
import { type AvowRequestConfig, avowRequests } from '../http.js'

export interface WaitingRequestsConfig extends Omit<AvowRequestConfig, 'key'> {
  /**
   * The business account's root key, through `rootRequestKey`. Avow answers this read to no
   * other key, so an agent can't list what its business has waiting.
   */
  key: RequestKey
  /** The chain and the business's own lock, which the request is signed under. */
  domain: AvowDomain
}

/**
 * Every request a business's agents made that waits on its administrator, oldest first, for the
 * business's own code or inbox. Each one's signing page is `approvalRequestLink(request.id)`,
 * where the administrator decides it with their passkey. Reading changes nothing.
 */
export async function sandboxWaitingRequests(
  config: WaitingRequestsConfig,
): Promise<ApprovalRequestList> {
  const { key, domain, ...request } = config
  const send = avowRequests({ retryFor: 60n, ...request, key })
  return send({
    domain,
    path: SANDBOX_PATHS.approvalRequestsWaiting,
    body: {},
    read: parseApprovalRequestList,
  })
}
