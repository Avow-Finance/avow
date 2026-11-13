import {
  type AvowDomain,
  type Enrollment,
  type Mandate,
  type MandateProof,
  MESSAGE_VERSIONS,
  type SandboxDeployment,
  type SupplierProfile,
} from '@avow-finance/spec'
import { type Address, encodeFunctionData, type Hex, isAddressEqual, toHex } from 'viem'
import { Abis, type Account, Addresses } from 'viem/tempo'
import type { AgentKey } from '../agent.js'
import { agentKeyTerms, authorizeKeyCall } from '../agent-key.js'
import { agentRequestKey, enrollAgent } from '../http.js'
import { approveSupplierCall, RESERVE_SELECTOR, removeSupplierCall } from '../lock.js'
import { sendOwn } from '../send.js'
import type { SandboxClient } from './fees.js'

const DAY = 86_400n

/** What the agent's key can move in a day when the business names no daily limit, $1,000. */
export const SANDBOX_DAILY_LIMIT = 1_000_000_000n

/**
 * The mandate a sandbox business's root key signs for its agent. The agent may reserve, cancel and
 * start commitments in the named categories with the named suppliers, up to `capPerCommitment` for
 * one and `capOpenReserves` across those it holds at once, until `expiry`. Its key can move at most
 * `dailyLimit` in a day, which the account's keychain holds whatever Avow approves. Every booking
 * goes ahead without a person's approval, which a real business would set to fit its own rules.
 */
export function sandboxMandate(m: {
  businessId: string
  agentId: string
  account: Address
  agentKey: Address
  /** The business ids of the suppliers the agent may book. */
  suppliers: readonly string[]
  /**
   * What the agent may commit to, compute bookings when left out. An agent that buys jobs from
   * another business names `JOB_CATEGORY` beside them.
   */
  categories?: readonly string[]
  token: Address
  capPerCommitment: bigint
  capOpenReserves: bigint
  /** The most the agent's key can move in a day, `SANDBOX_DAILY_LIMIT` when left out. */
  dailyLimit?: bigint
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
    categories: [...(m.categories ?? ['compute'])],
    paymentLimits: [{ token: m.token, amount: m.dailyLimit ?? SANDBOX_DAILY_LIMIT, period: DAY }],
    approvalRule: { kind: 'never' },
    expiry: m.expiry,
    nonce: 1n,
  }
}

/**
 * The agent's key on the account, under its mandate. A mandate this SDK authorizes names the
 * transaction its key went on in, and older agents hold one the root key signed.
 */
export interface AuthorizedSandboxKey {
  mandate: MandateProof
  mandateHash: Hex
  /** The transaction that put the agent's key on the account. */
  keyAuthorizedIn: Hex
}

/** The agent, enrolled with Avow under the mandate the root key signed. */
export interface EnrolledSandboxAgent extends AuthorizedSandboxKey {
  enrollment: Enrollment
}

export interface SandboxAuthorizeDeps {
  deployment: Pick<SandboxDeployment, 'chainId'>
  client: SandboxClient
  root: Account.RootAccount
  /**
   * The agent's access key on the account, which the mandate names. Only its address and type are
   * read, so a business's console can authorize a key that lives on the developer's machine.
   */
  agent: Pick<AgentKey, 'accessKeyAddress' | 'keyType'>
  lock: Address
  mandate: Mandate
  /** The suppliers the mandate names, each approved on the lock. */
  suppliers: readonly SupplierProfile[]
  /** The agent key this one replaces, revoked in the account's keychain in the same transaction. */
  revoke?: Address
  /** Supplier accounts the previous mandate allowed and this one doesn't, removed from the lock. */
  remove?: readonly Address[]
}

/**
 * Puts the agent's key on the account under its mandate, in one transaction the root key signs, so
 * approving an agent takes one signature. The transaction calls the keychain to add the key with
 * the mandate's limits and expiry and the mandate's hash as its witness, and approves on the lock
 * each supplier the mandate names. That transaction is the account's word on the mandate, which
 * carries its hash and names it, and the mandate gets no signature of its own. When the key
 * replaces another, the same transaction first revokes the old key in the account's keychain, so
 * it can't sign for the account again, and removes from the lock each supplier the new mandate
 * drops. Bookings the old key made stay in the lock until their release. A new mandate needs a new
 * key, since the account binds each key to one mandate's hash. If any call fails, the whole
 * transaction reverts and no key goes on.
 */
export async function authorizeSandboxKey(
  deps: SandboxAuthorizeDeps,
): Promise<AuthorizedSandboxKey> {
  const { deployment, client, root, agent, lock, mandate } = deps
  if (!isAddressEqual(mandate.account, root.address)) {
    throw new Error("The mandate names another account than the root key's")
  }
  const d: AvowDomain = { chainId: deployment.chainId, verifyingContract: lock }
  const terms = agentKeyTerms(mandate, d, { lock, lockSelectors: [RESERVE_SELECTOR] })
  const calls = [
    ...(deps.revoke
      ? [
          {
            to: Addresses.accountKeychain as Address,
            data: encodeFunctionData({
              abi: Abis.accountKeychain,
              functionName: 'revokeKey',
              args: [deps.revoke],
            }),
          },
        ]
      : []),
    authorizeKeyCall(agent, terms),
    ...(deps.remove ?? []).map((s) => removeSupplierCall(lock, s)),
    ...deps.suppliers.map((s) => approveSupplierCall(lock, s.account)),
  ]
  const receipt = await sendOwn({ client, account: root, calls })
  return {
    mandate: {
      type: 'Mandate',
      schemaVersion: MESSAGE_VERSIONS.Mandate,
      chainId: d.chainId,
      lock,
      message: mandate,
      authorizedIn: receipt.transactionHash,
    },
    mandateHash: terms.witness,
    keyAuthorizedIn: receipt.transactionHash,
  }
}

/**
 * Puts the agent's key on the account as `authorizeSandboxKey` does, then enrolls the agent with
 * Avow, which checks the mandate against that transaction.
 */
export async function enrollSandboxAgent(
  deps: SandboxAuthorizeDeps & {
    agent: AgentKey
    deployment: Pick<SandboxDeployment, 'chainId' | 'apiUrl'>
    fetch?: typeof fetch
  },
): Promise<EnrolledSandboxAgent> {
  const authorized = await authorizeSandboxKey(deps)
  const enrollment = await enrollAgent(
    {
      baseUrl: deps.deployment.apiUrl,
      key: agentRequestKey(deps.agent),
      retryFor: 120n,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    },
    { mandate: authorized.mandate, keyAuthorizedIn: authorized.keyAuthorizedIn },
  )
  return { ...authorized, enrollment }
}
