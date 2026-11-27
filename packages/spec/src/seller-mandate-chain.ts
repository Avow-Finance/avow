import { type Address, type Hex, isAddressEqual } from 'viem'
import { type AvowDomain, isSignedBy, type SignatureCheck, type Signed } from './eip712.js'
import { holdsOnly } from './fields.js'
import { MAX_MANDATE_CHAIN } from './mandate-chain.js'
import type { ReasonCode } from './reasons.js'
import {
  parseSellerKeyRevocation,
  revokesSellerKey,
  type SellerKeyRevocation,
  type SellingAgent,
} from './seller-key-revocation.js'
import {
  parseSellerMandate,
  type SellerMandate,
  sellerMandateHash,
  sellerMandateProblem,
  sellerMandateTypedData,
} from './seller-mandate.js'
import { heldEnvelopeProblem, type Parsed } from './wire.js'

/**
 * Every seller's mandate one signing key has held, as whoever stores them serves them: the one the
 * agent sells under now, and each one that mandate replaced, newest first. The last of `earlier`
 * replaces none, or `current` replaces none when the agent was never given another. `revocation`
 * is the administrator's revocation of the key, or null. A chain holds no more mandates than a
 * buyer's, `MAX_MANDATE_CHAIN`.
 */
export interface SellerMandates {
  current: Signed<SellerMandate>
  earlier: Signed<SellerMandate>[]
  revocation: Signed<SellerKeyRevocation> | null
}

declare const read: unique symbol

/**
 * A signing key's seller's mandates read as one chain: they link, the business account signed
 * every one, and no revocation of the key came with them. Only `sellerMandateChainProblem` makes
 * one, and the mark below keeps a value written by hand from passing as one it read.
 */
export interface SellerMandateChain {
  current: { signed: Signed<SellerMandate>; hash: Hex }
  /** The hashes of the mandates the current one replaced, newest first. */
  earlier: Hex[]
  readonly [read]: true
}

const SERVED_KEYS = ['current', 'earlier', 'revocation']

/**
 * Parses the seller's mandates served for one signing key. Each has to parse as a seller's mandate
 * for the lock, and the revocation as one when there is one. It checks neither that they link nor
 * who signed them, which `sellerMandateChainProblem` does.
 */
export function parseSellerMandates(
  json: unknown,
  expected: { chainId: number; lock: Address },
): Parsed<SellerMandates> {
  if (typeof json !== 'object' || json === null || !holdsOnly(json, SERVED_KEYS)) {
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
  if (revocation === null) {
    return { ok: true, value: { current: head.value, earlier: rest, revocation } }
  }
  const revoked = parseSellerKeyRevocation(revocation, expected)
  if (!revoked.ok) return revoked
  return { ok: true, value: { current: head.value, earlier: rest, revocation: revoked.value } }
}

type Read = { ok: true; value: SellerMandateChain } | { ok: false; reason: ReasonCode }
type Expected = { domain: AvowDomain } & SellingAgent

/**
 * Reads a signing key's seller's mandates as one chain, and returns each hash, or the reason they
 * aren't one. It is the one way to a `SellerMandateChain`, so a chain nobody checked the signatures
 * of never looks like one somebody did. It throws only what the caller's signature check throws.
 * What it's handed holds exactly a current mandate, the earlier ones and a revocation or null, and
 * each signed message holds exactly an envelope's fields, as one read from JSON does.
 *
 * Every mandate sits in a seller's mandate's envelope for the expected lock, is well formed, and
 * names the expected business, account and signing key. A buyer's chain ends at the mandate its
 * key carries on Tempo's keychain. A seller's has no such anchor, so the caller says whose mandates
 * it expects, and a chain another account signed for this key is refused. Each mandate but the
 * oldest names the hash of the one before it in `replaces`, and the oldest names none. Hashes are
 * worked out here, never taken from whoever served the chain, so a mandate can't be left out of
 * the middle or slipped in without the links breaking.
 *
 * A revocation that comes with the chain and names its key ends it, as `seller_mandate.revoked`.
 * That answer means a revocation was served, and its signature wasn't read. A forged one can only
 * stop an agent selling, which whoever serves the chain can do by serving nothing. Whoever records
 * a revocation checks it first, with `sellerKeyRevocationSignatureProblem`. A revocation for
 * another business, account or key has no place beside this chain, and is refused as
 * `message.invalid`.
 *
 * Last, the business account has to have signed every mandate, the replaced ones too, or the
 * answer is `seller_mandate.signature_invalid`. The default check recovers a secp256k1 signer, and
 * an account whose root key is a passkey takes the caller's own check.
 *
 * It reads only what it's handed. It can't see a newer mandate or a revocation its server left
 * out, a second mandate signed to replace the same one, or a second first mandate for the key.
 * Whoever stores mandates has to refuse those, and to serve a revoked key's revocation with every
 * chain for it.
 */
export async function sellerMandateChainProblem(
  mandates: SellerMandates,
  expected: Expected,
  check?: SignatureCheck,
): Promise<Read> {
  let linked: { all: Signed<SellerMandate>[]; hashes: Hex[] }
  try {
    const read = linkedMandates(mandates, expected)
    if ('reason' in read) return { ok: false, reason: read.reason }
    linked = read
  } catch {
    // A value that throws when read is no chain.
    return { ok: false, reason: 'message.invalid' }
  }
  for (const { message, signature } of linked.all) {
    const typedData = sellerMandateTypedData(message, expected.domain)
    if (!(await isSignedBy(typedData, signature, expected.account, check))) {
      return { ok: false, reason: 'seller_mandate.signature_invalid' }
    }
  }
  const [current, ...earlier] = linked.hashes
  return {
    ok: true,
    value: {
      current: { signed: linked.all[0] as Signed<SellerMandate>, hash: current as Hex },
      earlier,
    } as SellerMandateChain,
  }
}

/** The chain's own copy of each mandate with its hash, or why the mandates served aren't a chain. */
function linkedMandates(
  mandates: SellerMandates,
  expected: Expected,
): { all: Signed<SellerMandate>[]; hashes: Hex[] } | { reason: ReasonCode } {
  const no = (reason: ReasonCode) => ({ reason })
  // Everything is read once, into copies, so what's checked is what's hashed and handed back.
  const served = structuredClone(mandates)
  if (typeof served !== 'object' || served === null || !holdsOnly(served, SERVED_KEYS)) {
    return no('message.invalid')
  }
  const { current, earlier, revocation } = served
  if (!Array.isArray(earlier) || earlier.length >= MAX_MANDATE_CHAIN) return no('message.invalid')
  const where = { chainId: expected.domain.chainId, lock: expected.domain.verifyingContract }
  const all = [current, ...earlier]
  for (const signed of all) {
    const envelope = heldEnvelopeProblem(signed, { type: 'SellerMandate', ...where })
    if (envelope) return no(envelope)
    const m = signed.message
    const problem = sellerMandateProblem(m)
    if (problem) return no(problem)
    if (!isAddressEqual(m.signingKey, expected.signingKey)) return no('seller_mandate.key_mismatch')
    if (m.businessId !== expected.businessId || !isAddressEqual(m.account, expected.account)) {
      return no('seller_mandate.chain_mismatch')
    }
  }
  const hashes = all.map((s) => sellerMandateHash(s.message, expected.domain))
  for (const [i, signed] of all.entries()) {
    // A well-formed mandate's hashes are in lower case, as the ones worked out here are.
    if (signed.message.replaces !== (hashes[i + 1] ?? null)) {
      return no('seller_mandate.chain_mismatch')
    }
  }
  if (revocation !== null) {
    const envelope = heldEnvelopeProblem(revocation, { type: 'SellerKeyRevocation', ...where })
    if (envelope) return no(envelope)
    if (!revokesSellerKey(revocation.message, expected)) return no('message.invalid')
    return no('seller_mandate.revoked')
  }
  return { all, hashes }
}
