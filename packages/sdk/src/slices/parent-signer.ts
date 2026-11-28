import {
  type AvowDomain,
  approvalCaps,
  approvalMandateProblem,
  approvalTermsProblem,
  approvalTokenProblem,
  checkEnvelope,
  checkSlicedMandate,
  digestOf,
  lockTerms,
  type MandateChain,
  type RailToken,
  type ReasonCode,
  type ReserveRequest,
  type SignatureCheck,
  type SliceChain,
  sliceChainProblem,
  type Terms,
  type TermsProfile,
  termsAgreementTypedData,
  termsHash,
  type WorkerSlices,
} from '@avow-finance/spec'
import { type Address, type Hex, isAddressEqual } from 'viem'
import type { Landed } from '../agent.js'
import { type Call, reserveCalls } from '../lock.js'
import {
  isWorkerRequestSigned,
  WORKER_REQUEST_MAX_VALIDITY,
  type WorkerAnswer,
  type WorkerRequest,
} from './worker-request.js'

/** The agent's key, as far as the signer uses it: its address and its bare signature. */
export interface ParentKey {
  /** The key's own address, which the mandate names and every approval names as the funder. */
  readonly accessKeyAddress: Address
  sign(args: { hash: Hex; raw: true }): Promise<Hex>
}

export interface ParentSignerDeps {
  key: ParentKey
  domain: AvowDomain
  token: RailToken
  profile: TermsProfile
  now: () => bigint
  /** The agent's mandate chain, as the agent last checked it with `mandateChainProblem`. */
  mandates: () => Promise<MandateChain>
  /** A worker's slices as Avow serves them now, or null when Avow holds none for the key. */
  workerSlices: (subKey: Address) => Promise<WorkerSlices | null>
  /**
   * What a worker's chain holds, as Avow counts it from approved reserves: what is open under the
   * agent's mandate and under each level, and what each level had approved within the period of
   * its payment limit for the lock's token, in base units, top first.
   */
  holdings: (chain: SliceChain) => Promise<{
    openReserves: { mandate: bigint; slices: readonly bigint[] }
    approvedWithin: readonly bigint[]
  }>
  /** Whether the business account signed a digest, for a slice the administrator changed. */
  isAccountSignature?: SignatureCheck
  /** Sends the transaction that funds a reserve with the agent's key. */
  send: (calls: Call[]) => Promise<Landed>
}

interface Agreed {
  subKey: Address
  request: Omit<ReserveRequest, 'terms'> & { terms: Terms }
  termsHash: Hex
  expiry: bigint
}

/**
 * What the agent's process runs so its workers can make commitments without ever holding its key.
 * It signs two things with the agent's key, and each only for a worker whose key signed the ask
 * and holds a live slice, read from Avow and checked back to the agent's mandate each time.
 *
 * - The buyer's side of a terms agreement, once `checkSlicedMandate` lets the booking through
 *   every level from the mandate down to the worker's slice.
 * - The transaction that funds a reserve, for an agreement it signed for that same worker, once
 *   Avow's approval names exactly those terms, the agent's mandate and the agent's key, and the
 *   slices still let it through.
 *
 * It refuses anything else before signing. Avow's API runs the same check before it approves, and
 * the lock and the keychain hold every worker together to the mandate a person signed.
 */
export function createParentSigner(deps: ParentSignerDeps) {
  const { key, domain: d, token } = deps
  const seen = new Map<string, bigint>()
  const agreed = new Map<string, Agreed>()

  const forget = (now: bigint) => {
    for (const [id, until] of seen) if (until < now) seen.delete(id)
    for (const [id, a] of agreed) if (a.expiry < now) agreed.delete(id)
  }

  async function liveChain(
    subKey: Address,
    mandates: MandateChain,
  ): Promise<{ ok: true; chain: SliceChain } | { ok: false; reason: ReasonCode }> {
    const served = await deps.workerSlices(subKey)
    if (!served) return { ok: false, reason: 'slice.key_mismatch' }
    const read = await sliceChainProblem(
      served,
      { domain: d, mandates, subKey },
      deps.isAccountSignature,
    )
    return read.ok ? { ok: true, chain: read.value } : read
  }

  async function sliceCheck(
    chain: SliceChain,
    request: Omit<ReserveRequest, 'terms'> & { terms: Terms },
  ): Promise<ReasonCode | null> {
    const held = await deps.holdings(chain)
    const check = checkSlicedMandate({
      chain,
      request,
      token,
      openReserves: held.openReserves,
      approvedWithin: held.approvedWithin,
      revoked: false,
      now: deps.now(),
      profile: deps.profile,
    })
    return check.result === 'denied' ? check.reason : null
  }

  async function handle(r: WorkerRequest): Promise<WorkerAnswer> {
    const no = (reason: ReasonCode): WorkerAnswer => ({ ok: false, reason })
    const now = deps.now()
    forget(now)
    if (!isWorkerRequestSigned(r)) return no('message.signature_invalid')
    if (r.expiry <= now) return no('message.expired')
    if (r.expiry > now + WORKER_REQUEST_MAX_VALIDITY) return no('message.validity_too_long')
    const id = r.requestId.toLowerCase()
    if (seen.has(id)) return no('message.replayed')
    seen.set(id, r.expiry)

    const mandates = await deps.mandates()
    const mandate = mandates.current.proof.message
    const live = await liveChain(r.subKey, mandates)
    if (!live.ok) return no(live.reason)

    if (r.ask.kind === 'agreement') {
      const { agreement: a, request, salt } = r.ask
      if (!isAddressEqual(request.agentKey, key.accessKeyAddress)) return no('agent.key_mismatch')
      if (
        a.mandateHash.toLowerCase() !== mandates.current.hash.toLowerCase() ||
        a.buyerBusinessId !== mandate.businessId ||
        a.commitmentId.toLowerCase() !== request.commitmentId.toLowerCase() ||
        a.category !== request.category ||
        a.supplierBusinessId !== request.supplier
      ) {
        return no('message.invalid')
      }
      if (a.expiry <= now) return no('message.expired')
      if (termsHash(request.terms, salt).toLowerCase() !== a.termsHash.toLowerCase()) {
        return no('terms.hash_mismatch')
      }
      const refused = await sliceCheck(live.chain, request)
      if (refused) return no(refused)
      let digest: Hex
      try {
        digest = digestOf(termsAgreementTypedData(a, d))
      } catch {
        return no('message.invalid')
      }
      const buyerSignature = await key.sign({ hash: digest, raw: true })
      agreed.set(a.commitmentId.toLowerCase(), {
        subKey: r.subKey,
        request,
        termsHash: a.termsHash,
        expiry: a.expiry,
      })
      return { ok: true, kind: 'agreement', buyerSignature }
    }

    const { approval } = r.ask
    const a = approval.message
    const mine = agreed.get(a.commitmentId.toLowerCase())
    if (!mine || !isAddressEqual(mine.subKey, r.subKey)) return no('approval.commitment_mismatch')
    const envelope = checkEnvelope(approval, {
      type: 'Approval',
      chainId: d.chainId,
      lock: d.verifyingContract,
    })
    if (envelope) return no(envelope)
    const tokenProblem = approvalTokenProblem(a, token.token)
    if (tokenProblem) return no(tokenProblem)
    const termsProblem = approvalTermsProblem(a, {
      lock: lockTerms(mine.request.terms, token.decimals),
      termsHash: mine.termsHash,
    })
    if (termsProblem) return no(termsProblem)
    const mandateProblem = approvalMandateProblem(a, {
      mandateHash: mandates.current.hash,
      caps: approvalCaps(mandate, token.decimals),
      fundingKeys: [key.accessKeyAddress],
    })
    if (mandateProblem) return no(mandateProblem)
    if (a.expiry <= now) return no('message.expired')
    if (a.acceptBy <= now) return no('authorization.accept_by_passed')
    // The slices are read again, so a worker revoked or narrowed since the agreement funds nothing.
    const refused = await sliceCheck(live.chain, mine.request)
    if (refused) return no(refused)
    // Avow's signature over the approval is the lock's to check, and the lock refuses a reserve
    // without it, so nothing here moves money on an approval Avow didn't sign.
    agreed.delete(a.commitmentId.toLowerCase())
    const landed = await deps.send(reserveCalls(approval, d))
    return {
      ok: true,
      kind: 'fund',
      transactionHash: landed.transactionHash,
      blockNumber: landed.blockNumber,
    }
  }

  return { handle }
}

export type ParentSigner = ReturnType<typeof createParentSigner>
