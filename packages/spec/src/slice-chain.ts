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
  MAX_SLICE_DEPTH,
  parseSlice,
  parseSliceRevocation,
  type Slice,
  type SliceRevocation,
  sliceHash,
  sliceProblem,
  sliceReplacementProblem,
  sliceRevocationTypedData,
  sliceTypedData,
  sliceWidensProblem,
} from './slice.js'
import type { Mandate } from './types.js'
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
 * Why a revocation can't count against the worker key it names, or null when it counts: it names
 * the agent's business, account and agent, and the business account or the key of a level above
 * the revoked one signed it. `above` lists those keys, the agent's first. Avow checks a revocation
 * with this before it stores one, and `sliceChainProblem` passes over one that fails it, so a
 * revocation nobody entitled signed can't lock a worker or its siblings out.
 */
export async function sliceRevocationProblem(
  revocation: Signed<SliceRevocation>,
  expected: { domain: AvowDomain; mandate: Mandate; above: readonly Address[] },
  check?: SignatureCheck,
): Promise<ReasonCode | null> {
  const { domain: d, mandate } = expected
  const envelope = heldEnvelopeProblem(revocation, {
    type: 'SliceRevocation',
    chainId: d.chainId,
    lock: d.verifyingContract,
  })
  if (envelope) return envelope
  const m = revocation.message
  if (
    m.businessId !== mandate.businessId ||
    !isAddressEqual(m.account, mandate.account) ||
    m.agentId !== mandate.agentId
  ) {
    return 'message.invalid'
  }
  const byAccount = isAddressEqual(m.by, mandate.account)
  if (!byAccount && !expected.above.some((k) => isAddressEqual(k, m.by))) {
    return 'slice.signature_invalid'
  }
  const typedData = sliceRevocationTypedData(m, d)
  const signed = byAccount
    ? await isSignedBy(typedData, revocation.signature, mandate.account, check)
    : isKeySignature(digestOf(typedData), revocation.signature, m.by)
  return signed ? null : 'slice.signature_invalid'
}

/**
 * Checks a worker's slices link, level by level, into the agent's mandate chain, and returns them
 * as a `SliceChain`, or the reason they don't.
 *
 * - Every version of every level names the mandate's business, account and agent, a mandate in
 *   the agent's checked chain, and the same id, parent, issuer and worker key as its level. No id
 *   or key holds two levels, and the last level's worker key is the one the caller expects.
 * - The first level divides the mandate and was handed out by the agent's key. Each level after
 *   it divides the one above and was handed out by that level's worker key.
 * - A level's versions form one line. Its first version replaces none and fits inside its parent,
 *   the current mandate for a slice handed out under it, or any version of the slice above. Every
 *   version after it passes `sliceReplacementProblem` against the one before, and a version the
 *   account signed fits inside its parent the same way. A parent narrowed since locks no slice
 *   under it out, since `checkSlicedMandate` holds every level to its parent's current limits.
 * - The issuer's key or the account signed every version. A key's signature is checked here, and
 *   the account's with `check`, which defaults to recovering a secp256k1 signer, so a caller
 *   whose account signs with a passkey passes its own, as Avow's API does with its chain reader.
 * - No revocation that `sliceRevocationProblem` lets count names a worker key on the way. One
 *   that doesn't count is passed over.
 *
 * Hashes are worked out here, never taken from whoever served the chain. It reads only what it's
 * handed, so it can't see a version or a revocation its server left out. Avow holds them, so Avow
 * is what refuses a revoked key, and what takes a new version only when it replaces the current
 * one. A slice handed out under an earlier mandate in the chain is held to the current mandate
 * when it's used, by `checkSlicedMandate`, as every level is held to its parent's current limits.
 */
export async function sliceChainProblem(
  served: WorkerSlices,
  expected: { domain: AvowDomain; mandates: MandateChain; subKey: Address },
  check?: SignatureCheck,
): Promise<{ ok: true; value: SliceChain } | { ok: false; reason: ReasonCode }> {
  const no = (reason: ReasonCode) => ({ ok: false, reason }) as const
  const { domain: d, mandates } = expected
  const mandate = mandates.current.proof.message
  const currentMandate = mandates.current.hash.toLowerCase()
  const mandateHashes = [mandates.current.hash, ...mandates.earlier].map((h) => h.toLowerCase())
  if (served.levels.length === 0) return no('message.invalid')
  if (served.levels.length > MAX_SLICE_DEPTH) return no('slice.too_deep')
  const where = { chainId: d.chainId, lock: d.verifyingContract }

  const keys: Address[] = [mandate.agentKey]
  const ids = new Set<string>()
  const levels: { slice: Slice; hash: Hex; earlier: Hex[] }[] = []
  // The parent's versions, oldest first.
  let parentVersions: readonly Slice[] = []
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
    if (ids.has(head.sliceId.toLowerCase())) return no('slice.chain_mismatch')
    ids.add(head.sliceId.toLowerCase())

    const line = [...versions].reverse()
    const first = (line[0] as Signed<Slice>).message
    if (first.replaces !== undefined) return no('slice.replaces_mismatch')
    // What a version may fit inside: any version of the slice above, or the current mandate for
    // a version handed out under it. A version under an earlier mandate, or wider than a parent
    // narrowed since, is held to the parent's current limits when it's used, by
    // `checkSlicedMandate`, so narrowing a parent never locks the slices under it out.
    const insideParent = (v: Slice) =>
      parentVersions.length === 0
        ? v.mandateHash.toLowerCase() !== currentMandate || sliceWidensProblem(v, mandate) === null
        : parentVersions.some((p) => sliceWidensProblem(v, p) === null)
    if (!insideParent(first)) return no('slice.widens')
    for (let i = 1; i < line.length; i++) {
      const next = (line[i] as Signed<Slice>).message
      const current = (line[i - 1] as Signed<Slice>).message
      // The parent's bound is read by `insideParent` here, so the replacement check gets the
      // version itself as its bound, which holds an account-signed version to nothing more.
      const problem = sliceReplacementProblem(
        next,
        current,
        isAddressEqual(next.by, next.issuerKey) ? current : next,
        d,
      )
      if (problem) return no(problem)
      if (!isAddressEqual(next.by, next.issuerKey) && !insideParent(next)) return no('slice.widens')
    }
    for (const v of line) {
      const s = v.message
      const typedData = sliceTypedData(s, d)
      const signed = isAddressEqual(s.by, s.issuerKey)
        ? isKeySignature(digestOf(typedData), v.signature, s.issuerKey)
        : await isSignedBy(typedData, v.signature, s.account, check)
      if (!signed) return no('slice.signature_invalid')
    }
    const hashes = versions.map((v) => sliceHash(v.message, d))
    levels.push({ slice: head, hash: hashes[0] as Hex, earlier: hashes.slice(1) })
    keys.push(head.subKey)
    parentVersions = line.map((v) => v.message)
    parentId = head.sliceId
  }
  if (!isAddressEqual(keys[keys.length - 1] as Address, expected.subKey)) {
    return no('slice.key_mismatch')
  }

  for (const r of served.revocations) {
    // keys[0] is the agent's, so a worker key sits at 1 or deeper.
    const at = keys.findIndex((k, i) => i > 0 && isAddressEqual(k, r.message.subKey))
    if (at < 0) continue
    const counts = await sliceRevocationProblem(
      r,
      { domain: d, mandate, above: keys.slice(0, at) },
      check,
    )
    if (counts === null) return no('slice.revoked')
  }

  return { ok: true, value: { mandates, levels } as unknown as SliceChain }
}
