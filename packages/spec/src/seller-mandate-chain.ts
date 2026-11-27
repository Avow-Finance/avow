import { type Address, type Hex, isAddressEqual } from 'viem'
import { type AvowDomain, isSignedBy, type SignatureCheck, type Signed } from './eip712.js'
import { MAX_MANDATE_CHAIN } from './mandate-chain.js'
import type { ReasonCode } from './reasons.js'
import {
  parseSellerMandate,
  type SellerMandate,
  sellerMandateHash,
  sellerMandateProblem,
  sellerMandateTypedData,
} from './seller-mandate.js'
import {
  parseSellerMandateRevocation,
  type SellerMandateRevocation,
  sellerMandateRevocationProblem,
} from './seller-mandate-revocation.js'
import type { Parsed } from './wire.js'

/**
 * Every seller's mandate one signing key has held, as whoever stores them serves them: the one the
 * agent sells under now, and each one that mandate replaced, newest first. The last of `earlier`
 * replaces none, or `current` replaces none when the agent was never given another. `revocation`
 * is the administrator's revocation of any mandate among them, or null.
 */
export interface SellerMandates {
  current: Signed<SellerMandate>
  earlier: Signed<SellerMandate>[]
  revocation: Signed<SellerMandateRevocation> | null
}

/** A signing key's seller's mandates checked as one chain nobody revoked, with each hash. */
export interface SellerMandateChain {
  current: { signed: Signed<SellerMandate>; hash: Hex }
  /** The hashes of the mandates the current one replaced, newest first. */
  earlier: Hex[]
}

/**
 * Parses the seller's mandates served for one signing key. Each has to parse as a seller's mandate
 * for the lock, the revocation as one when there is one, and the chain can't hold more than
 * `MAX_MANDATE_CHAIN`. It doesn't check that they link, which `sellerMandateChainProblem` does.
 */
export function parseSellerMandates(
  json: unknown,
  expected: { chainId: number; lock: Address },
): Parsed<SellerMandates> {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return { ok: false, reason: 'message.invalid' }
  }
  const keys = Object.keys(json)
  if (keys.length !== 3 || !['current', 'earlier', 'revocation'].every((k) => keys.includes(k))) {
    return { ok: false, reason: 'message.invalid' }
  }
  const { current, earlier, revocation } = json as Record<string, unknown>
  if (!Array.isArray(earlier) || earlier.length >= MAX_MANDATE_CHAIN) {
    return { ok: false, reason: 'message.invalid' }
  }
  const head = parseSellerMandate(current, expected)
  if (!head.ok) return head
  const rest: Signed<SellerMandate>[] = []
  // `Array.from` turns a hole into undefined, which parses as no mandate.
  for (const e of Array.from(earlier)) {
    const read = parseSellerMandate(e, expected)
    if (!read.ok) return read
    rest.push(read.value)
  }
  if (revocation === null)
    return { ok: true, value: { current: head.value, earlier: rest, revocation } }
  const revoked = parseSellerMandateRevocation(revocation, expected)
  if (!revoked.ok) return revoked
  return { ok: true, value: { current: head.value, earlier: rest, revocation: revoked.value } }
}

/**
 * Checks a signing key's seller's mandates link into one chain that nobody revoked, and returns
 * each hash, or the reason they don't. It never throws.
 *
 * Every mandate is well formed, sits in an envelope for the expected lock, and names the expected
 * business, account and signing key. A buyer's chain ends at the mandate its key carries on the
 * chain. A seller's has no such anchor, so the caller says whose mandates it expects, and a chain
 * another account signed for this key is refused. Each mandate but the oldest names the hash of
 * the one before it in `replaces`, and the oldest names none. Hashes are worked out here, never
 * taken from whoever served the chain, so a mandate can't be left out of the middle or slipped in
 * without the links breaking.
 *
 * A revocation that names any mandate in the chain ends the whole chain, as
 * `seller_mandate.revoked`. A signature carries no time, so a mandate revoked and then replaced
 * can't be told from one replaced and then revoked, and the rule that needs no order is that a
 * revoked mandate is never replaced. A revocation served with a chain it names no mandate of, or
 * one for another business, account or key, is refused as `message.invalid`, since a reader that
 * skipped it could sell under a chain its server meant to end.
 *
 * It checks no signature, which `sellerMandatesSignatureProblem` does, and it reads a revocation's
 * signature at no point. A forged revocation can only stop an agent selling, which whoever serves
 * the chain can do by serving nothing. Whoever records a revocation checks its signature first.
 *
 * It says nothing about which mandate is current beyond the order served, and it can't see a newer
 * mandate or a revocation its server left out. Avow is to decide both by approving a reserve only
 * for a sale under the current mandate of a chain nobody revoked.
 */
export function sellerMandateChainProblem(
  mandates: SellerMandates,
  expected: { domain: AvowDomain; businessId: string; account: Address; signingKey: Address },
): { ok: true; value: SellerMandateChain } | { ok: false; reason: ReasonCode } {
  try {
    return chainProblem(mandates, expected)
  } catch {
    // A value that throws when read is no chain.
    return { ok: false, reason: 'message.invalid' }
  }
}

function chainProblem(
  mandates: SellerMandates,
  expected: { domain: AvowDomain; businessId: string; account: Address; signingKey: Address },
): { ok: true; value: SellerMandateChain } | { ok: false; reason: ReasonCode } {
  const no = (reason: ReasonCode) => ({ ok: false, reason }) as const
  if (!Array.isArray(mandates.earlier) || mandates.earlier.length >= MAX_MANDATE_CHAIN) {
    return no('message.invalid')
  }
  const all = [mandates.current, ...Array.from(mandates.earlier)]
  const inEnvelope = (s: Signed<unknown>) =>
    typeof s === 'object' &&
    s !== null &&
    s.chainId === expected.domain.chainId &&
    typeof s.lock === 'string' &&
    isAddressEqual(s.lock, expected.domain.verifyingContract)
  for (const signed of all) {
    if (!inEnvelope(signed)) return no('message.invalid')
    const problem = sellerMandateProblem(signed.message)
    if (problem) return no(problem)
    const m = signed.message
    if (!isAddressEqual(m.signingKey, expected.signingKey)) return no('seller_mandate.key_mismatch')
    if (m.businessId !== expected.businessId || !isAddressEqual(m.account, expected.account)) {
      return no('seller_mandate.chain_mismatch')
    }
  }
  const hashes = all.map((s) => sellerMandateHash(s.message, expected.domain))
  for (let i = 0; i < all.length; i++) {
    // A well-formed mandate's hashes are in lower case, as the ones worked out here are.
    const before = hashes[i + 1] ?? null
    if ((all[i] as Signed<SellerMandate>).message.replaces !== before) {
      return no('seller_mandate.chain_mismatch')
    }
  }
  const { revocation } = mandates
  if (revocation !== null) {
    if (!inEnvelope(revocation) || sellerMandateRevocationProblem(revocation.message)) {
      return no('message.invalid')
    }
    const r = revocation.message
    if (
      r.businessId !== expected.businessId ||
      !isAddressEqual(r.account, expected.account) ||
      !isAddressEqual(r.signingKey, expected.signingKey) ||
      !hashes.includes(r.mandate)
    ) {
      return no('message.invalid')
    }
    return no('seller_mandate.revoked')
  }
  return {
    ok: true,
    value: {
      current: { signed: mandates.current, hash: hashes[0] as Hex },
      earlier: hashes.slice(1),
    },
  }
}

/**
 * Checks the business account signed every mandate in a chain `sellerMandateChainProblem` passed,
 * and gives `seller_mandate.signature_invalid` when one isn't. Every link is checked, the replaced
 * ones too, so the chain holds only what the administrator signed. The default check recovers a
 * secp256k1 signer. An account whose root key is a passkey takes the caller's own check.
 */
export async function sellerMandatesSignatureProblem(
  mandates: Pick<SellerMandates, 'current' | 'earlier'>,
  expected: { domain: AvowDomain; account: Address },
  check?: SignatureCheck,
): Promise<ReasonCode | null> {
  for (const signed of [mandates.current, ...mandates.earlier]) {
    const typedData = sellerMandateTypedData(signed.message, expected.domain)
    if (!(await isSignedBy(typedData, signed.signature, expected.account, check))) {
      return 'seller_mandate.signature_invalid'
    }
  }
  return null
}
