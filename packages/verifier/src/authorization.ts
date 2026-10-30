import {
  type AnyTerms,
  AUTHORIZATION_TERMS_FIELDS,
  type AvowDomain,
  assertTestSettingsOnTestnet,
  checkMandate,
  digestOf,
  enforceableTerms,
  type LockTerms,
  lockRecordDifferences,
  lockTerms,
  lockTermsDifferences,
  type Mandate,
  mandateHash,
  mandateJson,
  mandateTypedData,
  parseSigned,
  plainTermsOf,
  type RailToken,
  type ReasonCode,
  type SupplierAuthorization,
  supplierAuthorizationJson,
  supplierAuthorizationTypedData,
  termsHash,
  termsShapeProblem,
  validateChainedTerms,
  validateTerms,
} from '@avow-finance/spec'
import { type Address, type Hex, isAddressEqual, recoverAddress, zeroAddress } from 'viem'
import type { ChainReader, LockedBacking, LockInfo } from './chain.js'
import type { CheckedChainedTerms } from './dependency.js'
import type { VerifierConfig } from './verify.js'

/** Avow signs a supplier authorization for five minutes. */
export const AUTHORIZATION_VALIDITY = 300n
/** Room for the supplier's clock to run behind Avow's. */
const CLOCK_ALLOWANCE = 60n

/** What the supplier agreed to, from the terms agreement it signed. */
export interface Agreed {
  commitmentId: Hex
  termsHash: Hex
  category: string
  /** The buyer the agreement names. Checked when given. */
  buyerBusinessId?: string
  /** The buyer's mandate the agreement names, which also names the buyer's lock. Checked when given. */
  mandateHash?: Hex
}

/**
 * The supplier's own terms, as an authorization is checked against them. Plain terms are version
 * 2, or version 1 for a commitment made under it. Chained terms are version 3 terms every booking
 * of which passed `verifyDependencies`, which only that check gives.
 */
export type TermsUnderCheck =
  | { kind: 'plain'; terms: AnyTerms }
  | { kind: 'chained'; terms: CheckedChainedTerms }

/**
 * The terms the rules, the mandate and the lock read. Version 3 terms make the plain booking
 * `plainTermsOf` gives, since the lock enforces nothing in their dependencies section.
 */
export function plainTerms(under: TermsUnderCheck): AnyTerms {
  return under.kind === 'plain' ? under.terms : plainTermsOf(under.terms)
}

export interface AuthorizationInput {
  authorization: unknown
  agreed: Agreed
  terms: TermsUnderCheck
  mandate?: unknown
  now: bigint
}

export type AuthorizationCheck =
  | {
      ok: true
      authorization: SupplierAuthorization
      lock: Address
      domain: AvowDomain
      lockInfo: LockInfo
      backing: LockedBacking
      token: RailToken
      /** The buyer's mandate, when the caller passed it and it passed. */
      mandate: Mandate | null
      signer: Address
    }
  | { ok: false; reason: ReasonCode }

/** Equal hex values in any letter case. Anything that isn't a string is never equal. */
export const same = (a: Hex, b: Hex) =>
  typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()

/**
 * Every check of a supplier authorization except the record that it passed, which only
 * `verifySupplierAuthorization` makes. `prepareAcceptance` runs the same checks again with the
 * buyer's mandate required.
 */
export async function checkAuthorization(
  input: AuthorizationInput,
  config: VerifierConfig,
  chain: ChainReader,
): Promise<AuthorizationCheck> {
  if (chain.chainId !== config.chainId) {
    throw new Error(`The chain reader is for chain ${chain.chainId}, not ${config.chainId}`)
  }
  assertTestSettingsOnTestnet({
    chainId: config.chainId,
    testData: config.acceptTestData,
    profile: config.profile,
  })
  const refuse = (reason: ReasonCode): AuthorizationCheck => ({ ok: false, reason })

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
  const { buyerBusinessId, mandateHash: agreedMandate } = input.agreed
  if (buyerBusinessId !== undefined && auth.buyerBusinessId !== buyerBusinessId) {
    return refuse('authorization.buyer_mismatch')
  }
  if (agreedMandate !== undefined && !same(auth.mandateHash, agreedMandate)) {
    return refuse('authorization.mandate_mismatch')
  }
  if (auth.kybTestData && !config.acceptTestData) return refuse('business.test_data')

  // The supplier's terms against the ones Avow signed, once they have a shape the hash covers.
  const under = input.terms
  // Checked version 3 terms passed their shape check in `verifyDependencies`.
  if (under.kind === 'plain') {
    const shape = termsShapeProblem(under.terms)
    if (shape) return refuse(shape)
  }
  if (!same(termsHash(under.terms, auth.salt), auth.termsHash)) return refuse('terms.hash_mismatch')
  const termsProblem =
    under.kind === 'plain'
      ? validateTerms(under.terms, config.profile)
      : validateChainedTerms(under.terms, config.profile)
  if (termsProblem) return refuse(termsProblem)
  const t = plainTerms(under)
  // What the lock enforces, read from the supplier's terms the way Avow's API reads them.
  const e = enforceableTerms(t)
  const token = config.acceptedTokens.find(
    (a) =>
      a.chainId === config.chainId &&
      isAddressEqual(a.token, auth.token) &&
      a.currency === e.currency,
  )
  if (!token) return refuse('authorization.token_not_accepted')
  // Every value the lock enforces, in the token's base units.
  let expected: LockTerms
  try {
    expected = lockTerms(t, token.decimals)
  } catch {
    return refuse('authorization.token_not_accepted')
  }
  if (lockTermsDifferences(auth, expected, AUTHORIZATION_TERMS_FIELDS).length > 0) {
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
  // The lock's record has to hold Avow's authorization and enforce exactly what the terms map to,
  // in every field it stores.
  if (
    !isAddressEqual(backing.token, auth.token) ||
    !isAddressEqual(backing.payee, auth.payee) ||
    !same(backing.termsHash, auth.termsHash) ||
    !fundedByAgentOrRoot ||
    lockRecordDifferences(backing, expected).length > 0
  ) {
    return refuse('chain.reserve_mismatch')
  }
  const key = await chain.agentKey(lockInfo.account, auth.agentKey, auth.agentKeyAuthorizedIn)
  if (!key?.active) return refuse('chain.agent_key_inactive')
  // The key has to last until nothing more can happen to the commitment.
  if (key.expiry !== null && key.expiry < e.releaseDate) return refuse('chain.agent_key_inactive')
  if (key.witness === null || !same(key.witness, auth.mandateHash)) {
    return refuse('chain.mandate_mismatch')
  }

  // The buyer's mandate, when the supplier has it: its hash, its signer and its limits.
  let mandate: Mandate | null = null
  if (input.mandate !== undefined) {
    const m = parseSigned(input.mandate, 'Mandate', mandateJson, {
      chainId: config.chainId,
      lock,
    })
    if (!m.ok) return m
    mandate = m.value.message
    if (
      !same(mandateHash(mandate, d), auth.mandateHash) ||
      mandate.businessId !== auth.buyerBusinessId ||
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

  return {
    ok: true,
    authorization: auth,
    lock,
    domain: d,
    lockInfo,
    backing,
    token,
    mandate,
    signer,
  }
}
