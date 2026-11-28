import {
  type Approval,
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
  type Signed,
  type SliceChain,
  sliceChainProblem,
  type Terms,
  type TermsProfile,
  termsAgreementTypedData,
  termsHash,
  type WorkerSlices,
} from '@avow-finance/spec'
import { type Address, type Hex, isAddressEqual } from 'viem'
import type { Landed, Reconciled } from '../agent.js'
import { type Call, reserveCalls } from '../lock.js'
import { SendError } from '../send.js'
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
  holdings: (
    chain: SliceChain,
    /** A commitment to leave out of the counts, the one being funded, which Avow already counts. */
    excluding: Hex | null,
  ) => Promise<{
    openReserves: { mandate: bigint; slices: readonly bigint[] }
    approvedWithin: readonly bigint[]
  }>
  /** Whether the business account signed a digest, for a slice the administrator changed. */
  isAccountSignature?: SignatureCheck
  /** Sends the transaction that funds a reserve with the agent's key. */
  send: (calls: Call[]) => Promise<Landed>
  /**
   * Reads the lock for an approved reserve whose funding failed, once the approval can no longer
   * land, as `createAgent`'s `reconcile` does, with every hash the send carried.
   */
  reconcile: (approval: Signed<Approval>, hashes: readonly Hex[]) => Promise<Reconciled>
  /** How long, in seconds, an agreement may stay open. Ten minutes by default, as `createAgent`'s. */
  offerValidity?: bigint
}

interface Agreed {
  subKey: Address
  request: Omit<ReserveRequest, 'terms'> & { terms: Terms }
  termsHash: Hex
  expiry: bigint
  /** The funding under way, which a second ask for the same commitment waits on. */
  funding: Promise<WorkerAnswer> | null
  /** How funding ended, kept so the worker can ask again and hear the same answer. */
  funded: WorkerAnswer | null
}

/** Runs one task at a time, in the order they're given. */
function serial() {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task)
    tail = run.catch(() => {})
    return run
  }
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
  const offerValidity = deps.offerValidity ?? 600n
  // One signer serves one agent, so this holds every check and the signature that follows it to
  // one at a time across the agent's whole tree of slices, and two asks can't both pass on room
  // only one of them fits.
  const exclusive = serial()

  const forget = (now: bigint) => {
    for (const [id, until] of seen) if (until < now) seen.delete(id)
    for (const [id, a] of agreed) if (a.expiry < now && a.funding === null) agreed.delete(id)
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
    excluding: Hex | null,
  ): Promise<ReasonCode | null> {
    const held = await deps.holdings(chain, excluding)
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

    if (r.ask.kind === 'fund') return fund(r, r.ask.approval)
    const ask = r.ask
    return exclusive(async () => {
      const mandates = await deps.mandates()
      const mandate = mandates.current.proof.message
      const live = await liveChain(r.subKey, mandates)
      if (!live.ok) return no(live.reason)
      const { agreement: a, request, salt } = ask
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
      if (a.expiry > now + offerValidity) return no('message.validity_too_long')
      if (agreed.has(a.commitmentId.toLowerCase())) return no('message.replayed')
      if (termsHash(request.terms, salt).toLowerCase() !== a.termsHash.toLowerCase()) {
        return no('terms.hash_mismatch')
      }
      const refused = await sliceCheck(live.chain, request, null)
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
        funding: null,
        funded: null,
      })
      return { ok: true, kind: 'agreement', buyerSignature } as WorkerAnswer
    })
  }

  /**
   * Funds the reserve of an agreement this signer signed for the same worker. One funding runs for
   * a commitment at a time, and an ask while one runs waits for it. A funding whose send fails is
   * reconciled from the lock, and the entry stays until the outcome is known, so a worker that
   * asks again hears it, or the reserve is sent again when the lock shows it can still land.
   */
  async function fund(r: WorkerRequest, approval: Signed<Approval>): Promise<WorkerAnswer> {
    const no = (reason: ReasonCode): WorkerAnswer => ({ ok: false, reason })
    const id = approval.message.commitmentId.toLowerCase()
    const mine = agreed.get(id)
    if (!mine || !isAddressEqual(mine.subKey, r.subKey)) return no('approval.commitment_mismatch')
    if (mine.funded) return mine.funded
    if (mine.funding) return mine.funding
    /** Keeps how funding ended, so the worker hears the same answer when it asks again. */
    const settle = (answer: WorkerAnswer): WorkerAnswer => {
      mine.funded = answer
      return answer
    }
    const run = (async (): Promise<WorkerAnswer> => {
      const checked = await exclusive(() => fundCheck(r, mine, approval))
      if (checked) return no(checked)
      try {
        const landed = await deps.send(reserveCalls(approval, d))
        return settle({
          ok: true,
          kind: 'fund',
          transactionHash: landed.transactionHash,
          blockNumber: landed.blockNumber,
        })
      } catch (error) {
        const hashes = error instanceof SendError ? error.hashes : []
        // A send that never signed can't land, so the reserve can be sent again.
        if (error instanceof SendError && error.signings === 0) return no('service.unavailable')
        const outcome = await deps.reconcile(approval, hashes)
        if (outcome.outcome === 'funded') {
          return settle({
            ok: true,
            kind: 'fund',
            transactionHash: outcome.reservedIn ?? (hashes[0] as Hex | undefined) ?? null,
            blockNumber: null,
          })
        }
        if (outcome.outcome === 'failed') {
          // The approval can no longer land, so this agreement is spent.
          return settle(no('message.expired'))
        }
        return no('service.unavailable')
      }
    })()
    mine.funding = run
    try {
      return await run
    } finally {
      mine.funding = null
    }
  }

  /** The checks before funding, which run with no other check or signature under way. */
  async function fundCheck(
    r: WorkerRequest,
    mine: Agreed,
    approval: Signed<Approval>,
  ): Promise<ReasonCode | null> {
    const now = deps.now()
    const mandates = await deps.mandates()
    const mandate = mandates.current.proof.message
    const live = await liveChain(r.subKey, mandates)
    if (!live.ok) return live.reason
    const a = approval.message
    const envelope = checkEnvelope(approval, {
      type: 'Approval',
      chainId: d.chainId,
      lock: d.verifyingContract,
    })
    if (envelope) return envelope
    const tokenProblem = approvalTokenProblem(a, token.token)
    if (tokenProblem) return tokenProblem
    const termsProblem = approvalTermsProblem(a, {
      lock: lockTerms(mine.request.terms, token.decimals),
      termsHash: mine.termsHash,
    })
    if (termsProblem) return termsProblem
    const mandateProblem = approvalMandateProblem(a, {
      mandateHash: mandates.current.hash,
      caps: approvalCaps(mandate, token.decimals),
      fundingKeys: [key.accessKeyAddress],
    })
    if (mandateProblem) return mandateProblem
    if (a.expiry <= now) return 'message.expired'
    if (a.acceptBy <= now) return 'authorization.accept_by_passed'
    // The slices are read again, so a worker revoked or narrowed since the agreement funds nothing.
    // Avow counts its own approval of this reserve, so the count leaves it out and the check adds
    // it once.
    return await sliceCheck(live.chain, mine.request, a.commitmentId)
  }

  return { handle }
}

export type ParentSigner = ReturnType<typeof createParentSigner>
