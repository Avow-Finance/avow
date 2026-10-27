import { type AvowDomain, type Mandate, mandateHash } from '@avow-finance/spec'
import type { Address, Hex } from 'viem'
import { Selectors } from 'viem/tempo'

/** Where an agent's key may send calls. */
export interface AgentKeyScope {
  /** The buyer's lock. The key may call it, and approve the token to it, and nothing else. */
  lock: Address
  /** The lock functions the agent's key calls, such as `reserve`. Step 2.2 fixes the list. */
  lockSelectors: readonly Hex[]
}

/** The terms of an agent key's authorization on Tempo, which the business's root key signs. */
export interface AgentKeyTerms {
  /** Unix seconds, the mandate's expiry. */
  expiry: number
  limits: { token: Address; limit: bigint; period?: number }[]
  scopes: { address: Address; selector: Hex; recipients?: Address[] }[]
  /** The mandate's hash, logged on-chain with the key, so anyone can see which mandate it serves. */
  witness: Hex
}

/**
 * Turns a mandate into the key authorization Tempo enforces (step 2.1). The key spends within the
 * mandate's payment limits, expires with it, approves each token only to the lock, calls only the
 * lock's listed functions, and carries the mandate's hash. A mandate that doesn't permit reserves
 * gets no calls to the lock at all.
 */
export function agentKeyTerms(
  mandate: Mandate,
  d: AvowDomain,
  scope: AgentKeyScope,
): AgentKeyTerms {
  if (mandate.expiry > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Expiry out of range')
  const reserves = mandate.actions.includes('reserve')
  return {
    expiry: Number(mandate.expiry),
    limits: mandate.paymentLimits.map((l) => ({
      token: l.token,
      limit: l.amount,
      ...(l.period > 0n ? { period: Number(l.period) } : {}),
    })),
    scopes: reserves
      ? [
          ...mandate.paymentLimits.map((l) => ({
            address: l.token,
            selector: Selectors.tip20.approve,
            recipients: [scope.lock],
          })),
          ...scope.lockSelectors.map((selector) => ({ address: scope.lock, selector })),
        ]
      : [],
    witness: mandateHash(mandate, d),
  }
}
