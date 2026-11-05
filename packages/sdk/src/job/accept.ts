import {
  type Acceptance,
  type CheckedDependency,
  type CommitmentRefusalLayer,
  type HashSigner,
  isChainedTerms,
  type PinnedBlock,
  type QuoteRequest,
  type ReasonCode,
  type Signed,
  type SupplierAuthorizationAnswer,
  type TestCustomerProfile,
  toWire,
} from '@avow-finance/spec'
import {
  type AcceptanceConfig,
  acceptCall,
  type ChainReader,
  type DependencyDeps,
  prepareAcceptance,
  signAcceptance,
  verifyDependencies,
} from '@avow-finance/verifier'
import { type Address, type Hex, isAddressEqual } from 'viem'
import type { Landed } from '../agent.js'
import { AvowApiError, relayReason } from '../http.js'
import { landedReverted, SendError } from '../send.js'

/** What accepting a job's commitment needs, which the job process wires once. */
export interface JobAcceptanceDeps {
  /** The verifier's settings, with the supplier's account, signing key and Avow's keys. */
  config: AcceptanceConfig
  chain: ChainReader
  /** The readers of the locks the business's compute bookings sit in. */
  dependencies: DependencyDeps
  /**
   * Asks Avow for a fresh authorization for a commitment, signed with the signing key, as
   * `requestSupplierAuthorization` does. A definite refusal throws an `AvowApiError`.
   */
  authorize: (c: {
    chainId: number
    lock: Address
    commitmentId: Hex
  }) => Promise<SupplierAuthorizationAnswer>
  /** The supplier's signing key, which signs the acceptance. */
  signingKey: HashSigner
  /**
   * Sends the acceptance's call and resolves once it lands, as `sendOwn` does from the signing
   * key, which pays its own fee. It throws a `SendError` when the call reverts or its outcome is
   * unknown, and a sender that goes through Avow's relay throws one carrying the relay's refusal.
   */
  send: (call: { to: Address; data: Hex }) => Promise<Landed>
  now: () => bigint
}

/** A job's commitment accepted, or why the developer's side refused it. */
export type JobAcceptance =
  | {
      ok: true
      /**
       * The acceptance this call signed, the disclosure the job process confirmed before signing
       * it, and the transaction it landed in. Null when the customer's lock already showed the
       * commitment accepted under the supplier's signing key, as when an earlier call's acceptance
       * landed after its send gave no answer.
       */
      sent: { acceptance: Signed<Acceptance>; disclosureId: Hex; landed: Landed } | null
      /** Each compute booking as this call read it again, with its block. */
      checks: readonly CheckedDependency[]
    }
  | {
      ok: false
      code: ReasonCode
      layer: CommitmentRefusalLayer
      block: PinnedBlock | null
      index: number | null
    }

type Refused = Extract<JobAcceptance, { ok: false }>

/**
 * The refusals that can mean the lock already holds an acceptance, Avow's or the verifier's for a
 * reserve already accepted, and the lock's revert of a second one.
 */
const MAY_BE_ACCEPTED: readonly ReasonCode[] = [
  'chain.reserve_accepted',
  'chain.acceptance_reverted',
]

/**
 * Checks the customer's commitment for a job and accepts it on the customer's lock. Avow's
 * authorization comes with the approval the customer's reserve was funded under and the customer's
 * mandate, and `prepareAcceptance` checks all three against the quote's terms and the lock, after
 * reading each compute booking the terms rely on again, with the owner taken from that approval.
 * Only then does the signing key sign the acceptance and send it.
 *
 * Each refusal names who made it. Avow declining to authorize is Avow's, a refusal by the checks is
 * the developer's service's at the block the check read, and an acceptance the relay wouldn't pay
 * for or the lock reverted is theirs. A send whose outcome is unknown throws, since the acceptance
 * may have landed, and calling this again then is safe. A refusal that says the reserve is already
 * accepted reads the lock, and a commitment it shows accepted under this supplier's account and
 * signing key, for the quote's terms, counts as accepted, since only that key can accept it.
 */
export async function acceptJob(
  deps: JobAcceptanceDeps,
  job: { customer: TestCustomerProfile; quote: QuoteRequest },
): Promise<JobAcceptance> {
  const outcome = await signAndSend(deps, job)
  if (outcome.ok || !MAY_BE_ACCEPTED.includes(outcome.code)) return outcome
  return (await acceptedEarlier(deps, job)) ?? outcome
}

async function signAndSend(
  deps: JobAcceptanceDeps,
  job: { customer: TestCustomerProfile; quote: QuoteRequest },
): Promise<JobAcceptance> {
  const refuse = (
    code: ReasonCode,
    layer: CommitmentRefusalLayer,
    block: PinnedBlock | null = null,
    index: number | null = null,
  ): Refused => ({ ok: false, code, layer, block, index })
  const { customer, quote } = job
  const a = quote.agreement
  let answer: SupplierAuthorizationAnswer
  try {
    answer = await deps.authorize({
      chainId: customer.chainId,
      lock: customer.lock,
      commitmentId: a.commitmentId,
    })
  } catch (error) {
    if (error instanceof AvowApiError && error.definite && error.reason) {
      return refuse(error.reason, 'avow')
    }
    throw error
  }
  if (!answer.ok) return refuse(answer.reason, 'avow')
  // The verifier reads Avow's messages as they travel, in JSON.
  const prepared = await prepareAcceptance(
    {
      authorization: toWire(answer.authorization),
      approval: toWire(answer.approval),
      mandate: toWire(answer.mandate),
      agreed: {
        commitmentId: a.commitmentId,
        termsHash: a.termsHash,
        category: a.category,
        buyerBusinessId: a.buyerBusinessId,
        mandateHash: a.mandateHash,
      },
      terms: quote.terms,
      disclosed: quote.disclosed,
      now: deps.now(),
    },
    { config: deps.config, chain: deps.chain, dependencies: deps.dependencies },
  )
  if (!prepared.ok) {
    return 'block' in prepared
      ? refuse(prepared.reason, 'service', prepared.block, prepared.index)
      : refuse(prepared.reason, 'service')
  }
  // The job process accepts on the developer's behalf, so it confirms the disclosure it was given.
  const disclosureId = prepared.disclosure.id
  const acceptance = await signAcceptance(prepared, deps.signingKey, { disclosureId })
  let landed: Landed
  try {
    landed = await deps.send(acceptCall(acceptance))
  } catch (error) {
    const refused = acceptanceSendRefusal(error)
    if (refused) return refuse(refused.code, refused.layer)
    throw error
  }
  return { ok: true, sent: { acceptance, disclosureId, landed }, checks: prepared.dependencies }
}

/**
 * The commitment accepted by an earlier call, with each compute booking read again, or null when
 * the customer's lock doesn't show it accepted under this supplier's account and signing key for
 * the quote's terms. The lock takes an acceptance only from the signing key Avow's approval named,
 * so one it shows under this signing key came from this supplier. Throws when a booking no longer
 * stands, since the commitment can't be refused once it's accepted.
 */
async function acceptedEarlier(
  deps: JobAcceptanceDeps,
  job: { customer: TestCustomerProfile; quote: QuoteRequest },
): Promise<JobAcceptance | null> {
  const { customer, quote } = job
  const a = quote.agreement
  if (!isChainedTerms(quote.terms)) return null
  const held = await deps.chain.backing(customer.lock, a.commitmentId, 'buyer')
  if (
    held?.state !== 'accepted' ||
    !isAddressEqual(held.supplierSigner, deps.config.signingKey) ||
    !isAddressEqual(held.supplier, deps.config.account) ||
    held.termsHash.toLowerCase() !== a.termsHash.toLowerCase()
  ) {
    return null
  }
  const relied = await verifyDependencies(
    {
      terms: quote.terms,
      approval: { side: 'buyer', supplier: held.supplier },
      disclosed: quote.disclosed,
      now: deps.now(),
    },
    deps.dependencies,
  )
  if (!relied.ok) {
    const at = relied.block ? ` at block ${relied.block.number}` : ''
    throw new Error(
      `The customer's lock shows commitment ${a.commitmentId} accepted under your signing key, but the compute booking it relies on doesn't stand${at} (${relied.reason}).`,
    )
  }
  return { ok: true, sent: null, checks: relied.checked }
}

/**
 * Who refused an acceptance on its way to the customer's lock, read from the error its send threw.
 * A transaction that landed and reverted is the lock's refusal, and a relay that wouldn't pay its fee
 * gave its reason. Anything else is null, since the acceptance may still have landed.
 */
export function acceptanceSendRefusal(
  error: unknown,
): { code: ReasonCode; layer: 'relay' | 'lock' } | null {
  if (!(error instanceof SendError) || error.outcome !== 'failed') return null
  if (landedReverted(error)) return { code: 'chain.acceptance_reverted', layer: 'lock' }
  const relay = relayReason(error)
  return relay ? { code: relay, layer: 'relay' } : null
}
