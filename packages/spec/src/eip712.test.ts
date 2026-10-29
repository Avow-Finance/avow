import { type Hex, hashTypedData } from 'viem'
import { describe, expect, it } from 'vitest'
import { testnetDemoTerms } from './demo.js'
import {
  type Acceptance,
  type ApiRequest,
  type Approval,
  type AvowTypedData,
  acceptanceTypedData,
  apiRequestTypedData,
  approvalDigest,
  approvalTypedData,
  businessActionTypedData,
  type ChargeReport,
  checkEnvelope,
  commitmentKey,
  contestAction,
  digestOf,
  domain,
  evidenceTypedData,
  type HumanApproval,
  humanApprovalTypedData,
  isSignedBy,
  type MessageType,
  mandateHash,
  mandateTypedData,
  messageKey,
  type ReleaseConsent,
  releaseConsentTypedData,
  reportTypedData,
  type StartReceipt,
  type SupplierAction,
  type SupplierAuthorization,
  type SupplierEvidence,
  startReceiptTypedData,
  supplierActionTypedData,
  supplierAuthorizationTypedData,
  type TermsAgreement,
  type Timestamp,
  termsAgreementTypedData,
  timestampTypedData,
} from './eip712.js'
import { lockTerms, termsHash } from './terms.js'
import {
  ARBITER,
  CHAIN_ID,
  DOMAIN,
  demoMandate,
  id,
  LOCK,
  NOW,
  newKey,
  OTHER_LOCK,
  PAYEE,
  START,
  TOKEN,
} from './test-helpers.js'
import { isSupportedMessageVersion } from './version.js'

const SALT = `0x${'22'.repeat(32)}` as const
const admin = newKey()
const agent = newKey()
const mandate = demoMandate(admin.address, agent.address)
const terms = testnetDemoTerms(START, ARBITER)
const lock = lockTerms(terms, TOKEN.decimals)
const hash = termsHash(terms, SALT)
const mHash = mandateHash(mandate, DOMAIN)

const agreement: TermsAgreement = {
  commitmentId: id('commitment-1'),
  termsHash: hash,
  category: 'compute',
  buyerBusinessId: 'biz_buyer',
  supplierBusinessId: 'biz_supplier',
  mandateHash: mHash,
  nonce: 7n,
  expiry: NOW + 600n,
}

const supplierAccount = newKey()
const supplierSigner = newKey()

const approval: Approval = {
  commitmentId: id('commitment-1'),
  side: 'buyer',
  token: TOKEN.token,
  amount: lock.amount,
  supplier: supplierAccount.address,
  supplierSigner: supplierSigner.address,
  payee: PAYEE,
  freeCancelBy: lock.freeCancelBy,
  acceptBy: lock.acceptBy,
  chargeDeadline: lock.chargeDeadline,
  releaseDate: lock.releaseDate,
  contestWindow: lock.contestWindow,
  charges: lock.charges,
  day90SupplierShareBps: 5000,
  arbiter: ARBITER,
  termsHash: hash,
  mandateHash: mHash,
  capPerCommitment: mandate.capPerCommitment,
  capOpenReserves: mandate.capOpenReserves,
  fundingKey: agent.address,
  nonce: 8n,
  expiry: NOW + 300n,
}

const acceptance: Acceptance = {
  commitmentId: id('commitment-1'),
  side: 'buyer',
  approvalHash: approvalDigest(approval, DOMAIN),
  termsHash: hash,
  amount: lock.amount,
  token: TOKEN.token,
  acceptBy: lock.acceptBy,
  nonce: 12n,
  expiry: NOW + 600n,
}

const chargeReport: ChargeReport = {
  commitmentId: id('commitment-1'),
  side: 'buyer',
  kind: 'lateCancellation',
  amount: 250_000_000n,
  evidenceHash: id('late cancellation evidence'),
  nonce: 13n,
  expiry: NOW + 600n,
}

const consent: ReleaseConsent = {
  commitmentId: id('commitment-1'),
  side: 'buyer',
  reportCount: 0,
  reason: 'kept',
  evidenceHash: id('kept'),
  nonce: 14n,
  expiry: NOW + 600n,
}

const supplierEvidence: SupplierEvidence = {
  commitmentId: id('commitment-1'),
  side: 'buyer',
  number: 2,
  evidenceHash: id('supplier evidence'),
  nonce: 15n,
  expiry: NOW + 600n,
}

const contest = contestAction({
  commitmentId: id('commitment-1'),
  reportNumber: 1,
  reasonCode: 3,
  statementHash: id('contest statement'),
  nonce: 16n,
  expiry: NOW + 600n,
})

const withdrawal: SupplierAction = {
  supplier: supplierAccount.address,
  action: 'withdrawReport',
  commitmentId: id('commitment-1'),
  side: 'buyer',
  reportNumber: 1,
  nonce: 17n,
  expiry: NOW + 600n,
}

const authorization: SupplierAuthorization = {
  commitmentId: id('commitment-1'),
  termsHash: hash,
  salt: SALT,
  amount: lock.amount,
  token: TOKEN.token,
  buyerBusinessId: 'biz_buyer',
  kybReference: 'mock-kyb-1',
  kybTestData: true,
  agentKey: agent.address,
  agentKeyAuthorizedIn: id('key authorization tx'),
  mandateHash: mHash,
  payee: PAYEE,
  acceptBy: lock.acceptBy,
  chargeDeadline: lock.chargeDeadline,
  releaseDate: lock.releaseDate,
  nonce: 9n,
  expiry: NOW + 300n,
}

const human: HumanApproval = {
  mandateHash: mHash,
  commitmentId: id('commitment-1'),
  termsHash: hash,
  supplier: 'biz_supplier',
  payee: PAYEE,
  amount: lock.amount,
  nonce: 10n,
  expiry: NOW + 900n,
}

const receipt: StartReceipt = {
  commitmentId: id('commitment-1'),
  side: 'buyer',
  startRequestHash: id('start-request'),
  startedAt: START + 30n,
  nonce: 11n,
  expiry: START + 3600n,
}

const apiRequest: ApiRequest = {
  audience: 'https://api.testnet.avow.finance',
  method: 'POST',
  path: '/v1/reserve-approvals',
  bodyHash: id('body'),
  signer: agent.address,
  requestId: id('request-1'),
  expiry: NOW + 120n,
}

const stamp: Timestamp = {
  requestHash: id('start-request'),
  receivedAt: START + 12n,
}

const OTHER_DOMAIN = { chainId: CHAIN_ID, verifyingContract: OTHER_LOCK }

const builders = {
  mandate: (d = DOMAIN) => mandateTypedData(mandate, d),
  agreement: (d = DOMAIN) => termsAgreementTypedData(agreement, d),
  approval: (d = DOMAIN) => approvalTypedData(approval, d),
  authorization: (d = DOMAIN) => supplierAuthorizationTypedData(authorization, d),
  human: (d = DOMAIN) => humanApprovalTypedData(human, d),
  receipt: (d = DOMAIN) => startReceiptTypedData(receipt, d),
  request: (d = DOMAIN) => apiRequestTypedData(apiRequest, d),
  timestamp: (d = DOMAIN) => timestampTypedData(stamp, d),
  acceptance: (d = DOMAIN) => acceptanceTypedData(acceptance, d),
  report: (d = DOMAIN) => reportTypedData(chargeReport, d),
  consent: (d = DOMAIN) => releaseConsentTypedData(consent, d),
  evidence: (d = DOMAIN) => evidenceTypedData(supplierEvidence, d),
  contest: (d = DOMAIN) => businessActionTypedData(contest, d),
  withdrawal: (d = DOMAIN) => supplierActionTypedData(withdrawal, d),
}

/** Signs the EIP-712 digest, which is what signTypedData signs. A test below checks they match. */
function sign(td: AvowTypedData): Promise<Hex> {
  return admin.sign({ hash: digestOf(td) })
}

describe('signed messages', () => {
  it("signs the same bytes as viem's signTypedData", async () => {
    const td = approvalTypedData(approval, DOMAIN)
    expect(await sign(td)).toBe(await admin.signTypedData(td))
  })

  for (const [name, build] of Object.entries(builders)) {
    it(`${name}: verifies for its signer and nobody else`, async () => {
      const td = build()
      const sig = await sign(td)
      expect(await isSignedBy(td, sig, admin.address)).toBe(true)
      expect(await isSignedBy(td, sig, agent.address)).toBe(false)
    })

    it(`${name}: fails on another chain, lock or schema version`, async () => {
      const sig = await sign(build())
      const otherChain = build({ chainId: CHAIN_ID + 1, verifyingContract: LOCK })
      const otherLock = build({ chainId: CHAIN_ID, verifyingContract: OTHER_LOCK })
      const otherVersion = { ...build(), domain: domain(DOMAIN, '2') }
      expect(await isSignedBy(otherChain, sig, admin.address)).toBe(false)
      expect(await isSignedBy(otherLock, sig, admin.address)).toBe(false)
      expect(await isSignedBy(otherVersion, sig, admin.address)).toBe(false)
    })

    it(`${name}: digest matches viem's EIP-712 hash`, () => {
      const td = build()
      expect(digestOf(td)).toBe(hashTypedData(td as Parameters<typeof hashTypedData>[0]))
    })
  }

  describe('the fields each message signs', () => {
    // One message of each type with the value it was built from, keyed by type, so a new type
    // without a sample fails the type check. Each value is typed as its interface, which has no
    // optional fields, so its keys are the interface's keys.
    const samples: { [T in MessageType]: { typedData: AvowTypedData; from: object } } = {
      Mandate: { typedData: builders.mandate(), from: mandate },
      TermsAgreement: { typedData: builders.agreement(), from: agreement },
      Approval: { typedData: builders.approval(), from: approval },
      SupplierAuthorization: { typedData: builders.authorization(), from: authorization },
      HumanApproval: { typedData: builders.human(), from: human },
      StartReceipt: { typedData: builders.receipt(), from: receipt },
      ApiRequest: { typedData: builders.request(), from: apiRequest },
      Timestamp: { typedData: builders.timestamp(), from: stamp },
      Acceptance: { typedData: builders.acceptance(), from: acceptance },
      Report: { typedData: builders.report(), from: chargeReport },
      ReleaseConsent: { typedData: builders.consent(), from: consent },
      Evidence: { typedData: builders.evidence(), from: supplierEvidence },
      BusinessAction: { typedData: builders.contest(), from: contest },
      SupplierAction: { typedData: builders.withdrawal(), from: withdrawal },
    }
    /** The field names one struct of a message's table lists, sorted. */
    const names = (td: AvowTypedData, struct: string) =>
      ((td.types as Record<string, readonly { name: string }[]>)[struct] ?? [])
        .map((f) => f.name)
        .sort()
    const keys = (value: object | undefined) => Object.keys(value ?? {}).sort()

    for (const [type, { typedData, from }] of Object.entries(samples)) {
      it(`${type}: its table lists every field its interface holds, and the message carries each`, () => {
        expect(typedData.primaryType).toBe(type)
        const table = names(typedData, type)
        expect(table.length).toBeGreaterThan(0)
        // The mandate's approval rule is written as two fields, its kind and an above rule's amount.
        const fields = Object.keys(from).concat(type === 'Mandate' ? ['approvalAbove'] : [])
        expect(fields.sort()).toEqual(table)
        expect(keys(typedData.message)).toEqual(table)
      })
    }

    it('lists every field of the structs a message nests', () => {
      const m = builders.mandate()
      expect(keys(mandate.paymentLimits[0])).toEqual(names(m, 'PaymentLimit'))
      expect(keys(m.message.paymentLimits[0])).toEqual(names(m, 'PaymentLimit'))
      const a = builders.approval()
      expect(keys(approval.charges[0])).toEqual(names(a, 'Charge'))
      expect(keys(a.message.charges[0])).toEqual(names(a, 'Charge'))
    })
  })

  it("fails when any field of the supplier's authorization changes (acceptance test 8)", async () => {
    const td = supplierAuthorizationTypedData(authorization, DOMAIN)
    const sig = await admin.signTypedData(td)
    const changed: Partial<SupplierAuthorization>[] = [
      { commitmentId: id('commitment-2') },
      { termsHash: id('other terms') },
      { salt: `0x${'33'.repeat(32)}` },
      { amount: authorization.amount - 1n },
      { token: '0x20c0000000000000000000000000000000000002' },
      { buyerBusinessId: 'biz_other' },
      { kybReference: 'mock-kyb-2' },
      { kybTestData: false },
      { agentKey: admin.address },
      { agentKeyAuthorizedIn: id('another tx') },
      { mandateHash: id('other mandate') },
      { payee: '0x000000000000000000000000000000000000dead' },
      { acceptBy: authorization.acceptBy + 1n },
      { chargeDeadline: authorization.chargeDeadline + 1n },
      { releaseDate: authorization.releaseDate + 1n },
      { nonce: authorization.nonce + 1n },
      { expiry: authorization.expiry + 1n },
    ]
    for (const change of changed) {
      const altered = supplierAuthorizationTypedData({ ...authorization, ...change }, DOMAIN)
      expect(await isSignedBy(altered, sig, admin.address)).toBe(false)
    }
  })

  it('returns false for a message EIP-712 cannot encode', async () => {
    const td = supplierAuthorizationTypedData({ ...authorization, expiry: 2n ** 64n }, DOMAIN)
    const sig = await sign(supplierAuthorizationTypedData(authorization, DOMAIN))
    expect(await isSignedBy(td, sig, admin.address)).toBe(false)
  })

  it('returns false for a malformed signature', async () => {
    expect(await isSignedBy(builders.approval(), '0x1234' as Hex, admin.address)).toBe(false)
  })

  it('hands the digest to a custom check, for passkey and admin-key signatures', async () => {
    const td = builders.approval()
    let seen: Hex | undefined
    const ok = await isSignedBy(td, '0xabcd', admin.address, async ({ digest }) => {
      seen = digest
      return true
    })
    expect(ok).toBe(true)
    expect(seen).toBe(digestOf(td))
  })
})

describe("what the supplier's acceptance and consent bind", () => {
  const [late, noShow] = approval.charges
  if (!late || !noShow) throw new Error('the approval fixture has two charges')
  // Every field of the approval, changed to another valid value.
  const changes: Partial<Approval>[] = [
    { commitmentId: id('commitment-2') },
    { side: 'supplier' },
    { token: '0x20c0000000000000000000000000000000000002' },
    { amount: approval.amount + 1n },
    { supplier: PAYEE },
    { supplierSigner: PAYEE },
    { payee: ARBITER },
    { freeCancelBy: approval.freeCancelBy + 1n },
    { acceptBy: approval.acceptBy + 1n },
    { chargeDeadline: approval.chargeDeadline + 1n },
    { releaseDate: approval.releaseDate + 1n },
    { contestWindow: approval.contestWindow + 1n },
    { charges: [{ ...late, most: late.most - 1n }, noShow] },
    { charges: [late, { ...noShow, earliest: noShow.earliest + 1n }] },
    { charges: [late] },
    { day90SupplierShareBps: 5001 },
    { arbiter: PAYEE },
    { termsHash: id('other terms') },
    { mandateHash: id('other mandate') },
    { capPerCommitment: approval.capPerCommitment + 1n },
    { capOpenReserves: approval.capOpenReserves + 1n },
    { fundingKey: PAYEE },
    { nonce: approval.nonce + 1n },
    { expiry: approval.expiry + 1n },
  ]

  it('the approval digest changes with every term, the chain and the lock', () => {
    const digest = approvalDigest(approval, DOMAIN)
    expect(Object.keys(approval)).toHaveLength(22)
    const seen = new Set([digest])
    for (const change of changes) seen.add(approvalDigest({ ...approval, ...change }, DOMAIN))
    seen.add(approvalDigest(approval, OTHER_DOMAIN))
    seen.add(approvalDigest(approval, { chainId: CHAIN_ID + 1, verifyingContract: LOCK }))
    expect(seen.size).toBe(changes.length + 3)
  })

  it('an acceptance signed for one approval fails for any other', async () => {
    const signature = await sign(acceptanceTypedData(acceptance, DOMAIN))
    for (const change of changes) {
      const other = {
        ...acceptance,
        approvalHash: approvalDigest({ ...approval, ...change }, DOMAIN),
      }
      expect(await isSignedBy(acceptanceTypedData(other, DOMAIN), signature, admin.address)).toBe(
        false,
      )
    }
  })

  it('a consent signed for one report count fails for any other', async () => {
    const signature = await sign(releaseConsentTypedData(consent, DOMAIN))
    for (const reportCount of [1, 2, 255]) {
      const later = releaseConsentTypedData({ ...consent, reportCount }, DOMAIN)
      expect(await isSignedBy(later, signature, admin.address)).toBe(false)
    }
  })
})

describe('mandateHash', () => {
  it('binds the mandate to its chain and lock', () => {
    expect(mandateHash(mandate, { chainId: CHAIN_ID + 1, verifyingContract: LOCK })).not.toBe(mHash)
    expect(mandateHash(mandate, { chainId: CHAIN_ID, verifyingContract: OTHER_LOCK })).not.toBe(
      mHash,
    )
  })

  it('changes when the limits change', () => {
    expect(mandateHash({ ...mandate, capPerCommitment: 1n }, DOMAIN)).not.toBe(mHash)
    expect(mandateHash({ ...mandate, suppliers: ['biz_other'] }, DOMAIN)).not.toBe(mHash)
    expect(mandateHash({ ...mandate, approvalRule: { kind: 'never' } }, DOMAIN)).not.toBe(mHash)
    expect(
      mandateHash({ ...mandate, approvalRule: { kind: 'above', amount: 1n } }, DOMAIN),
    ).not.toBe(mHash)
  })
})

describe('checkEnvelope', () => {
  const env = { type: 'Approval', schemaVersion: '1', chainId: CHAIN_ID, lock: LOCK } as const

  it('passes a known version, type, chain and lock', () => {
    expect(checkEnvelope(env, { type: 'Approval', chainId: CHAIN_ID, lock: LOCK })).toBeNull()
  })

  it('refuses an unknown schema version (acceptance test 5)', () => {
    expect(
      checkEnvelope({ ...env, schemaVersion: '2' }, { type: 'Approval', chainId: CHAIN_ID }),
    ).toBe('message.schema_unknown')
  })

  it('refuses a type named after something every object inherits, without throwing', () => {
    for (const type of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      const sent = { ...env, type: type as 'Approval' }
      expect(checkEnvelope(sent, { type: 'Approval', chainId: CHAIN_ID }), type).toBe(
        'message.schema_unknown',
      )
      expect(isSupportedMessageVersion(type, '1'), type).toBe(false)
    }
    expect(isSupportedMessageVersion('Approval', '1')).toBe(true)
  })

  it('refuses another message type, chain or lock', () => {
    expect(checkEnvelope(env, { type: 'SupplierAuthorization', chainId: CHAIN_ID })).toBe(
      'message.schema_unknown',
    )
    expect(checkEnvelope(env, { type: 'Approval', chainId: 1 })).toBe('message.wrong_chain')
    expect(checkEnvelope(env, { type: 'Approval', chainId: CHAIN_ID, lock: OTHER_LOCK })).toBe(
      'message.wrong_contract',
    )
  })
})

describe('replay keys', () => {
  it('give two messages two keys, whatever nonce their signers chose', () => {
    const a = messageKey(supplierAuthorizationTypedData(authorization, DOMAIN))
    const b = messageKey(
      supplierAuthorizationTypedData(
        { ...authorization, commitmentId: id('commitment-2') },
        DOMAIN,
      ),
    )
    expect(a).not.toBe(b)
    expect(a).toBe(messageKey(supplierAuthorizationTypedData(authorization, DOMAIN)))
    expect(
      messageKey(supplierAuthorizationTypedData(authorization, { ...DOMAIN, chainId: 1 })),
    ).not.toBe(a)
  })

  it('give one commitment one key per message type, whatever the case of its hex', () => {
    const k = commitmentKey('SupplierAuthorization', DOMAIN, id('commitment-1'))
    expect(
      commitmentKey(
        'SupplierAuthorization',
        { ...DOMAIN, verifyingContract: LOCK.toUpperCase().replace('0X', '0x') as Hex },
        id('commitment-1').toUpperCase().replace('0X', '0x') as Hex,
      ),
    ).toBe(k)
    expect(commitmentKey('StartReceipt', DOMAIN, id('commitment-1'))).not.toBe(k)
    expect(commitmentKey('SupplierAuthorization', OTHER_DOMAIN, id('commitment-1'))).not.toBe(k)
  })
})
