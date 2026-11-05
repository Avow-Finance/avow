import type {
  Acceptance,
  CheckedDependency,
  CommitmentRefusalLayer,
  HashSigner,
  PinnedBlock,
  QuoteRequest,
  ReasonCode,
  Signed,
  SupplierAuthorizationAnswer,
  TestCustomerProfile,
} from '@avow-finance/spec'
import {
  type AcceptanceConfig,
  acceptCall,
  type ChainReader,
  type DependencyDeps,
  prepareAcceptance,
  signAcceptance,
} from '@avow-finance/verifier'
import type { Address, Hex } from 'viem'
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
      acceptance: Signed<Acceptance>
      /** Each compute booking as the acceptance check read it again, with its block. */
      checks: readonly CheckedDependency[]
      acceptedIn: Landed
    }
  | {
      ok: false
      code: ReasonCode
      layer: CommitmentRefusalLayer
      block: PinnedBlock | null
      index: number | null
    }

/**
 * Checks the customer's commitment for a job and accepts it on the customer's lock. Avow's
 * authorization comes with the approval the customer's reserve was funded under and the customer's
 * mandate, and `prepareAcceptance` checks all three against the quote's terms and the lock, after
 * reading each compute booking the terms rely on again, with the owner taken from that approval.
 * Only then does the signing key sign the acceptance and send it.
 *
 * Each refusal names who made it. Avow declining to authorize is Avow's, a refusal by the checks is
 * the developer's own at the block the check read, and an acceptance the relay wouldn't pay for or
 * the lock reverted is theirs. A send whose outcome is unknown throws, since the acceptance may have
 * landed, and the caller reads the lock before acting again.
 */
export async function acceptJob(
  deps: JobAcceptanceDeps,
  job: { customer: TestCustomerProfile; quote: QuoteRequest },
): Promise<JobAcceptance> {
  const refuse = (
    code: ReasonCode,
    layer: CommitmentRefusalLayer,
    block: PinnedBlock | null = null,
    index: number | null = null,
  ): JobAcceptance => ({ ok: false, code, layer, block, index })
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
  const prepared = await prepareAcceptance(
    {
      authorization: answer.authorization,
      approval: answer.approval,
      mandate: answer.mandate,
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
      ? refuse(prepared.reason, 'supplier', prepared.block, prepared.index)
      : refuse(prepared.reason, 'supplier')
  }
  // The job process accepts on the developer's behalf, so it confirms the disclosure it was given.
  const acceptance = await signAcceptance(prepared, deps.signingKey, {
    disclosureId: prepared.disclosure.id,
  })
  let acceptedIn: Landed
  try {
    acceptedIn = await deps.send(acceptCall(acceptance))
  } catch (error) {
    const refused = acceptanceSendRefusal(error)
    if (refused) return refuse(refused.code, refused.layer)
    throw error
  }
  return { ok: true, acceptance, checks: prepared.dependencies, acceptedIn }
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
