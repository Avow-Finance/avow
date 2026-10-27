import {
  type ComputeTerms,
  digestOf,
  isSignedBy,
  mandateHash,
  mandateJson,
  mandateTypedData,
  parseSigned,
  type RailToken,
  type ReasonCode,
  type ReplayGuard,
  replayKey,
  type SignatureCheck,
  type SupplierAuthorization,
  supplierAuthorizationJson,
  supplierAuthorizationTypedData,
  type TermsProfile,
  termsHash,
  toTokenUnits,
  validateTerms,
} from '@avow-finance/spec'
import { type Address, isAddressEqual, recoverAddress, zeroAddress } from 'viem'
import type { ChainReader } from './chain.js'

export interface VerifierConfig {
  chainId: number
  /** Avow's published keys for supplier authorizations. */
  avowKeys: readonly Address[]
  /** The supplier's own payout address. Every reserve it accepts must pay here. */
  payee: Address
  /** Tokens the supplier accepts, with the currency each stands for. */
  acceptedTokens: readonly RailToken[]
  profile: TermsProfile
  /** Whether KYB results from a mock provider pass. Only testnet sets this. */
  acceptTestData: boolean
}

export interface VerifierDeps {
  config: VerifierConfig
  chain: ChainReader
  replay: ReplayGuard
  /** Checks the buyer account's signature on a mandate. Passkey roots need the keychain's check. */
  accountSignatureCheck?: SignatureCheck
}

export interface VerifyInput {
  /** The signed supplier authorization, as JSON. */
  authorization: unknown
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

/**
 * Checks a supplier authorization before the supplier grants capacity. It uses only the signed
 * message, the supplier's own terms and the chain, and never asks Avow (acceptance test 6). It
 * refuses with the first reason that applies, and it records the message's nonce only once every
 * check passes, so a refusal never uses it up.
 */
export async function verifySupplierAuthorization(
  input: VerifyInput,
  deps: VerifierDeps,
): Promise<Verification> {
  const { config, chain } = deps
  const refuse = (reason: ReasonCode): Verification => ({ ok: false, reason })

  // The envelope, the signature and the expiry.
  const parsed = parseSigned(
    input.authorization,
    'SupplierAuthorization',
    supplierAuthorizationJson,
    { chainId: config.chainId },
  )
  if (!parsed.ok) return parsed
  const { message: auth, lock, signature } = parsed.value
  if (auth.expiry <= input.now) return refuse('message.expired')
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
  if (auth.kybTestData && !config.acceptTestData) return refuse('business.test_data')

  // The terms the supplier holds against the ones Avow signed.
  if (termsHash(input.terms, auth.salt) !== auth.termsHash) return refuse('terms.hash_mismatch')
  const termsProblem = validateTerms(input.terms, config.profile)
  if (termsProblem) return refuse(termsProblem)
  const t = input.terms
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
  if (!backing || (backing.state !== 'reserved' && backing.state !== 'accepted')) {
    return refuse('chain.reserve_missing')
  }
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
    backing.termsHash !== auth.termsHash ||
    !fundedByAgentOrRoot
  ) {
    return refuse('chain.reserve_mismatch')
  }
  const key = await chain.agentKey(lockInfo.account, auth.agentKey)
  if (!key?.active || (key.expiry !== null && key.expiry <= input.now)) {
    return refuse('chain.agent_key_inactive')
  }
  if (key.witness === null || key.witness !== auth.mandateHash) {
    return refuse('chain.mandate_mismatch')
  }

  // The buyer's mandate, when the supplier has it.
  if (input.mandate !== undefined) {
    const m = parseSigned(input.mandate, 'Mandate', mandateJson, {
      chainId: config.chainId,
      lock,
    })
    if (!m.ok) return m
    const mandate = m.value.message
    if (mandateHash(mandate, d) !== auth.mandateHash) {
      return refuse('authorization.mandate_mismatch')
    }
    if (
      !isAddressEqual(mandate.account, lockInfo.account) ||
      !isAddressEqual(mandate.agentKey, auth.agentKey)
    ) {
      return refuse('authorization.mandate_mismatch')
    }
    const signedByAccount = await isSignedBy(
      mandateTypedData(mandate, d),
      m.value.signature,
      lockInfo.account,
      deps.accountSignatureCheck,
    )
    if (!signedByAccount) return refuse('mandate.signature_invalid')
    if (mandate.expiry <= input.now) return refuse('mandate.expired')
  }

  // Last, so only a message that passed everything uses up its nonce.
  const fresh = await deps.replay.recordOnce(
    replayKey('SupplierAuthorization', signer, auth.nonce),
    auth.expiry,
  )
  if (!fresh) return refuse('message.replayed')

  return { ok: true, authorization: auth, lock, account: lockInfo.account, signer }
}
