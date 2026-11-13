import { type AvowDomain, type Mandate, mandateHash } from '@avow-finance/spec'
import { type Address, encodeFunctionData, type Hex } from 'viem'
import { Abis, Addresses, Selectors } from 'viem/tempo'

/** Where an agent's key may send calls. */
export interface AgentKeyScope {
  /** The buyer's lock. The key may call it, and approve the token to it, and nothing else. */
  lock: Address
  /** The lock functions the agent's key calls, such as `reserve`. The lock's interface fixes the list. */
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
 * Turns a mandate into the key authorization Tempo enforces. The key spends within the
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

/** Tempo's number for each kind of key, as the keychain's `authorizeKey` takes it. */
const SIGNATURE_TYPES = { secp256k1: 0, p256: 1, webAuthn: 2 } as const

/**
 * The call that puts an agent's key on the account with its terms, for the account's root to send
 * in a transaction of its own. It sets exactly what a signed key authorization would: the expiry,
 * the spending limits, the call scopes, and the mandate's hash as the witness. The root's signature
 * on the transaction then covers the key and every call beside it, so approving an agent takes
 * one signature. Only the root or an admin key can make this call, so an agent can't give itself a
 * key. A key with no scopes may make no calls, as a signed authorization with an empty list means.
 */
export function authorizeKeyCall(
  key: { accessKeyAddress: Address; keyType: keyof typeof SIGNATURE_TYPES },
  terms: AgentKeyTerms,
): { to: Address; data: Hex } {
  const targets = [...new Set(terms.scopes.map((s) => s.address.toLowerCase() as Address))]
  return {
    to: Addresses.accountKeychain as Address,
    data: encodeFunctionData({
      abi: Abis.accountKeychain,
      functionName: 'authorizeKey',
      args: [
        key.accessKeyAddress,
        SIGNATURE_TYPES[key.keyType],
        {
          expiry: BigInt(terms.expiry),
          enforceLimits: true,
          limits: terms.limits.map((l) => ({
            token: l.token,
            amount: l.limit,
            period: BigInt(l.period ?? 0),
          })),
          allowAnyCalls: false,
          allowedCalls: targets.map((target) => ({
            target,
            selectorRules: terms.scopes
              .filter((s) => s.address.toLowerCase() === target)
              .map((s) => ({ selector: s.selector, recipients: s.recipients ?? [] })),
          })),
        },
        terms.witness,
      ],
    }),
  }
}
