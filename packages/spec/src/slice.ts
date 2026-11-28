import { type Address, type Hex, hashTypedData, isAddressEqual, zeroHash } from 'viem'
import { z } from 'zod'
import { type AvowDomain, domain, type Signed } from './eip712.js'
import { address, bytes32, u64, u256 } from './json-fields.js'
import type { ReasonCode } from './reasons.js'
import {
  type ApprovalRule,
  CURRENCIES,
  type Currency,
  MANDATE_ACTIONS,
  type Mandate,
  type MandateAction,
  type MandateFields,
  type PaymentLimit,
} from './types.js'
import { MESSAGE_VERSIONS } from './version.js'
import { type Parsed, parseSigned } from './wire.js'

/**
 * A slice is a narrower part of an agent's authority that the agent hands to an agent it starts,
 * so an agent that runs many workers doesn't need a person to sign for each one. The agent's key
 * signs a slice for a worker's own key, and a worker can hand a slice of its slice to a worker of
 * its own, up to `MAX_SLICE_DEPTH` levels below the mandate a person signed.
 *
 * The worker's key goes on no keychain. It signs the worker's requests to Avow and nothing on the
 * chain, so the agent's key stays the only key that funds a reserve, and the lock and the keychain
 * still hold every worker together to the mandate a person signed. A slice's own limits are held
 * by the SDK and Avow's API only, which run `checkSlicedMandate` on every level from the mandate
 * down to the worker's slice.
 *
 * A slice is checked against what it divides when it's handed out, and `sliceWidensProblem` refuses
 * one that would let the worker do anything its parent can't. A slice names the signed mandate it
 * was handed out under and the slice it divides by id, so the slices under it keep working when
 * it's narrowed, and every level is checked against its parent's current limits each time it's
 * used.
 *
 * The key that handed a slice out may replace it with a narrower one, and the business account may
 * replace it with any slice that fits inside its parent. `by` says which of the two signed it.
 */
export interface Slice {
  /** The slice's id, which every version of it keeps. */
  sliceId: Hex
  businessId: string
  /** The business account, which can sign a slice in place of the key that handed it out. */
  account: Address
  /** The agent whose mandate the slice traces back to, as the mandate names it. */
  agentId: string
  /** The hash of the mandate a person signed that the slice was handed out under. */
  mandateHash: Hex
  /** The id of the slice this one divides, or the zero hash when it divides the agent's mandate. */
  parentSliceId: Hex
  /** The key that hands the slice out: the agent's key, or the key of the worker that divides its own. */
  issuerKey: Address
  /** The worker's own key, which signs its requests to Avow and never anything on the chain. */
  subKey: Address
  /** Who signed this version: `issuerKey`, or `account` for the administrator. */
  by: Address
  actions: readonly MandateAction[]
  currency: Currency
  capPerCommitment: bigint
  capOpenReserves: bigint
  /**
   * The most one commitment's price may come to, in micros, read as the mandate's price limit is.
   * Left out for no limit of its own, which only a slice of a mandate or slice with none may do.
   */
  priceCapPerCommitment?: bigint
  /** Business ids of the suppliers the worker may commit to, as a mandate names them. */
  suppliers: readonly string[]
  categories: readonly string[]
  /**
   * The most the worker and every worker below it may have approved within each period, in the
   * token's base units. `checkSlicedMandate` totals the reserves approved under the slice within
   * the period, as Avow and the agent's signer count them, and refuses one that would pass it. The
   * keychain holds the agent's key to the mandate's own limit for every worker together.
   */
  paymentLimits: readonly PaymentLimit[]
  approvalRule: ApprovalRule
  expiry: bigint
  nonce: bigint
  /** The hash of the version this one replaces, left out for a slice's first version. */
  replaces?: Hex
}

/** The most levels of slices below a mandate a person signed. */
export const MAX_SLICE_DEPTH = 4

/** The limits a mandate and a slice both carry, which a slice may only narrow. */
export type AuthorityLimits = Pick<
  MandateFields,
  | 'actions'
  | 'currency'
  | 'capPerCommitment'
  | 'capOpenReserves'
  | 'priceCapPerCommitment'
  | 'suppliers'
  | 'categories'
  | 'paymentLimits'
  | 'approvalRule'
  | 'expiry'
>

export const SLICE_TYPES = {
  PaymentLimit: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'period', type: 'uint64' },
  ],
  Slice: [
    { name: 'sliceId', type: 'bytes32' },
    { name: 'businessId', type: 'string' },
    { name: 'account', type: 'address' },
    { name: 'agentId', type: 'string' },
    { name: 'mandateHash', type: 'bytes32' },
    { name: 'parentSliceId', type: 'bytes32' },
    { name: 'issuerKey', type: 'address' },
    { name: 'subKey', type: 'address' },
    { name: 'by', type: 'address' },
    { name: 'actions', type: 'string[]' },
    { name: 'currency', type: 'string' },
    { name: 'capPerCommitment', type: 'uint256' },
    { name: 'capOpenReserves', type: 'uint256' },
    { name: 'priceCapPerCommitment', type: 'uint256' },
    { name: 'suppliers', type: 'string[]' },
    { name: 'categories', type: 'string[]' },
    { name: 'paymentLimits', type: 'PaymentLimit[]' },
    { name: 'approvalRule', type: 'uint8' },
    { name: 'approvalAbove', type: 'uint256' },
    { name: 'expiry', type: 'uint64' },
    { name: 'nonce', type: 'uint256' },
    { name: 'replaces', type: 'bytes32' },
  ],
} as const

const RULE_CODES = { never: 0, above: 1, always: 2 } as const

/**
 * A slice's EIP-712 typed data, under the business's lock. A slice with no price limit of its own
 * signs zero for it, and a first version signs the zero hash as the one it replaces. Neither zero
 * is a value a slice can hold, which `sliceProblem` checks.
 */
export function sliceTypedData(s: Slice, d: AvowDomain) {
  return {
    domain: domain(d, MESSAGE_VERSIONS.Slice),
    types: SLICE_TYPES,
    primaryType: 'Slice' as const,
    message: {
      sliceId: s.sliceId,
      businessId: s.businessId,
      account: s.account,
      agentId: s.agentId,
      mandateHash: s.mandateHash,
      parentSliceId: s.parentSliceId,
      issuerKey: s.issuerKey,
      subKey: s.subKey,
      by: s.by,
      actions: [...s.actions],
      currency: s.currency,
      capPerCommitment: s.capPerCommitment,
      capOpenReserves: s.capOpenReserves,
      priceCapPerCommitment: s.priceCapPerCommitment ?? 0n,
      suppliers: [...s.suppliers],
      categories: [...s.categories],
      paymentLimits: s.paymentLimits.map((l) => ({
        token: l.token,
        amount: l.amount,
        period: l.period,
      })),
      approvalRule: RULE_CODES[s.approvalRule.kind],
      approvalAbove: s.approvalRule.kind === 'above' ? s.approvalRule.amount : 0n,
      expiry: s.expiry,
      nonce: s.nonce,
      replaces: s.replaces ?? zeroHash,
    },
  }
}

/** A slice's hash under the business's lock, which its signer signs and its next version names. */
export function sliceHash(s: Slice, d: AvowDomain): Hex {
  return hashTypedData(sliceTypedData(s, d))
}

/**
 * Checks a slice on its own, and gives `slice.invalid` for one that isn't well formed. Its limits
 * follow a mandate's rules, it names a worker's key that is neither the key handing it out nor the
 * account, it's signed by one of those two, and it holds no zero where the signed form writes zero
 * for a value left out.
 */
export function sliceProblem(s: Slice): ReasonCode | null {
  const bad = 'slice.invalid' as const
  if (s.sliceId.toLowerCase() === zeroHash) return bad
  if (s.mandateHash.toLowerCase() === zeroHash) return bad
  if (s.replaces !== undefined && s.replaces.toLowerCase() === zeroHash) return bad
  if (s.businessId.length === 0 || s.agentId.length === 0) return bad
  if (isAddressEqual(s.subKey, s.issuerKey) || isAddressEqual(s.subKey, s.account)) return bad
  if (!isAddressEqual(s.by, s.issuerKey) && !isAddressEqual(s.by, s.account)) return bad
  if (s.suppliers.length === 0 && s.categories.length === 0) return bad
  if (s.actions.length === 0) return bad
  if (s.capPerCommitment <= 0n || s.capPerCommitment > s.capOpenReserves) return bad
  if (s.priceCapPerCommitment !== undefined && s.priceCapPerCommitment <= 0n) return bad
  if (s.paymentLimits.length === 0 || s.paymentLimits.some((l) => l.amount <= 0n)) return bad
  if (new Set(s.paymentLimits.map((l) => l.token.toLowerCase())).size !== s.paymentLimits.length) {
    return bad
  }
  if (s.approvalRule.kind === 'above' && s.approvalRule.amount < 0n) return bad
  return null
}

/** How much an approval rule leaves to the agent, from a rule that leaves most to one that leaves least. */
const ruleRank = (r: ApprovalRule) => RULE_CODES[r.kind]

/**
 * A list a child narrows: when the parent's list names anything, the child's has to name something
 * and only what the parent's names, since an empty list means any.
 */
const listNarrows = (child: readonly string[], parent: readonly string[]) =>
  parent.length === 0 || (child.length > 0 && child.every((c) => parent.includes(c)))

/**
 * Whether limits would let an agent do anything the limits they divide don't, and `slice.widens`
 * when they would. A slice is handed out and narrowed under this rule: every action, supplier and
 * category it names is its parent's, no cap, price limit or payment limit is larger, a price limit
 * stays when the parent has one, a payment limit keeps its token and period, its approval rule
 * leaves no more to the agent, and it ends no later.
 */
export function sliceWidensProblem(
  child: AuthorityLimits,
  parent: AuthorityLimits,
): 'slice.widens' | null {
  const widens = 'slice.widens' as const
  if (child.currency !== parent.currency) return widens
  if (!child.actions.every((a) => parent.actions.includes(a))) return widens
  if (!listNarrows(child.suppliers, parent.suppliers)) return widens
  if (!listNarrows(child.categories, parent.categories)) return widens
  if (child.capPerCommitment > parent.capPerCommitment) return widens
  if (child.capOpenReserves > parent.capOpenReserves) return widens
  if (parent.priceCapPerCommitment !== undefined) {
    if (child.priceCapPerCommitment === undefined) return widens
    if (child.priceCapPerCommitment > parent.priceCapPerCommitment) return widens
  }
  for (const limit of child.paymentLimits) {
    const theirs = parent.paymentLimits.find((p) => isAddressEqual(p.token, limit.token))
    if (!theirs || theirs.period !== limit.period || limit.amount > theirs.amount) return widens
  }
  if (ruleRank(child.approvalRule) < ruleRank(parent.approvalRule)) return widens
  if (
    child.approvalRule.kind === 'above' &&
    parent.approvalRule.kind === 'above' &&
    child.approvalRule.amount > parent.approvalRule.amount
  ) {
    return widens
  }
  if (child.expiry > parent.expiry) return widens
  return null
}

/**
 * Why `next` can't replace `current` as the next version of the same slice, or null when it can.
 * It names `current` by its hash and carries the next nonce, it keeps the slice's id, business,
 * account, agent, parent, issuer and worker key, and it widens nothing it may not: a version the
 * issuer signed only narrows `current`, and one the business account signed fits inside
 * `parentLimits`, its parent's current limits.
 *
 * Whoever holds slices takes a new version only when it replaces the one held as current, as Avow
 * takes a mandate only when it replaces the agent's current one. So an issuer can never sign past
 * an administrator's narrowing by replacing an older version, and the versions of a slice always
 * form one line. `sliceChainProblem` runs this on every version it's served.
 */
export function sliceReplacementProblem(
  next: Slice,
  current: Slice,
  parentLimits: AuthorityLimits,
  d: AvowDomain,
): ReasonCode | null {
  if (next.replaces?.toLowerCase() !== sliceHash(current, d).toLowerCase()) {
    return 'slice.replaces_mismatch'
  }
  if (next.nonce !== current.nonce + 1n) return 'slice.replaces_mismatch'
  if (
    next.sliceId.toLowerCase() !== current.sliceId.toLowerCase() ||
    next.businessId !== current.businessId ||
    !isAddressEqual(next.account, current.account) ||
    next.agentId !== current.agentId ||
    next.parentSliceId.toLowerCase() !== current.parentSliceId.toLowerCase() ||
    !isAddressEqual(next.issuerKey, current.issuerKey) ||
    !isAddressEqual(next.subKey, current.subKey)
  ) {
    return 'slice.replaces_mismatch'
  }
  return sliceWidensProblem(next, isAddressEqual(next.by, next.issuerKey) ? current : parentLimits)
}

/**
 * A slice read as a mandate with the slice's limits, for the mandate check to run on its level. It
 * keeps the agent's key, since the agent's key funds every reserve a worker makes, and the slice's
 * id stands as the mandate's.
 */
export function sliceAsMandate(mandate: Mandate, s: Slice): Mandate {
  const { replaces: _replaces, priceCapPerCommitment: _price, ...fields } = mandate
  return {
    ...fields,
    mandateId: s.sliceId,
    actions: s.actions,
    currency: s.currency,
    capPerCommitment: s.capPerCommitment,
    capOpenReserves: s.capOpenReserves,
    ...(s.priceCapPerCommitment === undefined
      ? {}
      : { priceCapPerCommitment: s.priceCapPerCommitment }),
    suppliers: s.suppliers,
    categories: s.categories,
    paymentLimits: s.paymentLimits,
    approvalRule: s.approvalRule,
    expiry: s.expiry,
    nonce: s.nonce,
  }
}

const approvalRuleJson = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('never') }),
  z.strictObject({ kind: z.literal('always') }),
  z.strictObject({ kind: z.literal('above'), amount: u256 }),
])

/** A slice as JSON. `sliceProblem` holds the rules beyond its form. */
export const sliceJson = z.strictObject({
  sliceId: bytes32,
  businessId: z.string().min(1),
  account: address,
  agentId: z.string().min(1),
  mandateHash: bytes32,
  parentSliceId: bytes32,
  issuerKey: address,
  subKey: address,
  by: address,
  actions: z.array(z.enum(MANDATE_ACTIONS)).min(1),
  currency: z.enum(CURRENCIES),
  capPerCommitment: u256,
  capOpenReserves: u256,
  priceCapPerCommitment: u256.exactOptional(),
  suppliers: z.array(z.string().min(1)),
  categories: z.array(z.string().min(1)),
  paymentLimits: z.array(z.strictObject({ token: address, amount: u256, period: u64 })).min(1),
  approvalRule: approvalRuleJson,
  expiry: u64,
  nonce: u256,
  replaces: bytes32.exactOptional(),
})

/**
 * Reads a signed slice from JSON and checks its envelope and its form. Its signature is checked
 * with the rest of its chain, by `sliceChainProblem`.
 */
export function parseSlice(
  json: unknown,
  expected: { chainId: number; lock?: Address },
): Parsed<Signed<Slice>> {
  const signed = parseSigned(json, 'Slice', sliceJson, expected)
  if (!signed.ok) return signed
  const problem = sliceProblem(signed.value.message)
  return problem ? { ok: false, reason: problem } : signed
}

/**
 * The word that a worker's key holds no slice again, signed by the business account or by the key
 * of any level above the worker. It names the key, so it ends every slice the key holds and every
 * slice handed out below it, and a revoked key is given none again. A worker starts again under a
 * new key. It carries no time and never expires.
 */
export interface SliceRevocation {
  businessId: string
  account: Address
  agentId: string
  /** The worker's key that loses its slices. */
  subKey: Address
  /** Who signed it: the business account, the agent's key, or the key of a worker above. */
  by: Address
}

export const SLICE_REVOCATION_TYPES = {
  SliceRevocation: [
    { name: 'businessId', type: 'string' },
    { name: 'account', type: 'address' },
    { name: 'agentId', type: 'string' },
    { name: 'subKey', type: 'address' },
    { name: 'by', type: 'address' },
  ],
} as const

/** A revocation's EIP-712 typed data, under the business's lock. */
export function sliceRevocationTypedData(r: SliceRevocation, d: AvowDomain) {
  return {
    domain: domain(d, MESSAGE_VERSIONS.SliceRevocation),
    types: SLICE_REVOCATION_TYPES,
    primaryType: 'SliceRevocation' as const,
    message: {
      businessId: r.businessId,
      account: r.account,
      agentId: r.agentId,
      subKey: r.subKey,
      by: r.by,
    },
  }
}

export function sliceRevocationHash(r: SliceRevocation, d: AvowDomain): Hex {
  return hashTypedData(sliceRevocationTypedData(r, d))
}

export const sliceRevocationJson = z.strictObject({
  businessId: z.string().min(1),
  account: address,
  agentId: z.string().min(1),
  subKey: address,
  by: address,
})

/** Reads a signed revocation from JSON and checks its envelope. Its signer is checked by its reader. */
export function parseSliceRevocation(
  json: unknown,
  expected: { chainId: number; lock?: Address },
): Parsed<Signed<SliceRevocation>> {
  return parseSigned(json, 'SliceRevocation', sliceRevocationJson, expected)
}
