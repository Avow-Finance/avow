import {
  type AvowDomain,
  type MandateChain,
  mandateChainProblem,
  parseAgentMandates,
  SANDBOX_PATHS,
} from '@avow-finance/spec'
import { readAgentKey } from '@avow-finance/verifier'
import type { Address, Hex } from 'viem'
import type { AgentKey } from '../agent.js'
import { AvowApiError, agentRequestKey, avowRequests } from '../http.js'
import type { SandboxClient } from './fees.js'

/**
 * Reads every mandate the agent has held from Avow, and checks they link into one chain that
 * starts at the mandate its key carries on the chain. The administrator can replace the agent's
 * mandate in the console without touching its key, so the agent reads this to act under the
 * current one and to count what its earlier mandates still hold. It answers null when Avow has no
 * such route yet, so an agent talking to an older API keeps the mandate it was enrolled with.
 * Anything else that fails throws, and a chain that doesn't link to the key never comes back.
 */
export async function heldMandates(m: {
  apiUrl: string
  client: SandboxClient
  agentKey: AgentKey
  account: Address
  keyAuthorizedIn: Hex
  domain: AvowDomain
  send: typeof fetch
}): Promise<MandateChain | null> {
  const ask = avowRequests({
    baseUrl: m.apiUrl,
    key: agentRequestKey(m.agentKey),
    retryFor: 10n,
    fetch: m.send,
  })
  const expected = { chainId: m.domain.chainId, lock: m.domain.verifyingContract }
  const served = await ask({
    domain: m.domain,
    path: SANDBOX_PATHS.agentMandates,
    body: {},
    read: (json) => parseAgentMandates(json, expected),
  }).catch((error: unknown) => {
    if (error instanceof AvowApiError && error.definite && error.status === 404) return null
    throw error
  })
  if (served === null) return null
  const key = await readAgentKey(
    m.client,
    m.account,
    m.agentKey.accessKeyAddress,
    m.keyAuthorizedIn,
  )
  if (!key?.active || key.witness === null) {
    throw new Error(
      "The agent's key isn't active on the account, so it can't act under any mandate",
    )
  }
  const chain = mandateChainProblem(served, {
    domain: m.domain,
    agentKey: m.agentKey.accessKeyAddress,
    witness: key.witness,
  })
  if (!chain.ok) {
    throw new Error(`Avow served mandates that don't link to this agent's key: ${chain.reason}`)
  }
  return chain.value
}
