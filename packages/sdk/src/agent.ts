import {
  type Approval,
  type AvowDomain,
  approvalTermsProblem,
  checkEnvelope,
  digestOf,
  type GpuReservationInput,
  gpuReservationTerms,
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
  type Terms,
  type TermsAgreement,
  type TermsProfile,
  termsAgreementTypedData,
  termsHash,
  toTokenUnits,
  validateTerms,
} from '@avow-finance/spec'
import { type LockedBacking, readBacking } from '@avow-finance/verifier'
import {
  type Chain,
  type Client,
  type Hex,
  hexToBigInt,
  isAddressEqual,
  recoverAddress,
  type Transport,
  toHex,
} from 'viem'
import type { Account as TempoAccount } from 'viem/tempo'
import type { AvowApi } from './avow-api.js'
import { type Call, reserveCalls } from './lock.js'
import { type SendLimits, sendSponsored } from './send.js'
import type { SupplierConnection } from './supplier.js'

/** An agent's access key on its business account, as Tempo signs with it. */
export type AgentKey = TempoAccount.AccessKeyAccount

export interface AgentConfig {
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
  avow: AvowApi
  /** How long, in seconds, an offer stays open for the supplier and Avow. Ten minutes by default. */
  offerValidity?: bigint
  /** The clock, in unix seconds. The system clock by default. */
  now?: () => bigint
  /**
   * Sends the transaction that funds a reserve. By default the key signs it and Avow's relay
   * pays its fee, through `sendSponsored`. An agent whose wallet pays its own fees, or a test,
   * passes its own.
   */
  send?: (calls: Call[]) => Promise<{ transactionHash: Hex }>
  limits?: SendLimits
}

/** One booking the agent makes with one supplier. */
export interface Booking {
  supplier: SupplierConnection
  /** What the booking states, which the GPU reservation template turns into terms. */
  booking: GpuReservationInput
  /** The mandate category the booking falls under, such as `compute`. */
  category: string
}

/** A commitment the agent made and funded. */
export interface Commitment {
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
  /** The transaction that funded the reserve. */
  reservedIn: Hex
}

/** A booking's outcome. A refusal carries the reason code, and Avow's decision id once it decided. */
export type BookResult =
  | { ok: true; commitment: Commitment }
  | { ok: false; reason: ReasonCode; decisionId?: string }

const randomUint = () => hexToBigInt(toHex(crypto.getRandomValues(new Uint8Array(16))))
const systemClock = () => BigInt(Math.floor(Date.now() / 1000))

/**
 * An agent that makes commitments under its mandate. It agrees terms with a supplier, asks Avow to
 * approve the reserve, checks Avow's approval against the terms before any money moves, and funds
 * the reserve from the business's account with its own key while Avow's relay pays the fee.
 */
export function createAgent(config: AgentConfig) {
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
  const permits = (action: Mandate['actions'][number]) => mandate.actions.includes(action)
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
   * enforces what the approval says, so the agent funds only an approval that says exactly what
   * the terms and the mandate do, the same checks a supplier's verifier makes before it accepts.
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
    const s = expected.supplier
    if (
      !isAddressEqual(a.supplier, s.account) ||
      !isAddressEqual(a.supplierSigner, s.signingKey) ||
      !isAddressEqual(a.payee, s.payee)
    ) {
      return 'approval.parties_mismatch'
    }
    if (!isAddressEqual(a.token, token.token)) return 'approval.terms_mismatch'
    const termsProblem = approvalTermsProblem(a, {
      lock: lockTerms(expected.terms, token.decimals),
      termsHash: expected.termsHash,
    })
    if (termsProblem) return termsProblem
    if (
      a.mandateHash.toLowerCase() !== mHash.toLowerCase() ||
      !isAddressEqual(a.fundingKey, key.accessKeyAddress) ||
      a.capPerCommitment !== toTokenUnits(mandate.capPerCommitment, token.decimals) ||
      a.capOpenReserves !== toTokenUnits(mandate.capOpenReserves, token.decimals)
    ) {
      return 'approval.mandate_mismatch'
    }
    return null
  }

  return {
    /** The business account the agent acts for. */
    account: mandate.account,
    /** The business's lock, where its reserves sit. */
    lock: d.verifyingContract,
    domain: d,
    mandateHash: mHash,

    /**
     * Books with a supplier and funds the reserve. It refuses, with a reason code, terms that
     * break their rules, a supplier signature from another key, Avow's refusal, and an approval
     * that differs from the terms or the mandate. It throws when a transaction fails.
     */
    async book(b: Booking): Promise<BookResult> {
      if (!permits('reserve')) return { ok: false, reason: 'mandate.action_not_permitted' }
      const terms = gpuReservationTerms(b.booking)
      const invalid = validateTerms(terms, config.profile)
      if (invalid) return { ok: false, reason: invalid }
      const supplier = b.supplier.profile
      const salt = newSalt()
      const commitmentId = toHex(crypto.getRandomValues(new Uint8Array(32)))
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
      const signer = await recoverAddress({ hash: digest, signature: supplierSignature }).catch(
        () => null,
      )
      if (!signer || !isAddressEqual(signer, supplier.signingKey)) {
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
        request: {
          commitmentId,
          agentKey: key.accessKeyAddress,
          supplier: supplier.businessId,
          payee: supplier.payee,
          category: b.category,
          terms,
        },
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
      const receipt = await send(reserveCalls(answer.approval, d))
      return {
        ok: true,
        commitment: {
          commitmentId,
          supplier,
          terms,
          salt,
          termsHash: tHash,
          agreement: signed,
          approval: answer.approval,
          reservedIn: receipt.transactionHash,
        },
      }
    },

    /**
     * Tells Avow the business cancels a commitment, which Avow timestamps. Before free
     * cancellation ends the reserve can go back in full, and after it a late cancellation charge
     * can apply.
     */
    async cancel(commitmentId: Hex) {
      if (!permits('cancel')) {
        return { ok: false as const, reason: 'mandate.action_not_permitted' as ReasonCode }
      }
      const { cancelledAt } = await avow.cancel({ commitmentId })
      return { ok: true as const, cancelledAt }
    },

    /**
     * Starts the job with the supplier. Avow timestamps the request, the supplier returns its
     * signed start receipt, and Avow records the start the kept booking rests on.
     */
    async start(commitmentId: Hex, supplier: SupplierConnection) {
      if (!permits('start')) {
        return { ok: false as const, reason: 'mandate.action_not_permitted' as ReasonCode }
      }
      const request = await avow.requestStart({ commitmentId })
      const receipt: Signed<StartReceipt> = await supplier.startJob({ commitmentId, ...request })
      await avow.recordStart({ commitmentId, receipt })
      return { ok: true as const, receipt }
    },

    /** What the lock holds for one of the business's commitments, or null when it holds nothing. */
    commitment(commitmentId: Hex): Promise<LockedBacking | null> {
      return readBacking(client, d.verifyingContract, commitmentId, 'buyer')
    },
  }
}

export type Agent = ReturnType<typeof createAgent>
