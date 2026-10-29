import {
  type Approval,
  type AvowDomain,
  approvalCaps,
  approvalDigest,
  approvalMandateProblem,
  approvalPartiesProblem,
  approvalTermsProblem,
  approvalTokenProblem,
  checkEnvelope,
  checkMandate,
  digestOf,
  isKeySignature,
  isTermsV1,
  lockTerms,
  type Mandate,
  MESSAGE_VERSIONS,
  mandateHash,
  newSalt,
  type RailToken,
  type ReasonCode,
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
} from '@avow-finance/spec'
import { type LockedBacking, readBacking } from '@avow-finance/verifier'
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
  /** The mandate the business's administrator signed for this agent. It names the chain and lock. */
  mandate: Signed<Mandate>
  /** The token the business's lock holds reserves in, on the mandate's chain. */
  token: RailToken
  /** The rules the terms have to meet, the profile Avow and the supplier check them under. */
  profile: TermsProfile
  /**
   * Avow's side of the commitments. The agent has `cancel` and `start` only when it has `records`,
   * which Avow's hosted API doesn't serve yet.
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

/** A commitment the agent agreed and Avow approved, before any money moved. */
export interface ApprovedCommitment {
  commitmentId: Hex
  supplier: SupplierProfile
  terms: Terms
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
export interface Commitment extends ApprovedCommitment {
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
export type BookResult =
  | { ok: true; commitment: Commitment }
  | { ok: false; reason: ReasonCode; decisionId?: string }

/**
 * A booking whose funding failed after Avow approved it. The agent has already read the lock
 * after the approval stopped working, so `failed` means no reserve was funded and none can be.
 * `unknown` means the chain didn't show the outcome in time. It carries the commitment and every
 * transaction hash sent, so the agent can `reconcile` this booking later instead of making
 * another one.
 */
export class BookingError extends Error {
  readonly outcome: 'failed' | 'unknown'
  readonly commitment: ApprovedCommitment
  readonly hashes: readonly Hex[]

  constructor(
    message: string,
    outcome: 'failed' | 'unknown',
    commitment: ApprovedCommitment,
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
interface AgentCalls {
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
   * Reads the lock for a commitment `book` approved but couldn't settle, once Avow's approval can
   * no longer land, so the agent learns whether that same booking was funded. It takes what a
   * `BookingError` carries.
   */
  reconcile(approved: ApprovedCommitment, hashes?: readonly Hex[]): Promise<Reconciled>
  /** What the lock holds for one of the business's commitments, or null when it holds nothing. */
  commitment(commitmentId: Hex): Promise<LockedBacking | null>
}

/** What an agent does once its `AvowApi` serves Avow's records of cancellations and job starts. */
interface AgentRecordCalls {
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
 * cancellations and job starts. An agent made with `httpAvowApi` has neither, since Avow's hosted
 * API doesn't serve those records yet, so code that calls one doesn't compile.
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
  /**
   * Avow's records of cancellations and starts. TypeScript gives an agent `cancel` and `start` only
   * when its `AvowApi` has them, so this refusal is for a JavaScript caller, before anything is
   * read or sent.
   */
  const records = (what: string): AvowRecords => {
    const served: Partial<AvowRecords> | null | undefined = avow.records
    if (!served) {
      throw new Error(
        `The AvowApi this agent uses has no records, so it can't ${what}. Avow's hosted API doesn't serve its records of cancellations and starts yet.`,
      )
    }
    const missing = RECORD_CALLS.filter((call) => typeof served[call] !== 'function')
    if (missing.length > 0) {
      throw new Error(
        `The AvowApi this agent uses has records without ${missing.join(' or ')}, so it can't ${what}.`,
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
    expected: { commitmentId: Hex; supplier: SupplierProfile; terms: Terms; termsHash: Hex },
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
    approved: ApprovedCommitment,
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
  const agent: AgentCalls & AgentRecordCalls = {
    account: mandate.account,
    lock: d.verifyingContract,
    domain: d,
    mandateHash: mHash,

    async book(b: Booking): Promise<BookResult> {
      const { terms } = b
      // A new commitment takes version 2 terms, which the mandate check alone wouldn't insist on.
      if (isTermsV1(terms)) return { ok: false, reason: 'terms.version_unknown' }
      const supplier = b.supplier.profile
      const commitmentId = toHex(crypto.getRandomValues(new Uint8Array(32)))
      const request = {
        commitmentId,
        agentKey: key.accessKeyAddress,
        supplier: supplier.businessId,
        payee: supplier.payee,
        category: b.category,
        terms,
      }
      // The same check Avow and a supplier's verifier run. The lock enforces the open reserves
      // cap, so this check counts none open, as the verifier does. The SDK can't yet carry the
      // administrator's approval in person, so a reserve the mandate sends to them is refused.
      const allowed = checkMandate({
        mandate,
        request,
        token,
        openReserves: 0n,
        revoked: false,
        now: now(),
        profile: config.profile,
      })
      if (allowed.result !== 'approved') return { ok: false, reason: allowed.reason }

      const salt = newSalt()
      const tHash = termsHash(terms, salt)
      const agreement: TermsAgreement = {
        commitmentId,
        termsHash: tHash,
        category: b.category,
        buyerBusinessId: mandate.businessId,
        supplierBusinessId: supplier.businessId,
        mandateHash: mHash,
        nonce: randomUint(),
        expiry: now() + offerValidity,
      }
      const digest = digestOf(termsAgreementTypedData(agreement, d))
      const buyerSignature = await key.sign({ hash: digest, raw: true })
      const supplierSignature = await b.supplier.signAgreement({
        agreement,
        terms,
        salt,
        domain: d,
      })
      if (!isKeySignature(digest, supplierSignature, supplier.signingKey)) {
        return { ok: false, reason: 'message.signature_invalid' }
      }
      const signed: SignedAgreement = {
        type: 'TermsAgreement',
        schemaVersion: MESSAGE_VERSIONS.TermsAgreement,
        chainId: d.chainId,
        lock: d.verifyingContract,
        message: agreement,
        buyerSignature,
        supplierSignature,
      }
      const answer = await avow.approveReserve({
        request,
        salt,
        agreement: signed,
        fundedBy: 'agent',
      })
      if (!answer.ok) return { ok: false, reason: answer.reason, decisionId: answer.decisionId }
      const problem = approvalProblem(answer.approval, {
        commitmentId,
        supplier,
        terms,
        termsHash: tHash,
      })
      if (problem) return { ok: false, reason: problem, decisionId: answer.decisionId }

      const approved: ApprovedCommitment = {
        commitmentId,
        supplier,
        terms,
        salt,
        termsHash: tHash,
        agreement: signed,
        approval: answer.approval,
      }
      let landed: Landed | null = null
      let failure: unknown = null
      try {
        landed = await send(reserveCalls(answer.approval, d))
      } catch (error) {
        failure = error
      }
      if (landed) {
        // The lock has to hold this commitment under exactly the approval the agent checked.
        const held = await backingAt(commitmentId, landed.blockNumber).catch(() => null)
        const expected = approvalDigest(answer.approval.message, d).toLowerCase()
        if (held && held.approvalHash.toLowerCase() === expected) {
          return { ok: true, commitment: { ...approved, reservedIn: landed.transactionHash } }
        }
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
      if (settled.outcome === 'funded') {
        return { ok: true, commitment: { ...approved, reservedIn: settled.reservedIn } }
      }
      throw new BookingError(
        settled.outcome === 'failed'
          ? `Funding ${commitmentId} failed, and the lock holds no reserve for it: ${what}`
          : `Whether ${commitmentId} was funded is unknown: ${what}`,
        settled.outcome,
        approved,
        hashes,
        { cause: failure ?? undefined },
      )
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
