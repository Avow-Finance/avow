import { type Address, type Hex, isAddressEqual, zeroHash } from 'viem'
import { z } from 'zod'
import {
  type AvowDomain,
  digestOf,
  isSignedBy,
  type SignatureCheck,
  type Signed,
} from './eip712.js'
import { signedJson } from './json-fields.js'
import { isKeySignature } from './keychain.js'
import { MAX_MANDATE_CHAIN, type MandateChain } from './mandate-chain.js'
import type { ReasonCode } from './reasons.js'
import {
  type AuthorityLimits,
  MAX_SLICE_DEPTH,
  parseSlice,
  parseSliceRevocation,
  type Slice,
  type SliceRevocation,
  sliceHash,
  sliceProblem,
  sliceRevocationTypedData,
  sliceTypedData,
  sliceWidensProblem,
} from './slice.js'
import { heldEnvelopeProblem, type Parsed } from './wire.js'

/**
 * A worker's slices as Avow serves them: one level for each slice from the one just under the
 * agent's mandate down to the worker's own, each with its current version and every version it
 * replaced, newest first, and every revocation that names a key on the way.
 */
export interface WorkerSlices {
  levels: { current: Signed<Slice>; earlier: Signed<Slice>[] }[]
  revocations: Signed<SliceRevocation>[]
}

/** The JSON a worker's slices travel as. Each slice and revocation is checked as it's read. */
export const workerSlicesJson = z.strictObject({
  levels: z
    .array(
      z.strictObject({
        current: signedJson('One version of a slice, as a signed Slice'),
        earlier: z.array(signedJson('An earlier version of the same slice, as a signed Slice')),
      }),
    )
    .min(1),
  revocations: z.array(signedJson('A revocation of a worker key, as a signed SliceRevocation')),
})

/**
 * Reads a worker's slices from JSON, each slice and revocation under the business's lock. It holds
 * no more levels than `MAX_SLICE_DEPTH` and no more versions of one slice than a mandate's chain
 * holds. It doesn't check they link, which `sliceChainProblem` does.
 */
export function parseWorkerSlices(
  json: unknown,
  expected: { chainId: number; lock: Address },
): Parsed<WorkerSlices> {
  const read = workerSlicesJson.safeParse(json)
  if (!read.success) return { ok: false, reason: 'message.invalid' }
  if (read.data.levels.length > MAX_SLICE_DEPTH) return { ok: false, reason: 'slice.too_deep' }
  const levels: WorkerSlices['levels'] = []
  for (const level of read.data.levels) {
    if (level.earlier.length >= MAX_MANDATE_CHAIN) return { ok: false, reason: 'message.invalid' }
    const current = parseSlice(level.current, expected)
    if (!current.ok) return current
    const earlier: Signed<Slice>[] = []
    for (const e of level.earlier) {
      const version = parseSlice(e, expected)
      if (!version.ok) return version
      earlier.push(version.value)
    }
    levels.push({ current: current.value, earlier })
  }
  const revocations: Signed<SliceRevocation>[] = []
  for (const r of read.data.revocations) {
    const revocation = parseSliceRevocation(r, expected)
    if (!revocation.ok) return revocation
    revocations.push(revocation.value)
  }
  return { ok: true, value: { levels, revocations } }
}

declare const checked: unique symbol

/**
 * A worker's slices checked as one chain back to the agent's mandate, with each level's current
 * slice and hash and the hashes of the versions it replaced, newest first. Only
 * `sliceChainProblem` makes one, so whatever takes it, such as `checkSlicedMandate`, knows every
 * check below has passed.
 */
export interface SliceChain {
  readonly [checked]: true
  /** The agent's mandate chain the slices trace back to. */
  readonly mandates: MandateChain
  readonly levels: readonly { slice: Slice; hash: Hex; earlier: readonly Hex[] }[]
}

/**
 * Checks a worker's slices link, level by level, into the agent's mandate chain, and returns them
 * as a `SliceChain`, or the reason they don't.
 *
 * - Every version of every level names the mandate's business, account and agent, a mandate in
 *   the agent's checked chain, and the same id, parent, issuer and worker key as its level.
 * - The first level divides the mandate and was handed out by the agent's key. Each level after
 *   it divides the one above and was handed out by that level's worker key. No key holds two
 *   levels, and the last level's worker key is the one the caller expects.
 * - Each version after the first names the hash of the one before. A version the issuer signed
 *   only narrows the one it replaces, and a version the business account signed fits inside its
 *   parent's current limits.
 * - The issuer's key or the account signed every version. A key's signature is checked here, and
 *   the account's with `check`, which defaults to recovering a secp256k1 signer, so a caller
 *   whose account signs with a passkey passes its own, as Avow's API does with its chain reader.
 * - No revocation names a worker key on the way. A revocation counts when the account or the key
 *   of a level above the revoked one signed it, and one signed by anyone else is refused.
 *
 * Hashes are worked out here, never taken from whoever served the chain. It reads only what it's
 * handed, so it can't see a version or a revocation its server left out, and Avow, which holds
 * them, is the one that has to refuse a revoked key. Limits handed out are checked against their
 * parent by whoever takes a slice in, with `sliceWidensProblem`, and every level is held to its
 * parent's current limits when it's used, by `checkSlicedMandate`.
 */
export async function sliceChainProblem(
  served: WorkerSlices,
  expected: { domain: AvowDomain; mandates: MandateChain; subKey: Address },
  check?: SignatureCheck,
): Promise<{ ok: true; value: SliceChain } | { ok: false; reason: ReasonCode }> {
  const no = (reason: ReasonCode) => ({ ok: false, reason }) as const
  const { domain: d, mandates } = expected
  const mandate = mandates.current.proof.message
  const mandateHashes = [mandates.current.hash, ...mandates.earlier].map((h) => h.toLowerCase())
  if (served.levels.length === 0) return no('message.invalid')
  if (served.levels.length > MAX_SLICE_DEPTH) return no('slice.too_deep')
  const where = { chainId: d.chainId, lock: d.verifyingContract }

  const keys: Address[] = [mandate.agentKey]
  const levels: { slice: Slice; hash: Hex; earlier: Hex[] }[] = []
  let parentLimits: AuthorityLimits = mandate
  let parentId: Hex = zeroHash
  for (const level of served.levels) {
    const head = level.current.message
    const issuer = keys[keys.length - 1] as Address
    const versions = [level.current, ...level.earlier]
    for (const v of versions) {
      if (heldEnvelopeProblem(v, { type: 'Slice', ...where })) return no('message.invalid')
      const s = v.message
      const shape = sliceProblem(s)
      if (shape) return no(shape)
      if (
        s.businessId !== mandate.businessId ||
        !isAddressEqual(s.account, mandate.account) ||
        s.agentId !== mandate.agentId ||
        !mandateHashes.includes(s.mandateHash.toLowerCase()) ||
        s.sliceId.toLowerCase() !== head.sliceId.toLowerCase() ||
        s.parentSliceId.toLowerCase() !== parentId.toLowerCase() ||
        !isAddressEqual(s.issuerKey, issuer) ||
        !isAddressEqual(s.subKey, head.subKey)
      ) {
        return no('slice.chain_mismatch')
      }
    }
    if (keys.some((k) => isAddressEqual(k, head.subKey))) return no('slice.chain_mismatch')

    const hashes = versions.map((v) => sliceHash(v.message, d))
    for (let i = 0; i < versions.length; i++) {
      const v = versions[i] as Signed<Slice>
      const s = v.message
      const older = versions[i + 1]
      if (older === undefined) {
        if (s.replaces !== undefined) return no('slice.replaces_mismatch')
      } else if (s.replaces?.toLowerCase() !== hashes[i + 1]?.toLowerCase()) {
        return no('slice.replaces_mismatch')
      }
      const byIssuer = isAddressEqual(s.by, s.issuerKey)
      const typedData = sliceTypedData(s, d)
      const signed = byIssuer
        ? isKeySignature(digestOf(typedData), v.signature, s.issuerKey)
        : await isSignedBy(typedData, v.signature, s.account, check)
      if (!signed) return no('slice.signature_invalid')
      if (older !== undefined) {
        const bound = byIssuer ? older.message : parentLimits
        const widens = sliceWidensProblem(s, bound)
        if (widens) return no(widens)
      }
    }
    levels.push({ slice: head, hash: hashes[0] as Hex, earlier: hashes.slice(1) })
    keys.push(head.subKey)
    parentLimits = head
    parentId = head.sliceId
  }
  if (!isAddressEqual(keys[keys.length - 1] as Address, expected.subKey)) {
    return no('slice.key_mismatch')
  }

  for (const r of served.revocations) {
    if (heldEnvelopeProblem(r, { type: 'SliceRevocation', ...where })) return no('message.invalid')
    const m = r.message
    if (
      m.businessId !== mandate.businessId ||
      !isAddressEqual(m.account, mandate.account) ||
      m.agentId !== mandate.agentId
    ) {
      continue
    }
    // keys[0] is the agent's, so a worker key sits at 1 or deeper.
    const at = keys.findIndex((k, i) => i > 0 && isAddressEqual(k, m.subKey))
    if (at < 0) continue
    const byAccount = isAddressEqual(m.by, mandate.account)
    const byAbove = keys.slice(0, at).some((k) => isAddressEqual(k, m.by))
    if (!byAccount && !byAbove) return no('slice.signature_invalid')
    const typedData = sliceRevocationTypedData(m, d)
    const signed = byAccount
      ? await isSignedBy(typedData, r.signature, mandate.account, check)
      : isKeySignature(digestOf(typedData), r.signature, m.by)
    if (!signed) return no('slice.signature_invalid')
    return no('slice.revoked')
  }

  return { ok: true, value: { mandates, levels } as unknown as SliceChain }
}
