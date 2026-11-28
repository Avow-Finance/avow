import {
  type AuthorityLimits,
  type AvowDomain,
  digestOf,
  type Mandate,
  MESSAGE_VERSIONS,
  newRequestId,
  type RequestKey,
  type Signed,
  type Slice,
  type SliceRevocation,
  sliceHash,
  sliceProblem,
  sliceRevocationTypedData,
  sliceTypedData,
  sliceWidensProblem,
} from '@avow-finance/spec'
import { type Address, type Hex, zeroHash } from 'viem'

/** A slice the SDK won't sign, with the reason code that says why. */
export class SliceRefused extends Error {
  readonly code: 'slice.invalid' | 'slice.widens'
  constructor(code: 'slice.invalid' | 'slice.widens') {
    super(
      code === 'slice.widens'
        ? 'The slice would let the worker do something its parent can not, so it was not signed'
        : 'The slice is not well formed, so it was not signed',
    )
    this.name = 'SliceRefused'
    this.code = code
  }
}

const envelope = <T>(
  type: 'Slice' | 'SliceRevocation',
  message: T,
  d: AvowDomain,
  signature: Hex,
): Signed<T> => ({
  type,
  schemaVersion: MESSAGE_VERSIONS[type],
  chainId: d.chainId,
  lock: d.verifyingContract,
  message,
  signature,
})

/** The limits a slice carries, and nothing else, so a caller's extra fields never sign. */
function limitsOf(l: AuthorityLimits): AuthorityLimits {
  return {
    actions: [...l.actions],
    currency: l.currency,
    capPerCommitment: l.capPerCommitment,
    capOpenReserves: l.capOpenReserves,
    ...(l.priceCapPerCommitment === undefined
      ? {}
      : { priceCapPerCommitment: l.priceCapPerCommitment }),
    suppliers: [...l.suppliers],
    categories: [...l.categories],
    paymentLimits: l.paymentLimits.map((p) => ({ ...p })),
    approvalRule: { ...l.approvalRule },
    expiry: l.expiry,
  }
}

async function signSlice(issuer: RequestKey, s: Slice, d: AvowDomain): Promise<Signed<Slice>> {
  const shape = sliceProblem(s)
  if (shape) throw new SliceRefused('slice.invalid')
  const signature = await issuer.signDigest(digestOf(sliceTypedData(s, d)))
  return envelope('Slice', s, d, signature)
}

/**
 * Hands a slice to a worker's key, signed by the key handing it out: the agent's own key for a
 * slice of its mandate, or a worker's key for a slice of its own slice. It refuses limits that
 * would let the worker do anything the parent can't, so the SDK never signs a slice that widens.
 */
export async function handOutSlice(a: {
  issuer: RequestKey
  domain: AvowDomain
  /** The agent's current mandate and its hash, which the slice traces back to. */
  mandate: { message: Mandate; hash: Hex }
  /** The slice the worker's slice divides, or null for a slice of the mandate itself. */
  parent: Slice | null
  subKey: Address
  limits: AuthorityLimits
}): Promise<Signed<Slice>> {
  const parentLimits: AuthorityLimits = a.parent ?? a.mandate.message
  if (sliceWidensProblem(a.limits, parentLimits)) throw new SliceRefused('slice.widens')
  const m = a.mandate.message
  const s: Slice = {
    sliceId: newRequestId(),
    businessId: m.businessId,
    account: m.account,
    agentId: m.agentId,
    mandateHash: a.mandate.hash,
    parentSliceId: a.parent?.sliceId ?? zeroHash,
    issuerKey: a.issuer.address,
    subKey: a.subKey,
    by: a.issuer.address,
    ...limitsOf(a.limits),
    nonce: 1n,
  }
  return signSlice(a.issuer, s, a.domain)
}

/**
 * The next version of a slice the issuer handed out, with narrower limits. It refuses limits wider
 * than the slice's current ones in any way, so a worker's authority only ever shrinks this way.
 * Only the administrator, from the console, can widen a slice, and only inside its parent.
 */
export async function narrowSlice(a: {
  issuer: RequestKey
  domain: AvowDomain
  current: Slice
  limits: AuthorityLimits
}): Promise<Signed<Slice>> {
  if (sliceWidensProblem(a.limits, a.current)) throw new SliceRefused('slice.widens')
  const { priceCapPerCommitment: _price, replaces: _replaces, ...kept } = a.current
  const s: Slice = {
    ...kept,
    ...limitsOf(a.limits),
    by: a.issuer.address,
    nonce: a.current.nonce + 1n,
    replaces: sliceHash(a.current, a.domain),
  }
  return signSlice(a.issuer, s, a.domain)
}

/**
 * Ends a worker's key, its slices and every slice below it, for good. The agent's key or the key
 * of any worker above signs it.
 */
export async function revokeWorker(a: {
  by: RequestKey
  domain: AvowDomain
  mandate: Mandate
  subKey: Address
}): Promise<Signed<SliceRevocation>> {
  const r: SliceRevocation = {
    businessId: a.mandate.businessId,
    account: a.mandate.account,
    agentId: a.mandate.agentId,
    subKey: a.subKey,
    by: a.by.address,
  }
  const signature = await a.by.signDigest(digestOf(sliceRevocationTypedData(r, a.domain)))
  return envelope('SliceRevocation', r, a.domain, signature)
}
