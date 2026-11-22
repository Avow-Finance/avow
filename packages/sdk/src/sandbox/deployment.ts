import {
  parseSandboxDeployment,
  SANDBOX_DEPLOYMENT_PATH,
  type SandboxDeployment,
  TEMPO_MODERATO,
} from '@avow-finance/spec'
import { type Address, isAddressEqual } from 'viem'
import { MODERATO_FACTORIES, type TrustedFactory } from '../moderato.js'
import { SANDBOX_SCREEN_URL } from './session.js'
import type { StoredBusiness } from './store.js'

const describe = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300)

/** Every lock factory the SDK trusts on a chain, oldest first, and none on any other chain. */
export function trustedFactories(chainId: number): readonly TrustedFactory[] {
  return chainId === TEMPO_MODERATO ? MODERATO_FACTORIES : []
}

/** The trusted factory at this address on a chain, or null when the SDK doesn't trust it. */
export function trustedFactory(chainId: number, address: Address): TrustedFactory | null {
  return trustedFactories(chainId).find((f) => isAddressEqual(f.address, address)) ?? null
}

/**
 * The facts of the deployment the sandbox's screen runs against, as it publishes them. It refuses
 * a deployment whose factory isn't one the SDK trusts on that chain, so a changed settings file
 * can't point the sandbox, or its verifier, at another factory's locks.
 */
export async function loadSandboxDeployment(
  screenUrl: string = SANDBOX_SCREEN_URL,
  send: typeof fetch = (input, init) => fetch(input, init),
): Promise<SandboxDeployment> {
  const url = `${new URL(screenUrl).origin}${SANDBOX_DEPLOYMENT_PATH}`
  let response: Response
  try {
    response = await send(url, { signal: AbortSignal.timeout(15_000) })
  } catch (error) {
    throw new Error(`The sandbox at ${url} didn't answer: ${describe(error)}`)
  }
  const parsed = parseSandboxDeployment(await response.json().catch(() => null))
  if (!response.ok || !parsed.ok) throw new Error(`${url} doesn't describe a testnet deployment`)
  const { chainId, factory } = parsed.value
  if (!trustedFactory(chainId, factory)) {
    const trusted = trustedFactories(chainId).map((f) => f.address)
    throw new Error(
      `${url} names the factory ${factory}, but on chain ${chainId} the SDK trusts only ${trusted.join(', ') || 'none'}`,
    )
  }
  return parsed.value
}

/** Whether a business was made on this deployment, so its lock and registration still hold. */
export const madeOn = (b: StoredBusiness, d: SandboxDeployment): boolean =>
  b.chainId === d.chainId &&
  b.apiUrl === d.apiUrl &&
  isAddressEqual(b.factory, d.factory) &&
  isAddressEqual(b.token, d.token)
