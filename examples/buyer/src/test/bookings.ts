import type { Commitment } from '@avow-finance/sdk'
import {
  type Approval,
  approvalDigest,
  approvalTypedData,
  digestOf,
  gpuReservationTerms,
  lockTerms,
  MESSAGE_VERSIONS,
  type SupplierProfile,
  TEMPO_MODERATO,
  type TermsAgreement,
  termsAgreementTypedData,
  termsHash,
} from '@avow-finance/spec'
import type { LockedBacking } from '@avow-finance/verifier'
import { type Address, type Hex, keccak256, stringToHex, toHex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { quickstartBooking } from '../plan.js'

/** Bookings as `book` saves them, signed by keys made for the run and held only in memory. */

export const LOCK: Address = '0x00000000000000000000000000000000000010c4'
export const NOW = 1_800_000_000n
export const id = (label: string): Hex => keccak256(stringToHex(label))
const D = { chainId: TEMPO_MODERATO, verifyingContract: LOCK }
const ARBITER: Address = '0x000000000000000000000000000000000000a4b1'

const agent = privateKeyToAccount(generatePrivateKey())
const avow = privateKeyToAccount(generatePrivateKey())
const supplierKey = privateKeyToAccount(generatePrivateKey())
export const supplier: SupplierProfile = {
  businessId: 'biz_supplier',
  account: '0x00000000000000000000000000000000000000c1',
  payee: '0x00000000000000000000000000000000000000c1',
  signingKey: supplierKey.address.toLowerCase() as Address,
}

/** A booking the agent made `bookedAt`, funded in `reservedIn`, with the quickstart's terms. */
export async function fundedBooking(
  bookedAt = NOW,
  reservedIn: Hex | null = id('the reserve transaction'),
): Promise<Commitment> {
  const commitmentId = toHex(crypto.getRandomValues(new Uint8Array(32)))
  const terms = gpuReservationTerms(
    quickstartBooking({
      now: bookedAt,
      startsIn: 720n,
      minutes: 30n,
      reserve: 500_000_000n,
      arbiter: ARBITER,
      day90SupplierShareBps: 5000,
    }),
  )
  const salt = toHex(crypto.getRandomValues(new Uint8Array(32)))
  const tHash = termsHash(terms, salt)
  const mandateHash = id('the mandate')
  const agreement: TermsAgreement = {
    commitmentId,
    termsHash: tHash,
    category: 'compute',
    buyerBusinessId: 'biz_buyer',
    supplierBusinessId: supplier.businessId,
    mandateHash,
    nonce: 9n,
    expiry: bookedAt + 600n,
  }
  const agreed = digestOf(termsAgreementTypedData(agreement, D))
  const approval: Approval = {
    commitmentId,
    token: '0x20c0000000000000000000000000000000000001',
    ...lockTerms(terms, 6),
    supplier: supplier.account,
    supplierSigner: supplier.signingKey,
    payee: supplier.payee,
    termsHash: tHash,
    mandateHash,
    capPerCommitment: 500_000_000n,
    capOpenReserves: 1_500_000_000n,
    fundingKey: agent.address,
    nonce: 1n,
    expiry: bookedAt + 120n,
  }
  const envelope = { chainId: TEMPO_MODERATO, lock: LOCK }
  return {
    commitmentId,
    supplier,
    terms,
    salt,
    termsHash: tHash,
    agreement: {
      type: 'TermsAgreement',
      ...envelope,
      schemaVersion: MESSAGE_VERSIONS.TermsAgreement,
      message: agreement,
      buyerSignature: await agent.sign({ hash: agreed }),
      supplierSignature: await supplierKey.sign({ hash: agreed }),
    },
    approval: {
      type: 'Approval',
      ...envelope,
      schemaVersion: MESSAGE_VERSIONS.Approval,
      message: approval,
      signature: await avow.sign({ hash: digestOf(approvalTypedData(approval, D)) }),
    },
    reservedIn,
  }
}

/** What the lock holds for a booking, accepted by the supplier unless a test changes it. */
export function heldFor(booking: Commitment, change: Partial<LockedBacking> = {}): LockedBacking {
  const a = booking.approval.message
  return {
    state: 'accepted',
    token: a.token,
    amount: a.amount,
    held: a.amount,
    payee: a.payee,
    supplier: a.supplier,
    supplierSigner: a.supplierSigner,
    freeCancelBy: a.freeCancelBy,
    acceptBy: a.acceptBy,
    chargeDeadline: a.chargeDeadline,
    contestWindow: a.contestWindow,
    releaseDate: a.releaseDate,
    charges: a.charges,
    day90SupplierShareBps: a.day90SupplierShareBps,
    arbiter: a.arbiter,
    termsHash: a.termsHash,
    mandateHash: a.mandateHash,
    approvalHash: approvalDigest(a, D),
    fundingKey: a.fundingKey,
    reportCount: 0,
    hasReport: false,
    hasRuling: false,
    ...change,
  }
}
