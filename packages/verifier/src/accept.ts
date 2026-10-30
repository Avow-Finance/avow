import {
  type Acceptance,
  type AnyTerms,
  type Approval,
  type ApprovalCaps,
  type AvowDomain,
  acceptanceTypedData,
  approvalCaps,
  approvalDigest,
  approvalJson,
  approvalMandateProblem,
  approvalPartiesProblem,
  approvalTermsProblem,
  approvalTokenProblem,
  digestOf,
  type HashSigner,
  isKeySignature,
  isTermsV1,
  type LockTerms,
  type LockTiming,
  lockTerms,
  MESSAGE_VERSIONS,
  parseSigned,
  type ReasonCode,
  type Signed,
  termsShapeProblem,
} from '@avow-finance/spec'
import {
  type Address,
  encodeFunctionData,
  type Hex,
  isAddressEqual,
  isHex,
  size,
  zeroAddress,
} from 'viem'
import { type Agreed, checkAuthorization, same } from './authorization.js'
import type { ChainReader, LockedBacking } from './chain.js'
import { acceptanceDisclosure, type Disclosure, disclosureId } from './disclosure.js'
import { issue, wasIssued } from './issued.js'
import { randomNonce } from './nonce.js'
import type { VerifierConfig } from './verify.js'

/** An acceptance stays valid for ten minutes at most, and never past the acceptance deadline. */
export const ACCEPTANCE_VALIDITY = 600n

export interface AcceptanceConfig extends VerifierConfig {
  /** The supplier's account on the rail, which Avow's approval must name. */
  account: Address
  /** The supplier's signing key, which signs the acceptance and which the approval must name. */
  signingKey: Address
}

export interface AcceptanceDeps {
  config: AcceptanceConfig
  chain: ChainReader
}

/** What a supplier hands the verifier to get an acceptance to sign. */
export interface AcceptanceRequest {
  /** Avow's signed supplier authorization for the commitment, as JSON. */
  authorization: unknown
  /** Avow's signed approval that the reserve carried to the lock, as JSON. */
  approval: unknown
  /** The buyer's signed mandate, as JSON. The acceptance path refuses without it. */
  mandate: unknown
  /**
   * The commitment the supplier agreed to, from the terms agreement it signed, with the buyer
   * and the buyer's mandate that agreement names.
   */
  agreed: Required<Agreed>
  /**
   * The terms this supplier agreed to for the booking, from its own records. Version 2, or version
   * 1 for a commitment made under it.
   */
  terms: AnyTerms
  now: bigint
  /** The acceptance's nonce, a fresh random one when left out. */
  nonce?: bigint
}

export interface ReadyAcceptance {
  ok: true
  acceptance: Acceptance
  domain: AvowDomain
  /** The digest the supplier's signing key signs. */
  digest: Hex
  /** The digest of Avow's approval, which the lock stored and the acceptance names. */
  approvalDigest: Hex
  /** The key that has to sign, the supplier's own signing key. */
  signingKey: Address
  /** What to show the person who approves the signature, before signing. */
  disclosure: Disclosure
}

export type PreparedAcceptance = ReadyAcceptance | { ok: false; reason: ReasonCode }

const sameTiming = (a: LockTiming, b: LockTiming) =>
  a.minContestWindow === b.minContestWindow &&
  a.confirmWindow === b.confirmWindow &&
  a.rulingDelay === b.rulingDelay &&
  a.rulingKeyEnd === b.rulingKeyEnd &&
  a.day90 === b.day90

/**
 * The supported way for a supplier to get an acceptance to sign. An acceptance binds the supplier
 * to everything in Avow's approval, so this builds one only after every check passes, and refuses
 * with the first reason that applies.
 *
 * 1. Avow's authorization passes every check `verifySupplierAuthorization` makes, with the buyer's
 *    signed mandate required, so a mandate that's forged, expired, revoked with its agent key, or
 *    that doesn't allow this supplier, category, currency, token or amount refuses.
 * 2. Avow's approval names the commitment the supplier agreed to, the supplier's own account,
 *    signing key and payout, and the token, amount, deadlines, contest window, terms hash, charges,
 *    day-90 share and arbiter of the supplier's own terms.
 * 3. It names the mandate Avow's authorization names, that mandate's two caps, and a funding key
 *    that's the mandate's agent key or the account's root key and that funded the reserve.
 * 4. The lock stores the digest of exactly this approval and the same terms, and its token and
 *    dispute timing are the ones the supplier's profile accepts.
 *
 * It records nothing, since the lock takes one acceptance per reserve. What it returns is frozen,
 * and `signAcceptance` signs nothing else. The checks protect a supplier who signs only through
 * these two calls. The lock checks the signature and the digest, so it takes a correctly signed
 * acceptance however it was built.
 *
 * Throws when the setup is wrong or the chain can't be read, as `verifySupplierAuthorization` does.
 */
export async function prepareAcceptance(
  request: AcceptanceRequest,
  deps: AcceptanceDeps,
): Promise<PreparedAcceptance> {
  const { config, chain } = deps
  const refuse = (reason: ReasonCode): PreparedAcceptance => ({ ok: false, reason })
  const t = request.terms
  const shape = termsShapeProblem(t)
  if (shape) return refuse(shape)
  // Version 1 terms written before the dispute block existed can't be checked against the approval.
  if (isTermsV1(t) && !(t as { dispute?: unknown }).dispute) return refuse('terms.incomplete')
  if (request.mandate === undefined || request.mandate === null) return refuse('mandate.missing')
  // The buyer and its mandate come from the agreement the supplier signed, so they're required.
  const { buyerBusinessId, mandateHash: agreedMandate } = request.agreed ?? {}
  if (typeof buyerBusinessId !== 'string' || !isHex(agreedMandate) || size(agreedMandate) !== 32) {
    return refuse('message.invalid')
  }

  const checked = await checkAuthorization(
    {
      authorization: request.authorization,
      agreed: request.agreed,
      terms: t,
      mandate: request.mandate,
      now: request.now,
    },
    config,
    chain,
  )
  if (!checked.ok) return checked
  const { authorization: auth, lock, domain: d, lockInfo, backing, token, mandate } = checked
  if (!mandate) return refuse('mandate.missing')

  const parsed = parseSigned(request.approval, 'Approval', approvalJson, {
    chainId: config.chainId,
    lock,
  })
  if (!parsed.ok) return parsed
  const a = parsed.value.message

  // The approval against the supplier's own records.
  if (!same(a.commitmentId, request.agreed.commitmentId)) {
    return refuse('approval.commitment_mismatch')
  }
  const parties = approvalPartiesProblem(a, config)
  if (parties) return refuse(parties)
  let enforced: LockTerms
  let caps: ApprovalCaps
  try {
    enforced = lockTerms(t, token.decimals)
    caps = approvalCaps(mandate, token.decimals)
  } catch {
    return refuse('authorization.token_not_accepted')
  }
  if (a.side !== 'buyer') return refuse('approval.terms_mismatch')
  const tokenProblem = approvalTokenProblem(a, token.token)
  if (tokenProblem) return refuse(tokenProblem)
  // Every field the lock enforces has to be what the supplier's own terms map to, through the
  // same mapping Avow's API signs with, under the terms hash the supplier agreed to.
  const differs = approvalTermsProblem(a, {
    lock: enforced,
    termsHash: request.agreed.termsHash,
  })
  if (differs) return refuse(differs)

  // The approval against the buyer's mandate and Avow's authorization. The reserve may come from
  // the mandate's agent key or the account's root key.
  const mandateProblem = approvalMandateProblem(a, {
    mandateHash: auth.mandateHash,
    caps,
    fundingKeys: [mandate.agentKey, zeroAddress],
  })
  if (mandateProblem) return refuse(mandateProblem)
  // And it has to name the key that funded the reserve.
  if (!isAddressEqual(a.fundingKey, backing.fundingKey)) return refuse('approval.mandate_mismatch')

  // The lock holds this exact approval, under settings the supplier accepts.
  const approvalHash = approvalDigest(a, d)
  if (!same(backing.approvalHash, approvalHash) || !holdsApproval(backing, a)) {
    return refuse('chain.approval_mismatch')
  }
  if (
    !isAddressEqual(lockInfo.token, a.token) ||
    !sameTiming(lockInfo.timing, config.profile.lockTiming)
  ) {
    return refuse('chain.lock_timing_unexpected')
  }

  const latest = request.now + ACCEPTANCE_VALIDITY
  const acceptance: Acceptance = {
    commitmentId: a.commitmentId,
    side: 'buyer',
    approvalHash,
    termsHash: a.termsHash,
    amount: a.amount,
    token: a.token,
    acceptBy: a.acceptBy,
    nonce: request.nonce ?? randomNonce(),
    expiry: latest < a.acceptBy ? latest : a.acceptBy,
  }
  const digest = digestOf(acceptanceTypedData(acceptance, d))
  return issue({
    ok: true,
    acceptance,
    domain: d,
    digest,
    approvalDigest: approvalHash,
    signingKey: config.signingKey,
    disclosure: acceptanceDisclosure({
      digest,
      expiry: acceptance.expiry,
      approval: a,
      approvalDigest: approvalHash,
      lock,
      chainId: config.chainId,
      account: lockInfo.account,
      token,
      timing: lockInfo.timing,
    }),
  })
}

/** Whether the lock's record names the approval's parties, terms hash and mandate hash. */
function holdsApproval(b: LockedBacking, a: Approval): boolean {
  // Its lock-enforced fields already match, since the record and the approval each match the terms.
  return (
    isAddressEqual(b.payee, a.payee) &&
    isAddressEqual(b.supplier, a.supplier) &&
    isAddressEqual(b.supplierSigner, a.supplierSigner) &&
    same(b.termsHash, a.termsHash) &&
    same(b.mandateHash, a.mandateHash)
  )
}

/**
 * Signs an acceptance with the supplier's signing key, once the person has seen its disclosure. It
 * signs only the object `prepareAcceptance` returned, which is frozen, so a copy or an edit of it
 * throws. It also throws when the confirmation names another disclosure, or when the key isn't
 * the signing key Avow's approval names.
 */
export async function signAcceptance(
  prepared: ReadyAcceptance,
  key: HashSigner,
  confirmation: { disclosureId: Hex },
): Promise<Signed<Acceptance>> {
  if (!wasIssued(prepared)) {
    throw new Error('Sign only the acceptance prepareAcceptance returned, as it returned it')
  }
  const digest = digestOf(acceptanceTypedData(prepared.acceptance, prepared.domain))
  const { disclosure } = prepared
  if (
    !same(digest, prepared.digest) ||
    !same(disclosure.digest, digest) ||
    !same(disclosureId(disclosure), disclosure.id)
  ) {
    throw new Error('The acceptance or its disclosure changed after prepareAcceptance built them')
  }
  if (!same(confirmation?.disclosureId, disclosure.id)) {
    throw new Error(
      "Show the person this acceptance's disclosure, and pass its id back once they confirm it",
    )
  }
  const signature = await key.sign({ hash: digest })
  if (!isKeySignature(digest, signature, prepared.signingKey)) {
    throw new Error("The key that signed isn't the signing key Avow's approval names")
  }
  return {
    type: 'Acceptance',
    schemaVersion: MESSAGE_VERSIONS.Acceptance,
    chainId: prepared.domain.chainId,
    lock: prepared.domain.verifyingContract,
    message: prepared.acceptance,
    signature,
  }
}

/**
 * The lock's `accept`, as the testnet lock declares it. Anyone can send it, since the lock checks
 * the supplier's signing key signed the acceptance, so a supplier can send it from any account
 * that pays the fee.
 */
export const ACCEPT_ABI = [
  {
    type: 'function',
    name: 'accept',
    inputs: [
      {
        name: 'm',
        type: 'tuple',
        components: [
          { name: 'commitmentId', type: 'bytes32' },
          { name: 'side', type: 'uint8' },
          { name: 'approvalHash', type: 'bytes32' },
          { name: 'termsHash', type: 'bytes32' },
          { name: 'amount', type: 'uint256' },
          { name: 'token', type: 'address' },
          { name: 'acceptBy', type: 'uint64' },
          { name: 'nonce', type: 'uint256' },
          { name: 'expiry', type: 'uint64' },
        ],
      },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const

/**
 * The call that hands a signed acceptance to its lock, with the fields exactly as they were signed,
 * so the lock checks the same digest the supplier's key signed.
 */
export function acceptCall(acceptance: Signed<Acceptance>): { to: Address; data: Hex } {
  const d: AvowDomain = { chainId: acceptance.chainId, verifyingContract: acceptance.lock }
  return {
    to: acceptance.lock,
    data: encodeFunctionData({
      abi: ACCEPT_ABI,
      functionName: 'accept',
      args: [acceptanceTypedData(acceptance.message, d).message, acceptance.signature],
    }),
  }
}
