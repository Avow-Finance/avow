import {
  type Approval,
  type AvowDomain,
  approvalDigest,
  approvalTypedData,
  digestOf,
  dollars,
  type GpuReservationInput,
  lockTerms,
  type Mandate,
  MESSAGE_VERSIONS,
  mandateHash,
  type RailToken,
  type ReasonCode,
  type Signed,
  type StartReceipt,
  type SupplierProfile,
  startReceiptTypedData,
  termsAgreementTypedData,
  termsHash,
  toTokenUnits,
} from '@avow-finance/spec'
import { type Address, type Hex, keccak256, stringToHex, zeroAddress } from 'viem'
import { generatePrivateKey, type PrivateKeyAccount, privateKeyToAccount } from 'viem/accounts'
import { Account } from 'viem/tempo'
import type { AvowApi, ReserveApprovalRequest } from '../avow-api.js'
import { accountSigner, signMandate } from '../sign.js'
import type { SupplierConnection } from '../supplier.js'

/*
 * What the SDK's tests share: a business account with an agent key and a signed mandate, a
 * supplier, and an Avow that approves as the API does. Every key is generated for the run and held
 * only in memory.
 */

export const id = (label: string) => keccak256(stringToHex(label))
export const LOCK: Address = '0x00000000000000000000000000000000000010c4'
export const CHAIN_ID = 42431
export const D: AvowDomain = { chainId: CHAIN_ID, verifyingContract: LOCK }
export const TOKEN: RailToken = {
  rail: 'tempo',
  chainId: CHAIN_ID,
  token: '0x20c0000000000000000000000000000000000001',
  currency: 'USD',
  decimals: 6,
}
export const NOW = 1_800_000_000n
export const START = NOW + 3600n
export const ARBITER: Address = '0x000000000000000000000000000000000000a4b1'
const ZERO_HASH: Hex = `0x${'00'.repeat(32)}`

/** A booking on testnet timing: a 30-minute window an hour away, with two minutes of grace. */
export function gpuBooking(change: Partial<GpuReservationInput> = {}): GpuReservationInput {
  return {
    resource: { gpu: 'H100', count: 8, region: 'demo', sku: 'demo-h100x8' },
    currency: 'USD',
    windowStart: START,
    windowDuration: 1800n,
    pricePerGpuHour: dollars(3),
    freeCancelBy: START - 600n,
    lateCancellation: dollars(250),
    noShow: dollars(500),
    gracePeriod: 120n,
    chargeDeadline: START + 1800n,
    contestWindow: 600n,
    releaseDate: START + 1800n,
    arbiter: ARBITER,
    day90SupplierShareBps: 5000,
    ...change,
  }
}

/**
 * The lock's record of a commitment as its `commitment` view returns it: a fresh reserve under the
 * approval, or the empty record when it holds nothing.
 */
export function lockRecord(approval: Approval | null) {
  const a = approval
  const zeros = [0n, 0n, 0n, 0n] as const
  return {
    state: a ? 1 : 0,
    hasReport: false,
    reportFinal: false,
    confirmed: false,
    contested: false,
    hasRuling: false,
    kinds: 0,
    reportKind: 0,
    reportCount: 0,
    pausedBy: 0,
    day90ShareBps: a?.day90SupplierShareBps ?? 0,
    businessEvidence: 0,
    supplierEvidence: 0,
    freeCancelBy: a?.freeCancelBy ?? 0n,
    acceptBy: a?.acceptBy ?? 0n,
    chargeDeadline: a?.chargeDeadline ?? 0n,
    releaseDate: a?.releaseDate ?? 0n,
    contestWindow: a?.contestWindow ?? 0n,
    reportDeadline: 0n,
    chargeStart: 0n,
    pausedAt: 0n,
    rulingPostedAt: 0n,
    reportedAt: 0n,
    amount: a?.amount ?? 0n,
    held: a?.amount ?? 0n,
    reportAmount: 0n,
    rulingToSupplier: 0n,
    supplier: a?.supplier ?? zeroAddress,
    supplierSigner: a?.supplierSigner ?? zeroAddress,
    payout: a?.payee ?? zeroAddress,
    arbiter: a?.arbiter ?? zeroAddress,
    rulingByArbiter: false,
    fundedBy: a?.fundingKey ?? zeroAddress,
    termsHash: a?.termsHash ?? ZERO_HASH,
    mandateHash: a?.mandateHash ?? ZERO_HASH,
    approvalHash: a ? approvalDigest(a, D) : ZERO_HASH,
    reportEvidence: ZERO_HASH,
    most: zeros,
    earliest: zeros,
    firstReportAt: zeros,
  }
}

/** The supplier's receipt for a start request, signed by `signer`, with one field changed if asked. */
export async function startReceipt(
  signer: PrivateKeyAccount,
  r: { commitmentId: Hex; startRequestHash: Hex; requestedAt: bigint },
  change: Partial<StartReceipt> = {},
  envelope: Partial<Signed<StartReceipt>> = {},
): Promise<Signed<StartReceipt>> {
  const message: StartReceipt = {
    commitmentId: r.commitmentId,
    side: 'buyer',
    startRequestHash: r.startRequestHash,
    startedAt: r.requestedAt + 1n,
    nonce: 1n,
    expiry: NOW + 600n,
    ...change,
  }
  return {
    type: 'StartReceipt',
    schemaVersion: MESSAGE_VERSIONS.StartReceipt,
    chainId: CHAIN_ID,
    lock: LOCK,
    message,
    signature: await signer.sign({ hash: digestOf(startReceiptTypedData(message, D)) }),
    ...envelope,
  }
}

export async function bookingFixture(options: { mandate?: Partial<Mandate> } = {}) {
  const root = Account.fromSecp256k1(generatePrivateKey())
  const agentKey = generatePrivateKey()
  const key = Account.fromSecp256k1(agentKey, { access: root })
  const avowKey = privateKeyToAccount(generatePrivateKey())
  const supplierAccount = privateKeyToAccount(generatePrivateKey())
  const supplierKey = privateKeyToAccount(generatePrivateKey())
  const supplier: SupplierProfile = {
    businessId: 'biz_supplier',
    account: supplierAccount.address,
    signingKey: supplierKey.address,
    payee: '0x000000000000000000000000000000000000beef',
  }
  const mandate: Mandate = {
    mandateId: id('mandate-1'),
    businessId: 'biz_buyer',
    agentId: 'agt_1',
    account: root.address,
    agentKey: key.accessKeyAddress,
    actions: ['reserve', 'cancel', 'start'],
    currency: 'USD',
    capPerCommitment: dollars(500),
    capOpenReserves: dollars(1500),
    suppliers: ['biz_supplier'],
    categories: ['compute'],
    paymentLimits: [{ token: TOKEN.token, amount: dollars(1500), period: 86_400n }],
    approvalRule: { kind: 'above', amount: dollars(800) },
    expiry: NOW + 86_400n,
    nonce: 1n,
    ...options.mandate,
  }
  const signedMandate = await signMandate(mandate, D, accountSigner(root.address, root))
  const mHash = mandateHash(mandate, D)

  const calls: string[] = []
  const requests: ReserveApprovalRequest[] = []
  const approvals: Signed<Approval>[] = []
  const hooks = {
    approvalChange: {} as Partial<Approval>,
    envelopeChange: {} as Partial<Signed<Approval>>,
    refusal: null as ReasonCode | null,
    startRefusal: null as ReasonCode | null,
    afterApproval: () => {},
    signAgreementWith: supplierKey,
    receipt: (r: { commitmentId: Hex; startRequestHash: Hex; requestedAt: bigint }) =>
      startReceipt(supplierKey, r),
  }

  /** Avow's approval as the API builds it, with the fields a test changes. */
  async function approve(r: ReserveApprovalRequest): Promise<Signed<Approval>> {
    const message: Approval = {
      commitmentId: r.request.commitmentId,
      token: TOKEN.token,
      ...lockTerms(r.request.terms, TOKEN.decimals),
      supplier: supplier.account,
      supplierSigner: supplier.signingKey,
      payee: r.request.payee,
      termsHash: termsHash(r.request.terms, r.salt),
      mandateHash: mHash,
      capPerCommitment: toTokenUnits(mandate.capPerCommitment, TOKEN.decimals),
      capOpenReserves: toTokenUnits(mandate.capOpenReserves, TOKEN.decimals),
      fundingKey: key.accessKeyAddress,
      nonce: 1n,
      expiry: NOW + 120n,
      ...hooks.approvalChange,
    }
    return {
      type: 'Approval',
      schemaVersion: MESSAGE_VERSIONS.Approval,
      chainId: CHAIN_ID,
      lock: LOCK,
      message,
      signature: await avowKey.sign({ hash: digestOf(approvalTypedData(message, D)) }),
      ...hooks.envelopeChange,
    }
  }

  // A stand-in that serves Avow's records of cancellations and starts, which the hosted API doesn't.
  const avow = {
    async approveReserve(r: ReserveApprovalRequest) {
      calls.push('approveReserve')
      requests.push(r)
      hooks.afterApproval()
      if (hooks.refusal) return { ok: false, decisionId: 'dec_1', reason: hooks.refusal }
      const approval = await approve(r)
      approvals.push(approval)
      return { ok: true, decisionId: 'dec_1', approval }
    },
    async sponsor(transaction: Hex) {
      calls.push('sponsor')
      return transaction
    },
    records: {
      async cancel() {
        calls.push('cancel')
        return { cancelledAt: NOW + 60n }
      },
      async requestStart({ commitmentId }: { commitmentId: Hex }) {
        calls.push('requestStart')
        return { startRequestHash: id(`start ${commitmentId}`), requestedAt: NOW + 120n }
      },
      async recordStart() {
        calls.push('recordStart')
        return hooks.startRefusal
          ? { ok: false as const, reason: hooks.startRefusal }
          : { ok: true as const }
      },
    },
  } satisfies AvowApi

  const connection: SupplierConnection = {
    profile: supplier,
    async signAgreement({ agreement, terms, salt, domain }) {
      calls.push('signAgreement')
      // The supplier checks the terms and salt give the hash it signs.
      if (termsHash(terms, salt) !== agreement.termsHash) throw new Error('wrong terms hash')
      return hooks.signAgreementWith.sign({
        hash: digestOf(termsAgreementTypedData(agreement, domain)),
      })
    },
    async startJob(r) {
      calls.push('startJob')
      return hooks.receipt(r)
    },
  }

  return {
    root,
    agentKey,
    key,
    avowKey,
    supplier,
    supplierKey,
    connection,
    mandate,
    signedMandate,
    mHash,
    avow,
    calls,
    requests,
    approvals,
    hooks,
  }
}

export type BookingFixture = Awaited<ReturnType<typeof bookingFixture>>
