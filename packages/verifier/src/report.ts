import {
  type AvowDomain,
  CHARGE_KINDS,
  type ChargeKind,
  type ChargeReport,
  digestOf,
  type HashSigner,
  isKeySignature,
  MESSAGE_VERSIONS,
  type RailToken,
  REPORT_TYPES,
  type ReasonCode,
  reportTypedData,
  type Signed,
} from '@avow-finance/spec'
import { type Address, encodeFunctionData, type Hex, isAddressEqual, isHex, size } from 'viem'
import { same } from './authorization.js'
import { type ChainReader, MAX_REPORTS } from './chain.js'
import { type Disclosure, disclosureId, reportDisclosure } from './disclosure.js'
import { issue, wasIssued } from './issued.js'
import { randomNonce } from './nonce.js'

/** A report stays valid for ten minutes at most, and never past the charge deadline. */
export const REPORT_VALIDITY = 600n

export interface ReportConfig {
  chainId: number
  /** The supplier's signing key, which signs the report and which the lock has to hold. */
  signingKey: Address
  /** Tokens the supplier accepts, used to show the amount a report charges. */
  acceptedTokens: readonly RailToken[]
}

export interface ReportDeps {
  config: ReportConfig
  chain: ChainReader
}

/** What a supplier hands the verifier to get a report of a charge to sign. */
export interface ReportRequest {
  lock: Address
  commitmentId: Hex
  kind: ChargeKind
  /** Base units of the lock's token. The most the terms let this kind of charge take when left out. */
  amount?: bigint
  /** The keccak256 of the supplier's evidence for the charge. */
  evidenceHash: Hex
  /** The chain's time, which the lock judges a report's timing by. */
  now: bigint
  /** The report's nonce, a fresh random one when left out. */
  nonce?: bigint
}

export interface ReadyReport {
  ok: true
  report: ChargeReport
  domain: AvowDomain
  /** The digest the supplier's signing key signs. */
  digest: Hex
  /** The key that has to sign, the signing key the lock holds for the commitment. */
  signingKey: Address
  /** What to show the person who approves the signature, before signing. */
  disclosure: Disclosure
}

export type PreparedReport = ReadyReport | { ok: false; reason: ReasonCode }

const isBytes32 = (value: unknown): value is Hex => isHex(value) && size(value) === 32

/**
 * The supported way for a supplier to get a report of a charge to sign. A report asks the lock to
 * charge the business's reserve, so this builds one only when the lock would take it, and refuses
 * with the first reason that applies.
 *
 * 1. The lock comes from Avow's factory and holds the commitment with this supplier's signing key.
 * 2. The commitment is accepted with no report open, and it has fewer than two reports.
 * 3. Its terms carry a charge of the reported kind, and the amount, that charge's most when left
 *    out, is above zero and within it.
 * 4. The time is at or after that charge's earliest and before the charge deadline.
 *
 * What it returns is frozen, and `signReport` signs nothing else. The lock checks the signature
 * and the same rules when the report lands, so it takes a correctly signed report however it was
 * built.
 *
 * Throws when the chain reader is for another chain or the chain can't be read.
 */
export async function prepareReport(
  request: ReportRequest,
  deps: ReportDeps,
): Promise<PreparedReport> {
  const { config, chain } = deps
  if (chain.chainId !== config.chainId) {
    throw new Error(`The chain reader is for chain ${chain.chainId}, not ${config.chainId}`)
  }
  const refuse = (reason: ReasonCode): PreparedReport => ({ ok: false, reason })
  if (
    !Object.hasOwn(CHARGE_KINDS, request.kind) ||
    !isBytes32(request.commitmentId) ||
    !isBytes32(request.evidenceHash) ||
    (request.amount !== undefined && typeof request.amount !== 'bigint')
  ) {
    return refuse('message.invalid')
  }

  // The commitment on the lock, and the supplier's own signing key on it.
  const lockInfo = await chain.lock(request.lock)
  if (!lockInfo?.fromFactory) return refuse('chain.lock_unknown')
  const b = await chain.backing(request.lock, request.commitmentId, 'buyer')
  if (!b || b.state === 'none') return refuse('chain.reserve_missing')
  if (!isAddressEqual(b.supplierSigner, config.signingKey)) return refuse('chain.supplier_mismatch')

  // The lock takes a report only on an accepted commitment, one report at a time and two at most.
  if (b.state !== 'accepted') return refuse('report.not_reportable')
  if (b.hasReport) return refuse('report.open')
  if (b.reportCount >= MAX_REPORTS) return refuse('report.limit_reached')

  // The charge the terms set for this kind, its most and its window.
  const charge = b.charges.find((c) => c.kind === request.kind)
  if (!charge) return refuse('report.kind_not_allowed')
  const amount = request.amount ?? charge.most
  if (amount <= 0n || amount > charge.most) return refuse('report.amount_invalid')
  if (request.now < charge.earliest) return refuse('report.too_early')
  if (request.now >= b.chargeDeadline) return refuse('commitment.ended')

  const latest = request.now + REPORT_VALIDITY
  const report: ChargeReport = {
    commitmentId: request.commitmentId,
    side: 'buyer',
    kind: request.kind,
    amount,
    evidenceHash: request.evidenceHash,
    nonce: request.nonce ?? randomNonce(),
    expiry: latest < b.chargeDeadline ? latest : b.chargeDeadline,
  }
  const d: AvowDomain = { chainId: config.chainId, verifyingContract: request.lock }
  const digest = digestOf(reportTypedData(report, d))
  const token = config.acceptedTokens.find(
    (t) => t.chainId === config.chainId && isAddressEqual(t.token, lockInfo.token),
  )
  return issue({
    ok: true,
    report,
    domain: d,
    digest,
    signingKey: config.signingKey,
    disclosure: reportDisclosure({
      digest,
      report,
      lock: request.lock,
      chainId: config.chainId,
      account: lockInfo.account,
      payee: b.payee,
      token: token ?? null,
      chargeDeadline: b.chargeDeadline,
      contestWindow: b.contestWindow,
      day90SupplierShareBps: b.day90SupplierShareBps,
      timing: lockInfo.timing,
      reportCount: b.reportCount,
    }),
  })
}

/**
 * Signs a report with the supplier's signing key, once the person has seen its disclosure. It
 * signs only the object `prepareReport` returned, which is frozen, so a copy or an edit of it
 * throws. It also throws when the confirmation names another disclosure, or when the key isn't
 * the signing key the lock holds for the commitment.
 */
export async function signReport(
  prepared: ReadyReport,
  key: HashSigner,
  confirmation: { disclosureId: Hex },
): Promise<Signed<ChargeReport>> {
  if (!wasIssued(prepared)) {
    throw new Error('Sign only the report prepareReport returned, as it returned it')
  }
  const digest = digestOf(reportTypedData(prepared.report, prepared.domain))
  const { disclosure } = prepared
  if (
    !same(digest, prepared.digest) ||
    !same(disclosure.digest, digest) ||
    !same(disclosureId(disclosure), disclosure.id)
  ) {
    throw new Error('The report or its disclosure changed after prepareReport built them')
  }
  if (!same(confirmation?.disclosureId, disclosure.id)) {
    throw new Error(
      "Show the person this report's disclosure, and pass its id back once they confirm it",
    )
  }
  const signature = await key.sign({ hash: digest })
  if (!isKeySignature(digest, signature, prepared.signingKey)) {
    throw new Error("The key that signed isn't the signing key the lock holds for the commitment")
  }
  return {
    type: 'Report',
    schemaVersion: MESSAGE_VERSIONS.Report,
    chainId: prepared.domain.chainId,
    lock: prepared.domain.verifyingContract,
    message: prepared.report,
    signature,
  }
}

/**
 * The lock's `report`, as the testnet lock declares it. The report's fields come from the spec's
 * `REPORT_TYPES`, so the call carries the fields the signature covers, in the same order. Anyone
 * can send it, since the lock checks the supplier's signing key signed the report, so a supplier
 * can send it from any account that pays the fee.
 */
export const REPORT_ABI = [
  {
    type: 'function',
    name: 'report',
    inputs: [
      { name: 'm', type: 'tuple', components: REPORT_TYPES.Report },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const

/**
 * The call that hands a signed report to its lock, with the fields exactly as they were signed, so
 * the lock checks the same digest the supplier's key signed.
 */
export function reportCall(report: Signed<ChargeReport>): { to: Address; data: Hex } {
  const d: AvowDomain = { chainId: report.chainId, verifyingContract: report.lock }
  return {
    to: report.lock,
    data: encodeFunctionData({
      abi: REPORT_ABI,
      functionName: 'report',
      args: [reportTypedData(report.message, d).message, report.signature],
    }),
  }
}
