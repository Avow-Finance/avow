import {
  type AnyTerms,
  commitmentKey,
  enforceableTerms,
  type RailToken,
  type ReasonCode,
  type ReplayGuard,
  type SupplierAuthorization,
  type TermsProfile,
} from '@avow-finance/spec'
import type { Address } from 'viem'
import { type Agreed, checkAuthorization } from './authorization.js'
import type { ChainReader } from './chain.js'

export type { Agreed } from './authorization.js'
export { AUTHORIZATION_VALIDITY } from './authorization.js'

export interface VerifierConfig {
  chainId: number
  /** Avow's published keys for supplier authorizations. */
  avowKeys: readonly Address[]
  /** The supplier's own business id, as a buyer's mandate names it. */
  businessId: string
  /** The supplier's own payout address. Every reserve it accepts must pay here. */
  payee: Address
  /** Tokens the supplier accepts, with the currency each stands for. */
  acceptedTokens: readonly RailToken[]
  profile: TermsProfile
  /** Whether KYB results marked as test data pass. Allowed only on a testnet. */
  acceptTestData: boolean
  /** The longest an authorization may stay valid, in seconds. Five minutes when left out. */
  maxValidity?: bigint
}

export interface VerifierDeps {
  config: VerifierConfig
  chain: ChainReader
  replay: ReplayGuard
}

export interface VerifyInput {
  /** The signed supplier authorization, as JSON. */
  authorization: unknown
  /** The commitment the supplier agreed to, from the terms agreement it signed. */
  agreed: Agreed
  /** The supplier's own copy of the agreed terms: version 2, or version 1 for one made under it. */
  terms: AnyTerms
  /** The buyer's signed mandate, as JSON, when the supplier wants to check it too. */
  mandate?: unknown
  now: bigint
}

export type Verification =
  | {
      ok: true
      authorization: SupplierAuthorization
      lock: Address
      /** The buyer's account, which owns the lock. */
      account: Address
      /** The Avow key that signed. */
      signer: Address
    }
  | { ok: false; reason: ReasonCode }

/**
 * Checks a supplier authorization before the supplier grants capacity. It uses only the signed
 * message, the supplier's own record of what it agreed to and the chain, and never asks Avow.
 * It refuses with the first reason that applies. It passes once per commitment, and it records
 * that only after every other check passes, so a refusal never uses it up.
 *
 * Throws when the config doesn't fit the chain, such as test data on a chain that isn't a
 * testnet, because that's a setup mistake rather than a bad authorization.
 */
export async function verifySupplierAuthorization(
  input: VerifyInput,
  deps: VerifierDeps,
): Promise<Verification> {
  const checked = await checkAuthorization(input, deps.config, deps.chain)
  if (!checked.ok) return checked
  const { authorization: auth, domain: d } = checked
  const { acceptBy } = enforceableTerms(input.terms)

  // Last, so only an authorization that passed everything uses up its commitment.
  const recorded = await deps.replay.recordAll([
    {
      key: commitmentKey('SupplierAuthorization', d, auth.commitmentId),
      expiry: acceptBy > auth.expiry ? acceptBy : auth.expiry,
    },
  ])
  if (!recorded) return { ok: false, reason: 'message.replayed' }

  return {
    ok: true,
    authorization: auth,
    lock: checked.lock,
    account: checked.lockInfo.account,
    signer: checked.signer,
  }
}
