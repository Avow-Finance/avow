import {
  type AvowDomain,
  type Enrollment,
  type Mandate,
  mandateHash,
  type SandboxDeployment,
  type Signed,
  type SupplierProfile,
} from '@avow-finance/spec'
import { type Address, encodeFunctionData, type Hex, toHex } from 'viem'
import { Abis, Account, Addresses } from 'viem/tempo'
import type { AgentKey } from '../agent.js'
import { agentKeyTerms } from '../agent-key.js'
import { agentRequestKey, enrollAgent } from '../http.js'
import { approveSupplierCall, RESERVE_SELECTOR, removeSupplierCall } from '../lock.js'
import { sendOwn } from '../send.js'
import { accountSigner, signMandate } from '../sign.js'
import type { SandboxClient } from './business.js'

const DAY = 86_400n

/** What the agent's key can move in a day when the business names no daily limit, $1,000. */
export const SANDBOX_DAILY_LIMIT = 1_000_000_000n

/**
 * The mandate a sandbox business's root key signs for its agent. The agent may reserve, cancel and
 * start jobs for compute with the named suppliers, up to `capPerCommitment` for one booking and
 * `capOpenReserves` across the bookings it holds at once, until `expiry`. Its key can move at most
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
    categories: ['compute'],
    paymentLimits: [{ token: m.token, amount: m.dailyLimit ?? SANDBOX_DAILY_LIMIT, period: DAY }],
    approvalRule: { kind: 'never' },
    expiry: m.expiry,
    nonce: 1n,
  }
}

/** The agent's key on the account, under the mandate the root key signed. */
export interface AuthorizedSandboxKey {
  mandate: Signed<Mandate>
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
  onSigned?: (mandate: Signed<Mandate>) => void
}

/**
 * Signs the mandate with the root key and puts the agent's key on the account, in one transaction
 * from the root key. The key is bound to the mandate's hash with the mandate's limits and expiry,
 * and each supplier the mandate names is approved on the lock. When the key replaces another, the
 * same transaction revokes the old key in the account's keychain, so the old key can't sign for the
 * account again, and removes from the lock each supplier the new mandate drops. Bookings the old key
 * made stay in the lock until their release. A new mandate needs a new key, since the account binds
 * each key to one mandate's hash.
 */
export async function authorizeSandboxKey(
  deps: SandboxAuthorizeDeps,
): Promise<AuthorizedSandboxKey> {
  const { deployment, client, root, agent, lock, mandate } = deps
  const d: AvowDomain = { chainId: deployment.chainId, verifyingContract: lock }
  const signed = await signMandate(mandate, d, accountSigner(root.address, root))
  deps.onSigned?.(signed)
  const keyAuthorization = await Account.signKeyAuthorization(root, {
    key: agent,
    chainId: BigInt(deployment.chainId),
    ...agentKeyTerms(mandate, d, { lock, lockSelectors: [RESERVE_SELECTOR] }),
  })
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
    ...(deps.remove ?? []).map((s) => removeSupplierCall(lock, s)),
    ...deps.suppliers.map((s) => approveSupplierCall(lock, s.account)),
  ]
  // Tempo refuses a transaction with no calls, and a mandate that names no supplier, such as one
  // whose agent approves each supplier as it books, would send none. Reading the key just put on the
  // account gives the transaction a call that changes nothing.
  if (calls.length === 0) {
    calls.push({
      to: Addresses.accountKeychain as Address,
      data: encodeFunctionData({
        abi: Abis.accountKeychain,
        functionName: 'getKey',
        args: [root.address, agent.accessKeyAddress],
      }),
    })
  }
  const receipt = await sendOwn({ client, account: root, calls, keyAuthorization })
  return {
    mandate: signed,
    mandateHash: mandateHash(mandate, d),
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
