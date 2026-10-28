import {
  type Acceptance,
  type Approval,
  type AvowDomain,
  acceptanceTypedData,
  approvalDigest,
  approvalJson,
  CHARGE_KINDS,
  type Charge,
  type ComputeTerms,
  digestOf,
  type HashSigner,
  isKeySignature,
  type LockTiming,
  parseSigned,
  type ReasonCode,
  SCHEMA_VERSION,
  type Signed,
  termsCharges,
  toTokenUnits,
} from '@avow-finance/spec'
import {
  type Address,
  type Hex,
  hexToBigInt,
  isAddressEqual,
  isHex,
  size,
  toHex,
  zeroAddress,
} from 'viem'
import { type Agreed, checkAuthorization, same } from './authorization.js'
import type { ChainReader, LockedBacking } from './chain.js'
import { acceptanceDisclosure, type Disclosure, disclosureId } from './disclosure.js'
import { issue, wasIssued } from './issued.js'
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
  /** The terms this supplier agreed to for the booking, from its own records. */
  terms: ComputeTerms
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

const sameCharges = (a: readonly Charge[], b: readonly Charge[]) =>
  a.length === b.length &&
  a.every((c, i) => {
    const d = b[i]
    return d !== undefined && c.kind === d.kind && c.most === d.most && c.earliest === d.earliest
  })

const sameTiming = (a: LockTiming, b: LockTiming) =>
  a.minContestWindow === b.minContestWindow &&
  a.confirmWindow === b.confirmWindow &&
  a.rulingDelay === b.rulingDelay &&
  a.rulingKeyEnd === b.rulingKeyEnd &&
  a.day90 === b.day90

const randomNonce = () => hexToBigInt(toHex(crypto.getRandomValues(new Uint8Array(32))))

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
  // Terms written before the dispute block existed can't be checked against the approval.
  if (!(t as Partial<ComputeTerms>).dispute) return refuse('terms.incomplete')
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
  if (
    !isAddressEqual(a.supplier, config.account) ||
    !isAddressEqual(a.supplierSigner, config.signingKey) ||
    !isAddressEqual(a.payee, config.payee)
  ) {
    return refuse('approval.parties_mismatch')
  }
  let units: (micros: bigint) => bigint
  let charges: Charge[]
  let caps: [bigint, bigint]
  try {
    units = (micros) => toTokenUnits(micros, token.decimals)
    charges = termsCharges(t, token.decimals)
    caps = [units(mandate.capPerCommitment), units(mandate.capOpenReserves)]
  } catch {
    return refuse('authorization.token_not_accepted')
  }
  if (
    a.side !== 'buyer' ||
    !isAddressEqual(a.token, token.token) ||
    a.amount !== units(t.reserve) ||
    a.freeCancelBy !== t.freeCancelBy ||
    a.acceptBy !== t.acceptBy ||
    a.chargeDeadline !== t.chargeDeadline ||
    a.releaseDate !== t.releaseDate ||
    a.contestWindow !== t.contestWindow ||
    !same(a.termsHash, request.agreed.termsHash)
  ) {
    return refuse('approval.terms_mismatch')
  }
  if (!sameCharges(a.charges, charges)) return refuse('approval.charges_mismatch')
  if (
    a.day90SupplierShareBps !== t.dispute.day90SupplierShareBps ||
    !isAddressEqual(a.arbiter, t.dispute.arbiter)
  ) {
    return refuse('approval.dispute_mismatch')
  }

  // The approval against the buyer's mandate, Avow's authorization and who funded the reserve.
  const fundedByAgentOrRoot =
    isAddressEqual(a.fundingKey, mandate.agentKey) || isAddressEqual(a.fundingKey, zeroAddress)
  if (
    !same(a.mandateHash, auth.mandateHash) ||
    a.capPerCommitment !== caps[0] ||
    a.capOpenReserves !== caps[1] ||
    !fundedByAgentOrRoot ||
    !isAddressEqual(a.fundingKey, backing.fundingKey)
  ) {
    return refuse('approval.mandate_mismatch')
  }

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

/** Whether the lock's record carries the approval's terms, field by field. */
function holdsApproval(b: LockedBacking, a: Approval): boolean {
  const byKind = (x: Charge, y: Charge) => CHARGE_KINDS[x.kind] - CHARGE_KINDS[y.kind]
  return (
    b.amount === a.amount &&
    isAddressEqual(b.payee, a.payee) &&
    isAddressEqual(b.supplier, a.supplier) &&
    isAddressEqual(b.supplierSigner, a.supplierSigner) &&
    b.freeCancelBy === a.freeCancelBy &&
    b.acceptBy === a.acceptBy &&
    b.chargeDeadline === a.chargeDeadline &&
    b.releaseDate === a.releaseDate &&
    b.contestWindow === a.contestWindow &&
    sameCharges([...b.charges].sort(byKind), [...a.charges].sort(byKind)) &&
    b.day90SupplierShareBps === a.day90SupplierShareBps &&
    isAddressEqual(b.arbiter, a.arbiter) &&
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
    schemaVersion: SCHEMA_VERSION,
    chainId: prepared.domain.chainId,
    lock: prepared.domain.verifyingContract,
    message: prepared.acceptance,
    signature,
  }
}
