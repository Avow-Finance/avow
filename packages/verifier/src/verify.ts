import {
  assertTestSettingsOnTestnet,
  type ComputeTerms,
  checkMandate,
  commitmentKey,
  digestOf,
  mandateHash,
  mandateJson,
  mandateTypedData,
  parseSigned,
  type RailToken,
  type ReasonCode,
  type ReplayGuard,
  type SupplierAuthorization,
  supplierAuthorizationJson,
  supplierAuthorizationTypedData,
  type TermsProfile,
  termsHash,
  toTokenUnits,
  validateTerms,
} from '@avow-finance/spec'
import { type Address, type Hex, isAddressEqual, recoverAddress, zeroAddress } from 'viem'
import type { ChainReader } from './chain.js'

/** Avow signs a supplier authorization for five minutes. */
export const AUTHORIZATION_VALIDITY = 300n
/** Room for the supplier's clock to run behind Avow's. */
const CLOCK_ALLOWANCE = 60n

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
  agreed: { commitmentId: Hex; termsHash: Hex; category: string }
  /** The supplier's own copy of the agreed terms. */
  terms: ComputeTerms
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

const same = (a: Hex, b: Hex) => a.toLowerCase() === b.toLowerCase()

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
  const { config, chain } = deps
  if (chain.chainId !== config.chainId) {
    throw new Error(`The chain reader is for chain ${chain.chainId}, not ${config.chainId}`)
  }
  assertTestSettingsOnTestnet({
    chainId: config.chainId,
    testData: config.acceptTestData,
    profile: config.profile,
  })
  const refuse = (reason: ReasonCode): Verification => ({ ok: false, reason })

  // The envelope, the signature and the validity window.
  const parsed = parseSigned(
    input.authorization,
    'SupplierAuthorization',
    supplierAuthorizationJson,
    { chainId: config.chainId },
  )
  if (!parsed.ok) return parsed
  const { message: auth, lock, signature } = parsed.value
  if (auth.expiry <= input.now) return refuse('message.expired')
  const maxValidity = config.maxValidity ?? AUTHORIZATION_VALIDITY
  if (auth.expiry > input.now + maxValidity + CLOCK_ALLOWANCE) {
    return refuse('message.validity_too_long')
  }
  const d = { chainId: config.chainId, verifyingContract: lock }
  let signer: Address
  try {
    signer = await recoverAddress({
      hash: digestOf(supplierAuthorizationTypedData(auth, d)),
      signature,
    })
  } catch {
    return refuse('message.signature_invalid')
  }
  if (!config.avowKeys.some((k) => isAddressEqual(k, signer))) {
    return refuse('message.signer_unknown')
  }

  // The commitment the supplier agreed to, and nothing else.
  if (!same(auth.commitmentId, input.agreed.commitmentId)) {
    return refuse('authorization.commitment_mismatch')
  }
  if (!same(auth.termsHash, input.agreed.termsHash)) return refuse('terms.hash_mismatch')
  if (auth.kybTestData && !config.acceptTestData) return refuse('business.test_data')

  // The supplier's terms against the ones Avow signed.
  const t = input.terms
  if (!same(termsHash(t, auth.salt), auth.termsHash)) return refuse('terms.hash_mismatch')
  const termsProblem = validateTerms(t, config.profile)
  if (termsProblem) return refuse(termsProblem)
  const token = config.acceptedTokens.find(
    (a) =>
      a.chainId === config.chainId &&
      isAddressEqual(a.token, auth.token) &&
      a.currency === t.currency,
  )
  if (!token) return refuse('authorization.token_not_accepted')
  let reserveUnits: bigint
  try {
    reserveUnits = toTokenUnits(t.reserve, token.decimals)
  } catch {
    return refuse('authorization.token_not_accepted')
  }
  if (
    auth.amount !== reserveUnits ||
    auth.acceptBy !== t.acceptBy ||
    auth.chargeDeadline !== t.chargeDeadline ||
    auth.releaseDate !== t.releaseDate
  ) {
    return refuse('authorization.terms_mismatch')
  }
  if (!isAddressEqual(auth.payee, config.payee)) return refuse('authorization.payee_mismatch')
  if (auth.acceptBy <= input.now) return refuse('authorization.accept_by_passed')

  // The chain, read directly.
  const lockInfo = await chain.lock(lock)
  if (!lockInfo?.fromFactory) return refuse('chain.lock_unknown')
  const backing = await chain.backing(lock, auth.commitmentId, 'buyer')
  if (backing?.state === 'accepted') return refuse('chain.reserve_accepted')
  if (backing?.state !== 'reserved') return refuse('chain.reserve_missing')
  const fundedByAgentOrRoot =
    isAddressEqual(backing.fundingKey, auth.agentKey) ||
    isAddressEqual(backing.fundingKey, zeroAddress)
  if (
    !isAddressEqual(backing.token, auth.token) ||
    backing.amount !== auth.amount ||
    !isAddressEqual(backing.payee, auth.payee) ||
    backing.acceptBy !== t.acceptBy ||
    backing.chargeDeadline !== t.chargeDeadline ||
    backing.contestWindow !== t.contestWindow ||
    backing.releaseDate !== t.releaseDate ||
    !same(backing.termsHash, auth.termsHash) ||
    !fundedByAgentOrRoot
  ) {
    return refuse('chain.reserve_mismatch')
  }
  const key = await chain.agentKey(lockInfo.account, auth.agentKey, auth.agentKeyAuthorizedIn)
  if (!key?.active) return refuse('chain.agent_key_inactive')
  // The key has to last until nothing more can happen to the commitment.
  if (key.expiry !== null && key.expiry < t.releaseDate) return refuse('chain.agent_key_inactive')
  if (key.witness === null || !same(key.witness, auth.mandateHash)) {
    return refuse('chain.mandate_mismatch')
  }

  // The buyer's mandate, when the supplier has it: its hash, its signer and its limits.
  if (input.mandate !== undefined) {
    const m = parseSigned(input.mandate, 'Mandate', mandateJson, {
      chainId: config.chainId,
      lock,
    })
    if (!m.ok) return m
    const mandate = m.value.message
    if (
      !same(mandateHash(mandate, d), auth.mandateHash) ||
      !isAddressEqual(mandate.account, lockInfo.account) ||
      !isAddressEqual(mandate.agentKey, auth.agentKey)
    ) {
      return refuse('authorization.mandate_mismatch')
    }
    const signed = await chain.isAccountSignature(
      lockInfo.account,
      digestOf(mandateTypedData(mandate, d)),
      m.value.signature,
    )
    if (!signed) return refuse('mandate.signature_invalid')
    // The parts a supplier can check. Open reserves and revocation live with the lock and the
    // key, which the checks above read, and Avow's signature stands for any human approval.
    const limits = checkMandate({
      mandate,
      request: {
        commitmentId: auth.commitmentId,
        agentKey: auth.agentKey,
        supplier: config.businessId,
        payee: auth.payee,
        category: input.agreed.category,
        terms: t,
      },
      token,
      openReserves: 0n,
      revoked: false,
      now: input.now,
      profile: config.profile,
    })
    if (limits.result === 'denied') return refuse(limits.reason)
  }

  // Last, so only an authorization that passed everything uses up its commitment.
  const recorded = await deps.replay.recordAll([
    {
      key: commitmentKey('SupplierAuthorization', d, auth.commitmentId),
      expiry: t.acceptBy > auth.expiry ? t.acceptBy : auth.expiry,
    },
  ])
  if (!recorded) return refuse('message.replayed')

  return { ok: true, authorization: auth, lock, account: lockInfo.account, signer }
}
