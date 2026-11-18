import {
  type Charge,
  type CommitmentReference,
  decodeCommitmentReference,
  describeReason,
  formatUsd,
  type RailState,
  type ReasonCode,
  toWire,
} from '@avow-finance/spec'
import { type ChainReader, findCommitment, tempoChainReader } from '@avow-finance/verifier'
import { type Address, isAddress, isAddressEqual } from 'viem'
import { moderatoClient } from '../moderato.js'
import { trustedFactory } from './deployment.js'
import { verifyUrl } from './session.js'

/**
 * Checking a commitment someone shared, such as a buyer's agent sending its link to a supplier's
 * agent. The link carries only where the backing sits and the terms hash, so the check reads the
 * rest from the lock, through the factory this SDK trusts, and never asks Avow. It needs no key and
 * no business, so an agent that has never connected to Avow can run it.
 */

/** What the lock holds for a shared commitment, in dollars and seconds. */
export interface SharedCommitment {
  standing: true
  reference: CommitmentReference
  link: string
  state: RailState
  /** The business account that owns the lock and funded the reserve. */
  business: Address
  /** What the business reserved, and what the lock still holds of it. */
  reserved: bigint
  held: bigint
  /** The supplier's account and the address the lock pays it at. */
  supplier: Address
  payee: Address
  /** Whether the lock pays the address the caller gave, or null when it gave none. */
  paysYou: boolean | null
  acceptBy: bigint
  freeCancelBy: bigint
  chargeDeadline: bigint
  releaseDate: bigint
  charges: readonly Charge[]
}

export type SharedCheck =
  | SharedCommitment
  | { standing: false; reason: ReasonCode; sentence: string; reference: CommitmentReference | null }

/** The token a link carries, from a whole `#verify=` link or the token alone. */
export function sharedToken(link: string): string {
  const at = link.indexOf('#verify=')
  return (at < 0 ? link : link.slice(at + '#verify='.length)).trim()
}

/** The chain reader for a chain this SDK trusts a factory on, or null for any other chain. */
function trustedReader(chainId: number): ChainReader | null {
  const factory = trustedFactory(chainId)
  return factory ? tempoChainReader(moderatoClient(), { factory, chainId }) : null
}

/**
 * Checks a shared commitment against the chain. It passes when the lock is one the trusted factory
 * created and holds that commitment under the link's terms hash, and then it says what the lock
 * holds, whatever state the commitment is in. With `payee` it also says whether the lock pays that
 * address, which is how a supplier's agent tells a commitment to it from one to someone else.
 */
export async function checkShared(
  input: { link: string; payee?: Address },
  deps: { chain?: (chainId: number) => ChainReader | null } = {},
): Promise<SharedCheck> {
  const refuse = (reason: ReasonCode, reference: CommitmentReference | null = null) => ({
    standing: false as const,
    reason,
    sentence: describeReason(reason),
    reference,
  })
  const decoded = decodeCommitmentReference(sharedToken(input.link))
  if (!decoded.ok) return refuse(decoded.reason)
  const reference = decoded.value
  const chain = (deps.chain ?? trustedReader)(reference.chainId)
  if (!chain) return refuse('message.wrong_chain', reference)
  const found = await findCommitment(reference, chain)
  if (!found.ok) return refuse(found.reason, reference)
  const { info, held } = found
  return {
    standing: true,
    reference,
    link: verifyUrl(reference),
    state: held.state,
    business: info.account,
    reserved: held.amount,
    held: held.held,
    supplier: held.supplier,
    payee: held.payee,
    paysYou: input.payee ? isAddressEqual(held.payee, input.payee) : null,
    acceptBy: held.acceptBy,
    freeCancelBy: held.freeCancelBy,
    chargeDeadline: held.chargeDeadline,
    releaseDate: held.releaseDate,
    charges: held.charges,
  }
}

/** Whether a string is an address, for a payee the caller typed. */
export const isPayee = (value: string): value is Address => isAddress(value)

const when = (seconds: bigint) => new Date(Number(seconds) * 1000).toISOString()

/** Where the commitment stands, as a supplier deciding whether to rely on it reads it. */
const STATE_WORDS: { readonly [S in RailState]: (c: SharedCommitment) => string } = {
  none: () => 'The lock holds nothing for it.',
  reserved: (c) =>
    `It's reserved and waiting for the supplier to accept it on the lock by ${when(c.acceptBy)}, after which the reserve goes back to the business.`,
  accepted: () => 'The supplier accepted it on the lock, so the reserve backs it until release.',
  charge_pending: () => 'The supplier reported a charge, which is pending.',
  paused: () => 'The supplier reported a charge, and the business contested it, so it is paused.',
  released: () => 'It ended, and the reserve went back to the business.',
  charged: () => 'It ended with a charge paid to the supplier.',
  resolved: () => 'It ended with a dispute ruled.',
}

/** The states a commitment ends in, with its reserve gone from the lock. */
const ENDED: readonly RailState[] = ['released', 'charged', 'resolved']

const CHARGE_WORDS = { lateCancellation: 'a late cancellation', noShow: 'a no-show' } as const

/** The check in sentences, for a model or a terminal to read. */
export function sharedSentences(c: SharedCheck): string[] {
  if (!c.standing) {
    return [
      `The chain doesn't back this commitment, with reason code ${c.reason}. ${c.sentence}.`,
      "Don't rely on it.",
    ]
  }
  const charges = c.charges.map(
    (k) => `up to ${formatUsd(k.most)} for ${CHARGE_WORDS[k.kind]} from ${when(k.earliest)}`,
  )
  return [
    `The lock ${c.reference.lock}, which Avow's factory created for business account ${c.business}, holds ${formatUsd(c.held)} of a ${formatUsd(c.reserved)} reserve for this commitment, under the link's terms hash.`,
    STATE_WORDS[c.state](c),
    `It names supplier account ${c.supplier} and pays ${c.payee}.`,
    ...(c.paysYou === false
      ? ["That isn't the address you gave, so this commitment isn't to you."]
      : []),
    ...(c.paysYou === true ? ['That is the address you gave.'] : []),
    // An ended commitment's deadlines no longer bind anyone, so only an open one lists them.
    ...(ENDED.includes(c.state)
      ? []
      : [
          `Free cancellation ends ${when(c.freeCancelBy)}${charges.length > 0 ? `, and after that the supplier can charge ${charges.join(' and ')}` : ''}. The reserve releases ${when(c.releaseDate)}.`,
        ]),
    "The lock shows the reserve and what it enforces. The terms themselves come from the buyer, and the link's terms hash is what ties them to this reserve. It's test dollars on Tempo's Moderato testnet.",
  ]
}

/** The check as plain JSON, with amounts in dollars and times in seconds. */
export function sharedJson(c: SharedCheck): Record<string, unknown> {
  if (!c.standing) {
    return {
      standing: false,
      code: c.reason,
      sentence: c.sentence,
      reference: c.reference ? toWire(c.reference) : null,
    }
  }
  const dollars = (micros: bigint) => Number(micros) / 1_000_000
  return {
    standing: true,
    state: c.state,
    reference: toWire(c.reference),
    link: c.link,
    business: c.business,
    reserved: dollars(c.reserved),
    held: dollars(c.held),
    supplier: c.supplier,
    payee: c.payee,
    paysYou: c.paysYou,
    acceptBy: Number(c.acceptBy),
    freeCancelBy: Number(c.freeCancelBy),
    chargeDeadline: Number(c.chargeDeadline),
    releaseDate: Number(c.releaseDate),
    charges: c.charges.map((k) => ({
      kind: k.kind,
      most: dollars(k.most),
      earliest: Number(k.earliest),
    })),
  }
}
