import type { Address } from 'viem'
import { describe, expect, it } from 'vitest'
import {
  type Acceptance,
  type Approval,
  acceptanceTypedData,
  approvalTypedData,
  businessActionTypedData,
  type ChargeReport,
  contestAction,
  digestOf,
  evidenceTypedData,
  type ReleaseConsent,
  releaseConsentTypedData,
  reportTypedData,
  type SupplierAction,
  type SupplierEvidence,
  supplierActionTypedData,
  supplierListAction,
} from './eip712.js'
import { id, LOCK } from './test-helpers.js'

/**
 * Fixed messages and the digests the lock contract computes for them. The lock's own tests check
 * the same messages against the same digests, so a change on either side that alters a signed
 * message fails both.
 */
const DOMAIN = { chainId: 42431, verifyingContract: LOCK }
const address = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}`

const approval: Approval = {
  commitmentId: id('vector commitment'),
  side: 'buyer',
  token: '0x20c0000000000000000000000000000000000001',
  amount: 500_000_000n,
  supplier: address(0xa1),
  supplierSigner: address(0xa2),
  payee: address(0xa3),
  freeCancelBy: 1_800_007_200n,
  acceptBy: 1_800_003_600n,
  chargeDeadline: 1_800_172_800n,
  releaseDate: 1_800_259_200n,
  contestWindow: 600n,
  charges: [
    { kind: 'lateCancellation', most: 250_000_000n, earliest: 1_800_007_200n },
    { kind: 'noShow', most: 500_000_000n, earliest: 1_800_086_400n },
  ],
  day90SupplierShareBps: 5000,
  arbiter: address(0xa4),
  termsHash: id('vector terms'),
  mandateHash: id('vector mandate'),
  capPerCommitment: 1_000_000_000n,
  capOpenReserves: 2_000_000_000n,
  fundingKey: address(0xa5),
  nonce: 1n,
  expiry: 1_800_001_800n,
}

const acceptance: Acceptance = {
  commitmentId: id('vector commitment'),
  side: 'buyer',
  termsHash: id('vector terms'),
  amount: 500_000_000n,
  token: '0x20c0000000000000000000000000000000000001',
  acceptBy: 1_800_003_600n,
  nonce: 2n,
  expiry: 1_800_003_000n,
}

const report: ChargeReport = {
  commitmentId: id('vector commitment'),
  side: 'buyer',
  kind: 'noShow',
  amount: 321_000_000n,
  evidenceHash: id('vector report evidence'),
  nonce: 3n,
  expiry: 1_800_090_000n,
}

const consent: ReleaseConsent = {
  commitmentId: id('vector commitment'),
  side: 'buyer',
  reason: 'supplierFailed',
  evidenceHash: id('vector consent evidence'),
  nonce: 4n,
  expiry: 1_800_090_000n,
}

const evidence: SupplierEvidence = {
  commitmentId: id('vector commitment'),
  side: 'buyer',
  number: 4,
  evidenceHash: id('vector supplier evidence'),
  nonce: 5n,
  expiry: 1_800_090_000n,
}

const contest = contestAction({
  commitmentId: id('vector commitment'),
  reportNumber: 2,
  reasonCode: 3,
  statementHash: id('vector statement'),
  nonce: 6n,
  expiry: 1_800_090_000n,
})

const approveSupplier = supplierListAction({
  supplier: address(0xa1),
  approve: true,
  changeCount: 7n,
  expiry: 1_800_090_000n,
})

const withdrawal: SupplierAction = {
  supplier: address(0xa1),
  action: 'withdrawReport',
  commitmentId: id('vector commitment'),
  side: 'buyer',
  reportNumber: 1,
  nonce: 8n,
  expiry: 1_800_090_000n,
}

describe("the lock's signed messages", () => {
  const digests = {
    Approval: digestOf(approvalTypedData(approval, DOMAIN)),
    Acceptance: digestOf(acceptanceTypedData(acceptance, DOMAIN)),
    Report: digestOf(reportTypedData(report, DOMAIN)),
    ReleaseConsent: digestOf(releaseConsentTypedData(consent, DOMAIN)),
    Evidence: digestOf(evidenceTypedData(evidence, DOMAIN)),
    'BusinessAction (contest)': digestOf(businessActionTypedData(contest, DOMAIN)),
    'BusinessAction (approve a supplier)': digestOf(
      businessActionTypedData(approveSupplier, DOMAIN),
    ),
    SupplierAction: digestOf(supplierActionTypedData(withdrawal, DOMAIN)),
  }

  it('hash to the digests the lock computes', () => {
    expect(digests).toEqual({
      Approval: '0x8c2d20a63420d1aafe8f5c7ae925ab730767f413ad665e34569c3f39e58f9597',
      Acceptance: '0xb75643cda4c68adf403598d2f3bb4729aa4a0acaed7d9226376d21cf3bda9fcc',
      Report: '0xdc356ee8e260fd0652d6ce0ee76ad6f24093475bf865ec5fe1633110358aef5f',
      ReleaseConsent: '0x64515772a12f085d62807f7904029b3496afcbfdb8e1ce432ff2e853a31140f7',
      Evidence: '0x0bf0efc44b0b6450dae37617d1575532ff731ba906d2667d4a941bd2d66c9fc6',
      'BusinessAction (contest)':
        '0x827daf481be7ef2b64d4661bbf842a24377d8b9218806cea423fb1757e70e9ef',
      'BusinessAction (approve a supplier)':
        '0x7077fc6f5c6305fa883ba5804470ffac52c7ada9059f25261640d9242daa5642',
      SupplierAction: '0xced3f725dfdae46fbb48c04a4baa5ff3d517e6ff5c2e32880eb00a4112f4dab6',
    })
  })
})
