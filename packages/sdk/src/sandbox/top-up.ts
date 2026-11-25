import {
  type AvowDomain,
  parseTopUp,
  type RequestKey,
  SANDBOX_PATHS,
  type TopUp,
} from '@avow-finance/spec'
import { type AvowRequestConfig, avowRequests } from '../http.js'

export interface TopUpsConfig extends Omit<AvowRequestConfig, 'key'> {
  /**
   * The business account's root key through `rootRequestKey`, or the key of one of its agents
   * the business approved and hasn't revoked. A top-up widens no limit, so either may ask.
   */
  key: RequestKey
  /** The chain and the business's own lock, which the request is signed under. */
  domain: AvowDomain
}

/**
 * Asks Avow's testnet sandbox faucet for more test dollars for a business. The faucet sends them
 * to the business's own account, never its lock, and a business gets one top-up a day. A second
 * within the day comes back `not_yet` and sends nothing, and either answer's `nextAt` says when to
 * ask again. A sent transfer is `pending` until it lands on Tempo.
 */
export function sandboxTopUp(config: TopUpsConfig): Promise<TopUp> {
  const { key, domain, ...request } = config
  const send = avowRequests({ retryFor: 60n, ...request, key })
  return send({ domain, path: SANDBOX_PATHS.topUps, body: {}, read: parseTopUp })
}
