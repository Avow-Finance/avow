import {
  type AvowDomain,
  type BusinessCheck,
  parseBusinessCheck,
  type RequestKey,
  SANDBOX_PATHS,
} from '@avow-finance/spec'
import { type AvowRequestConfig, avowRequests } from '../http.js'

export interface BusinessChecksConfig extends Omit<AvowRequestConfig, 'key'> {
  /**
   * The business account's root key, through `rootRequestKey`. Avow takes a check's requests from
   * no other key, so an agent can neither start a check of its business nor read one.
   */
  key: RequestKey
  /** The chain and the business's own lock, which each request is signed under. */
  domain: AvowDomain
}

/** A sandbox business's check of itself, as its root key starts and reads it. */
export interface BusinessChecks {
  /**
   * Starts a check and gives where it stands. A check that's open, in review or passed comes back
   * as it is, so this is safe to call again. While its state is `started`, `url` is the checker's
   * page, which a person opens to finish the check.
   */
  start(): Promise<BusinessCheck>
  /** Where the check stands now. Avow asks the checker again while the check is open. */
  read(): Promise<BusinessCheck>
}

/**
 * The business check Avow's testnet sandbox runs, for a business's own code. Each call is one
 * request through `avowRequests`, signed by the root key under the business's lock, and a refusal
 * throws an `AvowApiError` with Avow's reason. On testnet the checker runs in its own sandbox, so
 * a check's `simulated` is true and a pass confirms nothing about the business.
 */
export function sandboxBusinessChecks(config: BusinessChecksConfig): BusinessChecks {
  const { key, domain, ...request } = config
  const send = avowRequests({ retryFor: 60n, ...request, key })
  const ask = (path: string) => send({ domain, path, body: {}, read: parseBusinessCheck })
  return {
    start: () => ask(SANDBOX_PATHS.businessChecks),
    read: () => ask(SANDBOX_PATHS.businessCheck),
  }
}
