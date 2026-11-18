import {
  type AvowDomain,
  digestOf,
  isSignedMandate,
  type MandateChain,
  mandateChainProblem,
  mandateTypedData,
  parseAgentMandates,
  SANDBOX_PATHS,
  type SignatureCheck,
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
 * current one and to count what its earlier mandates still hold. The current mandate has to carry
 * the business account's signature, as the chain shows it, and since it names the hash of the one
 * before it, which names the next, that one signature pins the whole chain. It answers null when
 * Avow has no such route yet, so an agent talking to an older API keeps the mandate it was
 * enrolled with. Anything else that fails throws, and a chain that doesn't link to the key, or
 * whose current mandate the account didn't sign, never comes back. Each try waits at most three
 * seconds, since the agent reads this when it starts.
 */
export async function heldMandates(m: {
  apiUrl: string
  client: SandboxClient
  agentKey: AgentKey
  account: Address
  keyAuthorizedIn: Hex
  domain: AvowDomain
  send: typeof fetch
  /** Whether the account's root or an admin key signed a digest, as the chain checks it. */
  isAccountSignature: SignatureCheck
}): Promise<MandateChain | null> {
  const ask = avowRequests({
    baseUrl: m.apiUrl,
    key: agentRequestKey(m.agentKey),
    retryFor: 5n,
    attemptTimeout: 3_000,
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
  const { proof } = chain.value.current
  // A first mandate shown by the key's own transaction is the key's witness, already checked.
  if (isSignedMandate(proof)) {
    const signed = await m.isAccountSignature({
      signer: m.account,
      digest: digestOf(mandateTypedData(proof.message, m.domain)),
      signature: proof.signature,
    })
    if (!signed) throw new Error("Avow served a mandate the business account didn't sign")
  }
  return chain.value
}
