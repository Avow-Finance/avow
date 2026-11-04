import {
  type AvowDomain,
  type Enrollment,
  type Mandate,
  mandateHash,
  type SandboxDeployment,
  type Signed,
  type SupplierProfile,
} from '@avow-finance/spec'
import { type Address, type Hex, toHex } from 'viem'
import { Account } from 'viem/tempo'
import type { AgentKey } from '../agent.js'
import { agentKeyTerms } from '../agent-key.js'
import { agentRequestKey, enrollAgent } from '../http.js'
import { approveSupplierCall, RESERVE_SELECTOR } from '../lock.js'
import { sendOwn } from '../send.js'
import { accountSigner, signMandate } from '../sign.js'
import type { SandboxClient } from './business.js'

const DAY = 86_400n

/**
 * The mandate a sandbox business's root key signs for its agent. The agent may reserve, cancel and
 * start jobs for compute with the named suppliers, up to `capPerCommitment` for one booking and
 * `capOpenReserves` across the bookings it holds at once, until `expiry`. Its key can spend no more
 * than the open reserves cap in a day. Every booking goes ahead without a person's approval, which
 * a real business would set to fit its own rules.
 */
export function sandboxMandate(m: {
  businessId: string
  agentId: string
  account: Address
  agentKey: Address
  /** The business ids of the suppliers the agent may book. */
  suppliers: readonly string[]
  token: Address
  capPerCommitment: bigint
  capOpenReserves: bigint
  /** Unix seconds. */
  expiry: bigint
}): Mandate {
  return {
    mandateId: toHex(crypto.getRandomValues(new Uint8Array(32))),
    businessId: m.businessId,
    agentId: m.agentId,
    account: m.account,
    agentKey: m.agentKey,
    actions: ['reserve', 'cancel', 'start'],
    currency: 'USD',
    capPerCommitment: m.capPerCommitment,
    capOpenReserves: m.capOpenReserves,
    suppliers: [...m.suppliers],
    categories: ['compute'],
    paymentLimits: [{ token: m.token, amount: m.capOpenReserves, period: DAY }],
    approvalRule: { kind: 'never' },
    expiry: m.expiry,
    nonce: 1n,
  }
}

/** The agent, enrolled under the mandate the root key signed. */
export interface EnrolledSandboxAgent {
  mandate: Signed<Mandate>
  mandateHash: Hex
  /** The transaction that put the agent's key on the account and approved the suppliers. */
  keyAuthorizedIn: Hex
  enrollment: Enrollment
}

export interface SandboxEnrollDeps {
  deployment: Pick<SandboxDeployment, 'chainId' | 'apiUrl'>
  client: SandboxClient
  root: Account.RootAccount
  /** The agent's access key on the account, which the mandate names. */
  agent: AgentKey
  lock: Address
  mandate: Mandate
  /** The suppliers the mandate names, each approved on the lock. */
  suppliers: readonly SupplierProfile[]
  onSigned?: (mandate: Signed<Mandate>) => void
  fetch?: typeof fetch
}

/**
 * Signs the mandate with the root key and enrolls the agent. One transaction from the root key
 * puts the agent's key on the account, bound to the mandate's hash with the mandate's limits and
 * expiry, and approves each supplier on the lock. Then the agent enrolls with Avow, which checks
 * the mandate against that transaction. A new mandate needs a new agent key, since the account
 * holds each key's limits once.
 */
export async function enrollSandboxAgent(deps: SandboxEnrollDeps): Promise<EnrolledSandboxAgent> {
  const { deployment, client, root, agent, lock, mandate } = deps
  const d: AvowDomain = { chainId: deployment.chainId, verifyingContract: lock }
  const signed = await signMandate(mandate, d, accountSigner(root.address, root))
  deps.onSigned?.(signed)
  const keyAuthorization = await Account.signKeyAuthorization(root, {
    key: agent,
    chainId: BigInt(deployment.chainId),
    ...agentKeyTerms(mandate, d, { lock, lockSelectors: [RESERVE_SELECTOR] }),
  })
  const receipt = await sendOwn({
    client,
    account: root,
    calls: deps.suppliers.map((s) => approveSupplierCall(lock, s.account)),
    keyAuthorization,
  })
  const enrollment = await enrollAgent(
    {
      baseUrl: deployment.apiUrl,
      key: agentRequestKey(agent),
      retryFor: 120n,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    },
    { mandate: signed, keyAuthorizedIn: receipt.transactionHash },
  )
  return {
    mandate: signed,
    mandateHash: mandateHash(mandate, d),
    keyAuthorizedIn: receipt.transactionHash,
    enrollment,
  }
}
