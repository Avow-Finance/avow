import {
  type Approval,
  type AvowDomain,
  approvalCaps,
  approvalDigest,
  approvalMandateProblem,
  approvalPartiesProblem,
  approvalTermsProblem,
  approvalTokenProblem,
  type ChainedTerms,
  type CheckedDependency,
  chainedTermsShapeProblem,
  checkEnvelope,
  checkMandate,
  digestOf,
  isChainedTerms,
  isKeySignature,
  isTermsV1,
  lockTerms,
  type Mandate,
  type MandateCheckInput,
  type MandateProof,
  MESSAGE_VERSIONS,
  mandateHash,
  newSalt,
  type RailToken,
  type ReasonCode,
  type RefusalLayer,
  type Signed,
  type SignedAgreement,
  type StartReceipt,
  type SupplierProfile,
  startReceiptTypedData,
  type Terms,
  type TermsAgreement,
  type TermsProfile,
  termsAgreementTypedData,
  termsHash,
  termsShapeProblem,
} from '@avow-finance/spec'
import {
  type DependencyDeps,
  type DependencyRefusal,
  type LockedBacking,
  readBacking,
  verifyDependencies,
} from '@avow-finance/verifier'
import {
  type Address,
  type Chain,
  type Client,
  type Hex,
  hexToBigInt,
  isAddressEqual,
  type Transport,
  toHex,
} from 'viem'
import { getBlock, getTransactionReceipt } from 'viem/actions'
import type { Account as TempoAccount } from 'viem/tempo'
import type { AvowApi, AvowRecords } from './avow-api.js'
import { type Call, reserveCalls } from './lock.js'
import { SEND_LIMITS, SendError, type SendLimits, sendSponsored } from './send.js'
import type { SupplierConnection } from './supplier.js'

/** An agent's access key on its business account, as Tempo signs with it. */
export type AgentKey = TempoAccount.AccessKeyAccount

/** Where the transaction that funded a reserve landed. */
export interface Landed {
  transactionHash: Hex
  blockNumber: bigint
}

export interface AgentConfig<A extends AvowApi = AvowApi> {
  /** A client for the chain the business's lock is on, with the chain's fee token set. */
  client: Client<Transport, Chain>
  /**
   * The agent's access key on the business account. Its own address is the mandate's agent key.
   * It signs transactions for the account, and Avow's messages with its bare signature.
   */
  key: AgentKey
  /**
   * The mandate the business's administrator authorized for this agent, by signing it or by the
   * transaction that put the agent's key on. It names the chain and lock.
   */
  mandate: MandateProof
  /** The token the business's lock holds reserves in, on the mandate's chain. */
  token: RailToken
  /** The rules the terms have to meet, the profile Avow and the supplier check them under. */
  profile: TermsProfile
  /**
   * Avow's side of the commitments. The agent has `cancel` and `start` only when it has `records`,
   * which `httpAvowApi` serves.
   */
  avow: A
  /** How long, in seconds, an offer stays open for the supplier and Avow. Ten minutes by default. */
  offerValidity?: bigint
  /**
   * The longest, in seconds, Avow's approval may stay valid. A failed funding is settled once the
   * approval stops working, so a long one would leave it unsettled. Five minutes by default.
   */
  maxApprovalValidity?: bigint
  /** The clock, in unix seconds. The system clock by default. */
  now?: () => bigint
  /**
   * Sends the transaction that funds a reserve and returns where it landed. By default the key
   * signs it and Avow's relay pays its fee, through `sendSponsored`. An agent whose wallet pays
   * its own fees, or a test, passes its own, and throws a `SendError` when it fails.
   */
  send?: (calls: Call[]) => Promise<Landed>
  limits?: SendLimits
  /**
   * The chain and factory pairs whose locks a booking relied on may sit in, each with its reader,
   * such as `tempoLockReader`. `commitToQuote` refuses version 3 terms with
   * `dependency.lock_unknown` when this is left out.
   */
  dependencies?: DependencyDeps
}

/** One booking the agent makes with one supplier. */
export interface Booking {
  supplier: SupplierConnection
  /**
   * The commitment's version 2 terms, built with the template the booking falls under, such as
   * `gpuReservationTerms` for a GPU reservation. The agent checks them against their template's
   * rules and the profile before anyone sees them.
   */
  terms: Terms
  /** The mandate category the booking falls under, such as `compute`. */
  category: string
}

/** Terms a commitment can be made under: version 2, or version 3 through `commitToQuote`. */
export type CommittedTerms = Terms | ChainedTerms

/** A commitment the agent agreed and Avow approved, before any money moved. */
export interface ApprovedCommitment<T extends CommittedTerms = Terms> {
  commitmentId: Hex
  supplier: SupplierProfile
  terms: T
  /**
   * The commitment's salt, which keeps the terms hash from revealing standard terms. Keep it
   * private, since showing a section of the terms or checking the commitment later needs it.
   */
  salt: Hex
  termsHash: Hex
  agreement: SignedAgreement
  approval: Signed<Approval>
}

/** A commitment the agent made and funded. */
export interface Commitment<T extends CommittedTerms = Terms> extends ApprovedCommitment<T> {
  /**
   * The transaction that funded the reserve. It's null when the reserve landed in a transaction
   * the agent didn't send, or when the receipt of the agent's own couldn't be read.
   */
  reservedIn: Hex | null
}

/**
 * What the lock says about an approved commitment once Avow's approval can no longer land:
 * `funded` when it holds the reserve under the approval, `failed` when it doesn't, and `unknown`
 * when the chain didn't show it in time.
 */
export type Reconciled =
  | { outcome: 'funded'; reservedIn: Hex | null }
  | { outcome: 'failed' | 'unknown' }

/** A booking's outcome. A refusal carries the reason code, and Avow's decision id once it decided. */
export type BookResult<T extends CommittedTerms = Terms> =
  | { ok: true; commitment: Commitment<T> }
  | { ok: false; reason: ReasonCode; decisionId?: string }

/**
 * Who refused a quote: `avow` is Avow's API declining to approve the reserve, and `sdk` is the
 * agent's own check, before Avow is asked or of what Avow approved. Either way no money moved.
 */
export type QuoteRefusalLayer = Extract<RefusalLayer, 'sdk' | 'avow'>

/**
 * A quote's outcome. Once funded it lists each booking version 3 terms rely on with the block the
 * agent read it at, just before it funded. A refusal names who refused, and a refusal by that check
 * says which booking failed and the block it was read at.
 */
export type QuoteResult =
  | { ok: true; commitment: Commitment<CommittedTerms>; dependencies: readonly CheckedDependency[] }
  | { ok: false; reason: ReasonCode; layer: QuoteRefusalLayer; decisionId?: string }
  | (DependencyRefusal & { layer: 'sdk'; decisionId?: string })

/** A quote a supplier already signed, which the agent commits to as the buyer. */
export interface SignedQuote {
  /** The supplier as Avow registered it. Its signing key has to have signed the agreement. */
  supplier: SupplierProfile
  /** Version 2 terms, or version 3 terms in full. */
  terms: CommittedTerms
  salt: Hex
  /**
   * The terms agreement the supplier signed. It names this agent's business as the buyer, the
   * agent's mandate, the supplier and the terms hash of these terms under this salt.
   */
  agreement: TermsAgreement
  supplierSignature: Hex
  /**
   * For version 3 terms, the section of each booking they rely on that the supplier shows, as
   * JSON, in the terms' order.
   */
  disclosed?: readonly unknown[]
}

/**
 * A booking whose funding failed after Avow approved it. The agent has already read the lock
 * after the approval stopped working, so `failed` means no reserve was funded and none can be.
 * `unknown` means the chain didn't show the outcome in time. It carries the commitment and every
 * transaction hash sent, so the agent can `reconcile` this booking later instead of making
 * another one.
 */
export class BookingError extends Error {
  readonly outcome: 'failed' | 'unknown'
  /** The commitment, whose terms are version 3 only when `commitToQuote` made it. */
  readonly commitment: ApprovedCommitment<CommittedTerms>
  readonly hashes: readonly Hex[]

  constructor(
    message: string,
    outcome: 'failed' | 'unknown',
    commitment: ApprovedCommitment<CommittedTerms>,
    hashes: readonly Hex[],
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'BookingError'
    this.outcome = outcome
    this.commitment = commitment
    this.hashes = [...hashes]
  }
}

/** What every agent does, whatever its `AvowApi` serves. */
export interface AgentCalls {
  /** The business account the agent acts for. */
  account: Address
  /** The business's lock, where its reserves sit. */
  lock: Address
  /** The chain and the business's lock, which every message the agent signs is signed under. */
  domain: AvowDomain
  /** The mandate's hash under the business's lock. */
  mandateHash: Hex
  /**
   * Books with a supplier under the booking's terms and funds the reserve. Before any money
   * moves it refuses, with a reason code, terms of another version than 2, terms or a booking
   * the mandate doesn't allow, a reserve the mandate sends to the administrator, a supplier
   * signature from another key, Avow's refusal, and an approval that differs from the terms or
   * the mandate or that the lock would refuse as late. Once the reserve is funded it checks the
   * lock holds it under Avow's approval. When funding fails it reads the lock after the approval
   * stops working, and returns the commitment if the reserve landed anyway. Otherwise it throws
   * a `BookingError`.
   */
  book(b: Booking): Promise<BookResult>
  /**
   * Commits as the buyer to a quote the supplier already signed, and funds the reserve. Before
   * anything is signed it refuses terms that don't hash to the agreement's terms hash, an
   * agreement naming another buyer, mandate or supplier, or one expired or valid too long, and a
   * supplier signature from another key. Version 2 terms then go through the mandate check, as
   * `book` runs it. It signs as the buyer, asks Avow, and checks the approval as `book` does. For
   * version 3 terms it then checks every booking they rely on with `verifyDependencies`, taking
   * the owner from Avow's approval, and runs the mandate check on the checked terms. Only then does
   * it fund, settling a failed funding as `book` does.
   *
   * So for version 3 terms Avow is asked before the agent's own mandate check runs. Avow's API runs
   * the same check first, so a version 3 quote over the mandate's caps comes back as Avow's refusal,
   * with the layer `avow`. Every other refusal is the SDK's, and no money moves before any of them.
   */
  commitToQuote(q: SignedQuote): Promise<QuoteResult>
  /**
   * Reads the lock for a commitment `book` or `commitToQuote` approved but couldn't settle, once
   * Avow's approval can no longer land, so the agent learns whether that same booking was funded.
   * It takes what a `BookingError` carries.
   */
  reconcile(
    approved: ApprovedCommitment<CommittedTerms>,
    hashes?: readonly Hex[],
  ): Promise<Reconciled>
  /** What the lock holds for one of the business's commitments, or null when it holds nothing. */
  commitment(commitmentId: Hex): Promise<LockedBacking | null>
}

/** What an agent does once its `AvowApi` serves Avow's records of cancellations and job starts. */
export interface AgentRecordCalls {
  /**
   * Tells Avow the business cancels a commitment, which Avow timestamps. Before free
   * cancellation ends the reserve can go back in full, and after it a late cancellation charge
   * can apply.
   */
  cancel(
    commitmentId: Hex,
  ): Promise<{ ok: true; cancelledAt: bigint } | { ok: false; reason: ReasonCode }>
  /**
   * Starts the job with the supplier. The lock has to hold the commitment with this supplier's
   * signing key. Avow timestamps the request, the supplier returns its signed start receipt,
   * which the agent checks answers the request and comes from that key, and Avow records the
   * start the kept booking rests on.
   */
  start(
    commitmentId: Hex,
    supplier: SupplierConnection,
  ): Promise<{ ok: true; receipt: Signed<StartReceipt> } | { ok: false; reason: ReasonCode }>
}

/**
 * An agent that makes commitments under its mandate, as `createAgent` returns it for an `AvowApi`
 * of type `A`. It has `cancel` and `start` only when `A` has `records`, Avow's records of
 * cancellations and job starts, so code that calls one on an `AvowApi` without them doesn't
 * compile. An agent made with `httpAvowApi` has both.
 */
export type Agent<A extends AvowApi = AvowApi> = AgentCalls &
  (A extends { records: AvowRecords } ? AgentRecordCalls : unknown)

/** Every call of Avow's records, so a JavaScript caller's `records` is checked for each. */
const RECORD_CALLS = Object.keys({
  cancel: true,
  requestStart: true,
  recordStart: true,
} satisfies Record<keyof AvowRecords, true>) as (keyof AvowRecords)[]

const randomUint = () => hexToBigInt(toHex(crypto.getRandomValues(new Uint8Array(16))))
const systemClock = () => BigInt(Math.floor(Date.now() / 1000))
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * An agent that makes commitments under its mandate. It agrees terms with a supplier, asks Avow to
 * approve the reserve, checks Avow's approval against the terms and the mandate before any money
 * moves, and funds the reserve from the business's account with its own key while Avow's relay
 * pays the fee. It cancels and starts jobs only through an `AvowApi` that has `records`.
 */
export function createAgent<A extends AvowApi>(config: AgentConfig<A>): Agent<A> {
  const { client, key, avow, token } = config
  const mandate = config.mandate.message
  const d: AvowDomain = {
    chainId: config.mandate.chainId,
    verifyingContract: config.mandate.lock,
  }
  const envelope = checkEnvelope(config.mandate, { type: 'Mandate', chainId: client.chain.id })
  if (envelope) throw new Error(`The mandate can't be used on this chain (${envelope})`)
  if (!isAddressEqual(mandate.agentKey, key.accessKeyAddress)) {
    throw new Error("The mandate names another agent key than this agent's")
  }
  if (!isAddressEqual(mandate.account, key.address)) {
    throw new Error("The mandate names another business account than the key's")
  }
  if (token.chainId !== d.chainId || token.currency !== mandate.currency) {
    throw new Error("The token isn't on the mandate's chain or in its currency")
  }
  const mHash = mandateHash(mandate, d)
  const now = config.now ?? systemClock
  const offerValidity = config.offerValidity ?? 600n
  const maxApprovalValidity = config.maxApprovalValidity ?? 300n
  const permits = (action: Mandate['actions'][number]) => mandate.actions.includes(action)
  // An AvowApi serves all of Avow's record calls or none. TypeScript refuses a partial group, and
  // this refuses one from a JavaScript caller when the agent is made, before any call needs it.
  const served: Partial<AvowRecords> | null | undefined = avow.records
  if (served) {
    const missing = RECORD_CALLS.filter((call) => typeof served[call] !== 'function')
    if (missing.length > 0) {
      throw new Error(
        `The AvowApi's records lack ${missing.join(' and ')}. An AvowApi serves all of Avow's record calls or none.`,
      )
    }
  }
  /**
   * Avow's records of cancellations and starts. TypeScript gives an agent `cancel` and `start` only
   * when its `AvowApi` has them, so this refusal is for a JavaScript caller, before anything is
   * read or sent.
   */
  const records = (what: string): AvowRecords => {
    if (!served) {
      throw new Error(
        `The AvowApi this agent uses has no records, so it can't ${what}. httpAvowApi serves them.`,
      )
    }
    return served as AvowRecords
  }
  const send =
    config.send ??
    ((calls: Call[]) =>
      sendSponsored({
        client,
        account: key,
        calls,
        sponsor: (transaction) => avow.sponsor(transaction),
        ...(config.limits ? { limits: config.limits } : {}),
      }))

  /**
   * Why an approval differs from what the agent asked for, or null when it doesn't. The lock
   * enforces what the approval says, so the agent funds only an approval that names exactly the
   * terms, parties and mandate it agreed, and that the lock will still take.
   */
  function approvalProblem(
    approval: Signed<Approval>,
    expected: {
      commitmentId: Hex
      supplier: SupplierProfile
      terms: CommittedTerms
      termsHash: Hex
    },
  ): ReasonCode | null {
    const envelopeProblem = checkEnvelope(approval, {
      type: 'Approval',
      chainId: d.chainId,
      lock: d.verifyingContract,
    })
    if (envelopeProblem) return envelopeProblem
    const a = approval.message
    if (a.commitmentId.toLowerCase() !== expected.commitmentId.toLowerCase()) {
      return 'approval.commitment_mismatch'
    }
    const parties = approvalPartiesProblem(a, expected.supplier)
    if (parties) return parties
    const tokenProblem = approvalTokenProblem(a, token.token)
    if (tokenProblem) return tokenProblem
    const termsProblem = approvalTermsProblem(a, {
      lock: lockTerms(expected.terms, token.decimals),
      termsHash: expected.termsHash,
    })
    if (termsProblem) return termsProblem
    // The agent funds the reserve with its own key, so the approval has to name that key.
    const mandateProblem = approvalMandateProblem(a, {
      mandateHash: mHash,
      caps: approvalCaps(mandate, token.decimals),
      fundingKeys: [key.accessKeyAddress],
    })
    if (mandateProblem) return mandateProblem
    // The lock refuses an approval past its expiry or its acceptance deadline.
    if (a.expiry <= now()) return 'message.expired'
    if (a.acceptBy <= now()) return 'authorization.accept_by_passed'
    if (a.expiry > now() + maxApprovalValidity) return 'message.validity_too_long'
    return null
  }

  /**
   * What the lock holds for the commitment as of the block the funding landed in, read again
   * while the node answers with an error, since a node without the block refuses the read.
   */
  async function backingAt(commitmentId: Hex, blockNumber: bigint) {
    for (let i = 1; ; i++) {
      try {
        return await readBacking(client, d.verifyingContract, commitmentId, 'buyer', {
          blockNumber,
        })
      } catch (error) {
        if (i >= 6) throw error
        await sleep(1500)
      }
    }
  }

  const limits = config.limits ?? SEND_LIMITS

  /**
   * The first of the agent's own transactions whose receipt shows it succeeded with a log from the
   * lock, or null when none shows one. That's when the reserve landed in a transaction the agent
   * didn't send, or when a receipt couldn't be read.
   */
  async function landedOf(hashes: readonly Hex[]): Promise<Hex | null> {
    for (const hash of hashes) {
      const receipt = await getTransactionReceipt(client, { hash }).catch(() => null)
      if (
        receipt?.status === 'success' &&
        receipt.logs.some((l) => isAddressEqual(l.address, d.verifyingContract))
      ) {
        return hash
      }
    }
    return null
  }

  /**
   * Reads the lock for an approved commitment once no transaction carrying Avow's approval can
   * still land. The lock takes the approval only in a block before its expiry and before the
   * acceptance deadline, so it reads the lock as of a finalized block at or past the earlier of
   * the two, which no later block can change. It waits for that block up to the limit's receipt
   * timeout.
   */
  async function reconcile(
    approved: ApprovedCommitment<CommittedTerms>,
    hashes: readonly Hex[] = [],
  ): Promise<Reconciled> {
    const a = approved.approval.message
    const closes = a.expiry < a.acceptBy ? a.expiry : a.acceptBy
    const digest = approvalDigest(a, d).toLowerCase()
    const deadline = Date.now() + limits.receiptTimeout
    for (;;) {
      const final = await getBlock(client, { blockTag: 'finalized' }).catch(() => null)
      if (final && final.timestamp >= closes) {
        const read = (at?: bigint) =>
          readBacking(
            client,
            d.verifyingContract,
            approved.commitmentId,
            'buyer',
            at === undefined ? {} : { blockNumber: at },
          ).catch(() => undefined)
        // A read that fails is read again, never taken as an empty lock.
        const held = await read(final.number)
        if (held) {
          if (held.approvalHash.toLowerCase() !== digest) return { outcome: 'unknown' }
          return { outcome: 'funded', reservedIn: await landedOf(hashes) }
        }
        if (held === null) {
          // Nothing carrying the approval can land after that block, so the latest block has to
          // agree. A node that answered the past block from other state shows up here.
          const latest = await read()
          if (latest === null) return { outcome: 'failed' }
          if (latest) return { outcome: 'unknown' }
        }
      }
      if (Date.now() > deadline) return { outcome: 'unknown' }
      await sleep(limits.wait)
    }
  }

  /** Why a supplier's start receipt doesn't answer the start request, or null when it does. */
  function receiptProblem(
    receipt: Signed<StartReceipt>,
    expected: { commitmentId: Hex; startRequestHash: Hex; requestedAt: bigint; signer: Address },
  ): ReasonCode | null {
    const envelopeProblem = checkEnvelope(receipt, {
      type: 'StartReceipt',
      chainId: d.chainId,
      lock: d.verifyingContract,
    })
    if (envelopeProblem) return envelopeProblem
    const m = receipt.message
    if (
      m.commitmentId.toLowerCase() !== expected.commitmentId.toLowerCase() ||
      m.startRequestHash.toLowerCase() !== expected.startRequestHash.toLowerCase() ||
      m.side !== 'buyer' ||
      m.startedAt < expected.requestedAt
    ) {
      return 'message.invalid'
    }
    if (m.expiry <= now()) return 'message.expired'
    const digest = digestOf(startReceiptTypedData(m, d))
    if (!isKeySignature(digest, receipt.signature, expected.signer)) {
      return 'message.signature_invalid'
    }
    return null
  }

  // Every agent has `cancel` and `start` at run time, so a JavaScript caller whose `AvowApi` has
  // no records learns why from the error. `Agent<A>` shows them only when `A` has records.

  /** The reserve request Avow approves and the mandate check reads, for terms of either version. */
  function requestOf<T extends CommittedTerms>(
    commitmentId: Hex,
    supplier: SupplierProfile,
    category: string,
    terms: T,
  ) {
    return {
      commitmentId,
      agentKey: key.accessKeyAddress,
      supplier: supplier.businessId,
      payee: supplier.payee,
      category,
      terms,
    }
  }

  /**
   * The same check Avow and a supplier's verifier run, or null when it approves. The lock enforces
   * the open reserves cap, so this check counts none open, as the verifier does. The SDK can't yet
   * carry the administrator's approval in person, so a reserve the mandate sends to them is
   * refused.
   */
  function mandateCheck(request: MandateCheckInput['request']): ReasonCode | null {
    const allowed = checkMandate({
      mandate,
      request,
      token,
      openReserves: 0n,
      revoked: false,
      now: now(),
      profile: config.profile,
    })
    return allowed.result === 'approved' ? null : allowed.reason
  }

  /**
   * Signs the agreement as the buyer once the supplier's signature checks out, asks Avow to
   * approve the reserve, and checks the approval against the terms and the mandate. Version 3
   * terms then pass `verifyDependencies` on that approval, which names the owner of each booking
   * they rely on, and the mandate check on the checked terms. Only then is the reserve funded.
   */
  async function commitAgreed(a: {
    supplier: SupplierProfile
    terms: CommittedTerms
    salt: Hex
    agreement: TermsAgreement
    supplierSignature: Hex
    disclosed?: readonly unknown[]
  }): Promise<QuoteResult> {
    const { supplier, terms, salt, agreement } = a
    const digest = digestOf(termsAgreementTypedData(agreement, d))
    if (!isKeySignature(digest, a.supplierSignature, supplier.signingKey)) {
      return { ok: false, reason: 'message.signature_invalid', layer: 'sdk' }
    }
    const buyerSignature = await key.sign({ hash: digest, raw: true })
    const signed: SignedAgreement = {
      type: 'TermsAgreement',
      schemaVersion: MESSAGE_VERSIONS.TermsAgreement,
      chainId: d.chainId,
      lock: d.verifyingContract,
      message: agreement,
      buyerSignature,
      supplierSignature: a.supplierSignature,
    }
    const { commitmentId } = agreement
    const request = requestOf(commitmentId, supplier, agreement.category, terms)
    const answer = await avow.approveReserve({
      request,
      salt,
      agreement: signed,
      fundedBy: 'agent',
    })
    if (!answer.ok) {
      return { ok: false, reason: answer.reason, layer: 'avow', decisionId: answer.decisionId }
    }
    const { decisionId } = answer
    const problem = approvalProblem(answer.approval, {
      commitmentId,
      supplier,
      terms,
      termsHash: agreement.termsHash,
    })
    if (problem) return { ok: false, reason: problem, layer: 'sdk', decisionId }

    let dependencies: readonly CheckedDependency[] = []
    if (isChainedTerms(terms)) {
      const relied = await verifyDependencies(
        { terms, approval: answer.approval.message, disclosed: a.disclosed ?? [], now: now() },
        config.dependencies ?? { readers: [] },
      )
      if (!relied.ok) return { ...relied, layer: 'sdk', decisionId }
      const allowed = mandateCheck({ ...request, terms: relied.terms })
      if (allowed) return { ok: false, reason: allowed, layer: 'sdk', decisionId }
      dependencies = relied.checked
    }
    const approved: ApprovedCommitment<CommittedTerms> = {
      commitmentId,
      supplier,
      terms,
      salt,
      termsHash: agreement.termsHash,
      agreement: signed,
      approval: answer.approval,
    }
    const reservedIn = await fund(approved)
    return { ok: true, commitment: { ...approved, reservedIn }, dependencies }
  }

  /**
   * Funds an approved reserve with the agent's key and returns the transaction that funded it,
   * once the lock holds the commitment under exactly the approval the agent checked. When funding
   * fails it reads the lock after the approval stops working, returns if the reserve landed
   * anyway, and otherwise throws a `BookingError`.
   */
  async function fund(approved: ApprovedCommitment<CommittedTerms>): Promise<Hex | null> {
    const { commitmentId, approval } = approved
    let landed: Landed | null = null
    let failure: unknown = null
    try {
      landed = await send(reserveCalls(approval, d))
    } catch (error) {
      failure = error
    }
    if (landed) {
      const held = await backingAt(commitmentId, landed.blockNumber).catch(() => null)
      const expected = approvalDigest(approval.message, d).toLowerCase()
      if (held && held.approvalHash.toLowerCase() === expected) return landed.transactionHash
    }
    const hashes =
      failure instanceof SendError ? failure.hashes : landed ? [landed.transactionHash] : []
    const what = failure
      ? failure instanceof Error
        ? failure.message
        : String(failure)
      : `${landed?.transactionHash} landed, but the lock didn't show the reserve under Avow's approval`
    // A transaction the key never signed can't land, so a send that failed before signing
    // settles the booking.
    if (failure instanceof SendError && failure.signings === 0) {
      throw new BookingError(
        `Funding ${commitmentId} failed: ${what}`,
        'failed',
        approved,
        hashes,
        {
          cause: failure,
        },
      )
    }
    const settled = await reconcile(approved, hashes)
    if (settled.outcome === 'funded') return settled.reservedIn
    throw new BookingError(
      settled.outcome === 'failed'
        ? `Funding ${commitmentId} failed, and the lock holds no reserve for it: ${what}`
        : `Whether ${commitmentId} was funded is unknown: ${what}`,
      settled.outcome,
      approved,
      hashes,
      { cause: failure ?? undefined },
    )
  }
  const agent: AgentCalls & AgentRecordCalls = {
    account: mandate.account,
    lock: d.verifyingContract,
    domain: d,
    mandateHash: mHash,

    async book(b: Booking): Promise<BookResult> {
      const { terms } = b
      // A new commitment takes version 2 terms. Version 1 is only for commitments made under it,
      // and version 3 terms come signed by their supplier through `commitToQuote`, so both stop
      // here, before anything is signed.
      if (isTermsV1(terms) || isChainedTerms(terms)) {
        return { ok: false, reason: 'terms.version_unknown' }
      }
      const supplier = b.supplier.profile
      const commitmentId = toHex(crypto.getRandomValues(new Uint8Array(32)))
      const allowed = mandateCheck(requestOf(commitmentId, supplier, b.category, terms))
      if (allowed) return { ok: false, reason: allowed }

      const salt = newSalt()
      const agreement: TermsAgreement = {
        commitmentId,
        termsHash: termsHash(terms, salt),
        category: b.category,
        buyerBusinessId: mandate.businessId,
        supplierBusinessId: supplier.businessId,
        mandateHash: mHash,
        nonce: randomUint(),
        expiry: now() + offerValidity,
      }
      const supplierSignature = await b.supplier.signAgreement({
        agreement,
        terms,
        salt,
        domain: d,
      })
      const done = await commitAgreed({ supplier, terms, salt, agreement, supplierSignature })
      if (done.ok) return { ok: true, commitment: { ...done.commitment, terms } }
      return done.decisionId === undefined
        ? { ok: false, reason: done.reason }
        : { ok: false, reason: done.reason, decisionId: done.decisionId }
    },

    async commitToQuote(q: SignedQuote): Promise<QuoteResult> {
      const { terms, agreement: a } = q
      if (isTermsV1(terms)) return { ok: false, reason: 'terms.version_unknown', layer: 'sdk' }
      const shape = isChainedTerms(terms)
        ? chainedTermsShapeProblem(terms)
        : termsShapeProblem(terms)
      if (shape) return { ok: false, reason: shape, layer: 'sdk' }
      if (termsHash(terms, q.salt).toLowerCase() !== a.termsHash.toLowerCase()) {
        return { ok: false, reason: 'terms.hash_mismatch', layer: 'sdk' }
      }
      const parties =
        a.buyerBusinessId === mandate.businessId &&
        a.mandateHash.toLowerCase() === mHash.toLowerCase() &&
        a.supplierBusinessId === q.supplier.businessId
      if (!parties) return { ok: false, reason: 'agreement.parties_mismatch', layer: 'sdk' }
      if (a.expiry <= now()) return { ok: false, reason: 'message.expired', layer: 'sdk' }
      if (a.expiry > now() + offerValidity) {
        return { ok: false, reason: 'message.validity_too_long', layer: 'sdk' }
      }
      // Version 2 terms go through the mandate check before anything is signed, as in `book`.
      // Version 3 terms go through it once their bookings are checked, since it takes them only as
      // checked terms.
      if (!isChainedTerms(terms)) {
        const allowed = mandateCheck(requestOf(a.commitmentId, q.supplier, a.category, terms))
        if (allowed) return { ok: false, reason: allowed, layer: 'sdk' }
      }
      return commitAgreed({
        supplier: q.supplier,
        terms,
        salt: q.salt,
        agreement: a,
        supplierSignature: q.supplierSignature,
        disclosed: q.disclosed ?? [],
      })
    },
    reconcile,

    async cancel(commitmentId: Hex) {
      const served = records('record a cancellation')
      if (!permits('cancel')) return { ok: false, reason: 'mandate.action_not_permitted' }
      const { cancelledAt } = await served.cancel({ commitmentId })
      return { ok: true, cancelledAt }
    },

    async start(commitmentId: Hex, supplier: SupplierConnection) {
      const served = records('start the job')
      if (!permits('start')) return { ok: false, reason: 'mandate.action_not_permitted' }
      // The receipt has to come from the signing key the lock holds for the commitment.
      const held = await readBacking(client, d.verifyingContract, commitmentId, 'buyer')
      if (!held) return { ok: false, reason: 'chain.reserve_missing' }
      if (!isAddressEqual(held.supplierSigner, supplier.profile.signingKey)) {
        return { ok: false, reason: 'chain.supplier_mismatch' }
      }
      const request = await served.requestStart({ commitmentId })
      const receipt = await supplier.startJob({ commitmentId, ...request })
      const problem = receiptProblem(receipt, {
        commitmentId,
        ...request,
        signer: held.supplierSigner,
      })
      if (problem) return { ok: false, reason: problem }
      const recorded = await served.recordStart({ commitmentId, receipt })
      if (!recorded.ok) return { ok: false, reason: recorded.reason }
      return { ok: true, receipt }
    },

    commitment(commitmentId: Hex): Promise<LockedBacking | null> {
      return readBacking(client, d.verifyingContract, commitmentId, 'buyer')
    },
  }
  return agent
}
