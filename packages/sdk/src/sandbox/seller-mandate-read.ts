import {
  type AvowDomain,
  parseSellerMandates,
  SANDBOX_PATHS,
  type SignatureCheck,
  sellerMandateChainProblem,
} from '@avow-finance/spec'
import type { Address } from 'viem'
import type { PrivateKeyAccount } from 'viem/accounts'
import { AvowApiError, avowRequests, signingRequestKey } from '../http.js'
import {
  NO_SELLER_MANDATE,
  SellerMandateRefusal,
  type SellerStanding,
  sellerMandateNotice,
} from './seller-mandate.js'

/**
 * How long a selling agent keeps asking Avow for its seller's mandates, in seconds, before it
 * gives up and doesn't sell. It's short, since the agent reads them before every listing, quote
 * and acceptance, and when `listen` starts.
 */
export const SELLER_STANDING_RETRY_FOR = 25n

/**
 * Whether a 404 says no seller's mandate is in force: Avow answering that it holds none for the
 * key, or a sandbox that doesn't serve the route yet. Any other 404 is a refusal the agent can't
 * read, and it doesn't sell.
 */
function noMandate(error: AvowApiError): boolean {
  if (!error.definite || error.status !== 404) return false
  if (error.reason === 'seller_mandate.missing') return true
  return error.reason === 'request.invalid' && /no such route/i.test(error.message)
}

/**
 * Reads every seller's mandate the agent's signing key has held from Avow, signed by that key, and
 * checks they link into one chain the business account signed, with no revocation of the key. No
 * mandate in force is a standing of its own, and the agent sells as it did before. A chain that
 * doesn't read as one, or a revoked key, throws a `SellerMandateRefusal` with the spec's reason,
 * and anything else that fails, no answer in time among it, throws as it came, so the agent never
 * sells under mandates it couldn't read.
 */
export async function readSellerStanding(r: {
  apiUrl: string
  signing: PrivateKeyAccount
  domain: AvowDomain
  agent: { businessId: string; account: Address; signingKey: Address }
  isAccountSignature: SignatureCheck
  fetch: typeof fetch
  /** How long to keep asking, `SELLER_STANDING_RETRY_FOR` unless a test shortens it. */
  retryFor?: bigint
  attemptTimeout?: number
}): Promise<SellerStanding> {
  const ask = avowRequests({
    baseUrl: r.apiUrl,
    key: signingRequestKey(r.signing),
    retryFor: r.retryFor ?? SELLER_STANDING_RETRY_FOR,
    attemptTimeout: r.attemptTimeout ?? 5_000,
    fetch: r.fetch,
  })
  const expected = { chainId: r.domain.chainId, lock: r.domain.verifyingContract }
  const served = await ask({
    domain: r.domain,
    path: SANDBOX_PATHS.sellerMandates,
    body: {},
    read: (json) => parseSellerMandates(json, expected),
  }).catch((error: unknown) => {
    if (error instanceof AvowApiError && noMandate(error)) return null
    throw error
  })
  if (served === null) return { inForce: false, notice: NO_SELLER_MANDATE }
  const chain = await sellerMandateChainProblem(
    served,
    { domain: r.domain, ...r.agent },
    r.isAccountSignature,
  )
  if (!chain.ok) throw new SellerMandateRefusal(chain.reason, 'chain')
  return {
    inForce: true,
    chain: chain.value,
    notice: sellerMandateNotice(chain.value.current.hash),
  }
}
