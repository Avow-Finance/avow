import { type Hex, hashTypedData } from 'viem'
import { describe, expect, it } from 'vitest'
import { testnetDemoTerms } from './demo.js'
import {
  type Approval,
  type AvowTypedData,
  approvalTypedData,
  checkEnvelope,
  commitmentKey,
  digestOf,
  domain,
  type HumanApproval,
  humanApprovalTypedData,
  isSignedBy,
  mandateHash,
  mandateTypedData,
  messageKey,
  type StartReceipt,
  type SupplierAuthorization,
  startReceiptTypedData,
  supplierAuthorizationTypedData,
  type TermsAgreement,
  termsAgreementTypedData,
} from './eip712.js'
import { termsHash } from './terms.js'
import {
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

const SALT = `0x${'22'.repeat(32)}` as const
const admin = newKey()
const agent = newKey()
const mandate = demoMandate(admin.address, agent.address)
const terms = testnetDemoTerms(START)
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

const approval: Approval = {
  commitmentId: id('commitment-1'),
  side: 'buyer',
  token: TOKEN.token,
  amount: terms.reserve,
  payee: PAYEE,
  acceptBy: terms.acceptBy,
  chargeDeadline: terms.chargeDeadline,
  contestWindow: terms.contestWindow,
  releaseDate: terms.releaseDate,
  termsHash: hash,
  mandateHash: mHash,
  capPerCommitment: mandate.capPerCommitment,
  capOpenReserves: mandate.capOpenReserves,
  fundingKey: agent.address,
  nonce: 8n,
  expiry: NOW + 300n,
}

const authorization: SupplierAuthorization = {
  commitmentId: id('commitment-1'),
  termsHash: hash,
  salt: SALT,
  amount: terms.reserve,
  token: TOKEN.token,
  buyerBusinessId: 'biz_buyer',
  kybReference: 'mock-kyb-1',
  kybTestData: true,
  agentKey: agent.address,
  agentKeyAuthorizedIn: id('key authorization tx'),
  mandateHash: mHash,
  payee: PAYEE,
  acceptBy: terms.acceptBy,
  chargeDeadline: terms.chargeDeadline,
  releaseDate: terms.releaseDate,
  nonce: 9n,
  expiry: NOW + 300n,
}

const human: HumanApproval = {
  mandateHash: mHash,
  commitmentId: id('commitment-1'),
  termsHash: hash,
  supplier: 'biz_supplier',
  payee: PAYEE,
  amount: terms.reserve,
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

const OTHER_DOMAIN = { chainId: CHAIN_ID, verifyingContract: OTHER_LOCK }

const builders = {
  mandate: (d = DOMAIN) => mandateTypedData(mandate, d),
  agreement: (d = DOMAIN) => termsAgreementTypedData(agreement, d),
  approval: (d = DOMAIN) => approvalTypedData(approval, d),
  authorization: (d = DOMAIN) => supplierAuthorizationTypedData(authorization, d),
  human: (d = DOMAIN) => humanApprovalTypedData(human, d),
  receipt: (d = DOMAIN) => startReceiptTypedData(receipt, d),
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
