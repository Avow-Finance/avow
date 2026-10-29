import { describe, expect, it } from 'vitest'
import {
  API_PATHS,
  parseApiError,
  parseEnrollment,
  parseEnrollmentRequest,
  parseReserveApproval,
  parseReserveApprovalRequest,
  parseSponsorshipRequest,
  parseSupplierAuthorizationAnswer,
} from './api.js'
import { testnetDemoTerms } from './demo.js'
import type { Approval, HumanApproval, SupplierAuthorization, TermsAgreement } from './eip712.js'
import { lockTerms, termsHash } from './terms.js'
import {
  ARBITER,
  CHAIN_ID,
  demoMandate,
  demoRequest,
  id,
  LOCK,
  NOW,
  newKey,
  OTHER_LOCK,
  PAYEE,
  START,
  TOKEN,
} from './test-helpers.js'
import { parseSignedAgreement, toWire } from './wire.js'

const roundTrip = (value: unknown) => JSON.parse(JSON.stringify(toWire(value)))
const SALT = `0x${'44'.repeat(32)}` as const
const SIG = `0x${'ab'.repeat(65)}` as const
const agent = newKey()
const terms = testnetDemoTerms(START, ARBITER)
const tHash = termsHash(terms, SALT)
const envelope = <T>(type: string, message: T, lock = LOCK) => ({
  type,
  schemaVersion: '1',
  chainId: CHAIN_ID,
  lock,
  message,
  signature: SIG,
})

const agreementMessage: TermsAgreement = {
  commitmentId: id('commitment-1'),
  termsHash: tHash,
  category: 'compute',
  buyerBusinessId: 'biz_buyer',
  supplierBusinessId: 'biz_supplier',
  mandateHash: id('mandate hash'),
  nonce: 7n,
  expiry: NOW + 600n,
}
const { signature: _, ...agreementEnvelope } = envelope('TermsAgreement', agreementMessage)
const agreement = { ...agreementEnvelope, buyerSignature: SIG, supplierSignature: SIG }

const human: HumanApproval = {
  mandateHash: id('mandate hash'),
  commitmentId: id('commitment-1'),
  termsHash: tHash,
  supplier: 'biz_supplier',
  payee: PAYEE,
  amount: 500_000_000n,
  nonce: 9n,
  expiry: NOW + 900n,
}

const request = {
  request: demoRequest(agent.address),
  salt: SALT,
  agreement,
  fundedBy: 'agent' as const,
}

describe('reserve approval requests', () => {
  it('round-trip with and without a human approval', () => {
    const plain = parseReserveApprovalRequest(roundTrip(request), { chainId: CHAIN_ID, lock: LOCK })
    expect(plain.ok).toBe(true)
    expect(plain.ok && plain.value.humanApproval).toBeUndefined()
    expect(plain.ok && plain.value.agreement.message.nonce).toBe(7n)
    const withHuman = parseReserveApprovalRequest(
      roundTrip({ ...request, humanApproval: envelope('HumanApproval', human) }),
      { chainId: CHAIN_ID, lock: LOCK },
    )
    expect(withHuman.ok && withHuman.value.humanApproval?.message.amount).toBe(500_000_000n)
  })

  it('refuses another chain or lock, an unknown field, a bad salt or a wrong funder', () => {
    const json = roundTrip(request)
    const here = { chainId: CHAIN_ID, lock: LOCK }
    const refusals: [unknown, { chainId: number; lock: `0x${string}` }, string][] = [
      [json, { chainId: CHAIN_ID + 1, lock: LOCK }, 'message.wrong_chain'],
      [json, { chainId: CHAIN_ID, lock: OTHER_LOCK }, 'message.wrong_contract'],
      [{ ...json, extra: 1 }, here, 'message.invalid'],
      [{ ...json, salt: '0x1234' }, here, 'message.invalid'],
      [{ ...json, fundedBy: 'relay' }, here, 'message.invalid'],
      [{ ...json, request: { ...json.request, terms: {} } }, here, 'message.invalid'],
      [
        { ...json, agreement: { ...json.agreement, type: 'Approval' } },
        here,
        'message.schema_unknown',
      ],
      [
        { ...json, agreement: { ...json.agreement, supplierSignature: undefined } },
        here,
        'message.invalid',
      ],
      [
        { ...json, humanApproval: roundTrip(envelope('HumanApproval', human, OTHER_LOCK)) },
        { chainId: CHAIN_ID, lock: LOCK },
        'message.wrong_contract',
      ],
    ]
    for (const [body, expected, reason] of refusals) {
      expect(parseReserveApprovalRequest(body, expected)).toEqual({ ok: false, reason })
    }
  })

  it('reads a signed agreement alone', () => {
    const parsed = parseSignedAgreement(roundTrip(agreement), { chainId: CHAIN_ID, lock: LOCK })
    expect(parsed.ok && parsed.value.message.commitmentId).toBe(id('commitment-1'))
    expect(
      parseSignedAgreement({ ...roundTrip(agreement), schemaVersion: '2' }, { chainId: CHAIN_ID }),
    ).toEqual({
      ok: false,
      reason: 'message.schema_unknown',
    })
  })
})

describe('reserve approvals', () => {
  const lock = lockTerms(terms, TOKEN.decimals)
  const approval: Approval = {
    commitmentId: id('commitment-1'),
    token: TOKEN.token,
    ...lock,
    supplier: newKey().address,
    supplierSigner: newKey().address,
    payee: PAYEE,
    termsHash: tHash,
    mandateHash: id('mandate hash'),
    capPerCommitment: 1_000_000_000n,
    capOpenReserves: 2_000_000_000n,
    fundingKey: agent.address,
    nonce: 7n,
    expiry: NOW + 120n,
  }
  const expected = { chainId: CHAIN_ID, lock: LOCK }

  it('reads an approval and a refusal', () => {
    const approved = parseReserveApproval(
      roundTrip({ ok: true, decisionId: 'dec_1', approval: envelope('Approval', approval) }),
      expected,
    )
    expect(approved.ok && approved.value.ok && approved.value.approval.message.nonce).toBe(7n)
    expect(
      parseReserveApproval(
        { ok: false, decisionId: 'dec_2', reason: 'mandate.over_commitment_cap' },
        expected,
      ),
    ).toEqual({
      ok: true,
      value: { ok: false, decisionId: 'dec_2', reason: 'mandate.over_commitment_cap' },
    })
  })

  it('refuses an approval for another lock, an unknown reason or a missing decision id', () => {
    const forOther = roundTrip({
      ok: true,
      decisionId: 'dec_1',
      approval: envelope('Approval', approval, OTHER_LOCK),
    })
    expect(parseReserveApproval(forOther, expected)).toEqual({
      ok: false,
      reason: 'message.wrong_contract',
    })
    expect(
      parseReserveApproval({ ok: false, decisionId: 'dec_2', reason: 'nope' }, expected),
    ).toEqual({
      ok: false,
      reason: 'message.invalid',
    })
    expect(parseReserveApproval({ ok: false, reason: 'approved' }, expected)).toEqual({
      ok: false,
      reason: 'message.invalid',
    })
  })
})

describe('enrollment, sponsorship, supplier authorizations and errors', () => {
  const mandate = demoMandate(newKey().address, agent.address)

  it('round-trips an enrollment request and its answer', () => {
    const parsed = parseEnrollmentRequest(
      roundTrip({ mandate: envelope('Mandate', mandate), keyAuthorizedIn: id('key tx') }),
      { chainId: CHAIN_ID, lock: LOCK },
    )
    expect(parsed.ok && parsed.value.mandate.message.agentKey).toBe(agent.address.toLowerCase())
    expect(
      parseEnrollmentRequest(
        roundTrip({ mandate: envelope('Mandate', mandate), keyAuthorizedIn: '0x12' }),
        { chainId: CHAIN_ID, lock: LOCK },
      ),
    ).toEqual({ ok: false, reason: 'message.invalid' })
    const answer = {
      businessId: 'biz_buyer',
      agentId: 'agt_1',
      agentKey: agent.address,
      mandateHash: id('m'),
    }
    expect(parseEnrollment(answer)).toEqual({
      ok: true,
      value: { ...answer, agentKey: agent.address.toLowerCase() },
    })
  })

  it('reads a sponsorship request and refuses one that is not a transaction', () => {
    expect(parseSponsorshipRequest({ transaction: '0x76AB' })).toEqual({
      ok: true,
      value: { transaction: '0x76ab' },
    })
    for (const body of [{}, { transaction: '0x' }, { transaction: '0x7' }, { transaction: 'ab' }]) {
      expect(parseSponsorshipRequest(body)).toEqual({ ok: false, reason: 'message.invalid' })
    }
  })

  it('reads a supplier authorization answer for its lock only', () => {
    const authorization: SupplierAuthorization = {
      commitmentId: id('commitment-1'),
      termsHash: tHash,
      salt: SALT,
      amount: 500_000_000n,
      token: TOKEN.token,
      buyerBusinessId: 'biz_buyer',
      kybReference: 'mock-kyb-1',
      kybTestData: true,
      agentKey: agent.address,
      agentKeyAuthorizedIn: id('key tx'),
      mandateHash: id('mandate hash'),
      payee: PAYEE,
      acceptBy: NOW + 600n,
      chargeDeadline: NOW + 9000n,
      releaseDate: NOW + 90000n,
      nonce: 1n,
      expiry: NOW + 300n,
    }
    const expected = { chainId: CHAIN_ID, lock: LOCK }
    const approvalMessage: Approval = {
      commitmentId: id('commitment-1'),
      token: TOKEN.token,
      ...lockTerms(terms, TOKEN.decimals),
      supplier: newKey().address,
      supplierSigner: newKey().address,
      payee: PAYEE,
      termsHash: tHash,
      mandateHash: id('mandate hash'),
      capPerCommitment: 1_000_000_000n,
      capOpenReserves: 2_000_000_000n,
      fundingKey: agent.address,
      nonce: 7n,
      expiry: NOW + 120n,
    }
    const mandate = demoMandate(newKey().address, agent.address)
    const full = {
      ok: true,
      authorization: envelope('SupplierAuthorization', authorization),
      approval: envelope('Approval', approvalMessage),
      mandate: envelope('Mandate', mandate),
    }
    const issued = parseSupplierAuthorizationAnswer(roundTrip(full), expected)
    expect(issued.ok && issued.value.ok && issued.value.mandate.message.agentId).toBe('agt_1')
    expect(
      parseSupplierAuthorizationAnswer(roundTrip({ ...full, mandate: undefined }), expected),
    ).toEqual({ ok: false, reason: 'message.invalid' })
    expect(issued.ok && issued.value.ok && issued.value.authorization.message.amount).toBe(
      500_000_000n,
    )
    expect(
      parseSupplierAuthorizationAnswer({ ok: false, reason: 'chain.reserve_missing' }, expected),
    ).toEqual({
      ok: true,
      value: { ok: false, reason: 'chain.reserve_missing' },
    })
    expect(
      parseSupplierAuthorizationAnswer(
        roundTrip({
          ...full,
          authorization: envelope('SupplierAuthorization', authorization, OTHER_LOCK),
        }),
        expected,
      ),
    ).toEqual({ ok: false, reason: 'message.wrong_contract' })
  })

  it('reads an error body, ignoring other fields and reading an unknown reason as none', () => {
    const error = { reason: 'request.in_progress', message: 'Still answering' }
    expect(parseApiError({ error })).toEqual(error)
    expect(parseApiError({ error: { ...error, retryAfter: 2 }, requestId: '0x12' })).toEqual(error)
    expect(parseApiError({ error: { reason: 'newer.code', message: 'x' } })).toEqual({
      reason: null,
      message: 'x',
    })
    expect(parseApiError({ error: { reason: 'constructor', message: 'x' } })?.reason).toBeNull()
    for (const body of [null, 'bad gateway', {}, { error: { reason: 1, message: 'x' } }]) {
      expect(parseApiError(body)).toBeNull()
    }
  })

  it('refuses an enrollment whose mandate is for another lock', () => {
    const mandate = demoMandate(newKey().address, agent.address)
    expect(
      parseEnrollmentRequest(
        roundTrip({
          mandate: envelope('Mandate', mandate, OTHER_LOCK),
          keyAuthorizedIn: id('key tx'),
        }),
        { chainId: CHAIN_ID, lock: LOCK },
      ),
    ).toEqual({ ok: false, reason: 'message.wrong_contract' })
  })

  it('names one path for each commitment, in lower case', () => {
    expect(API_PATHS.supplierAuthorizations('0xABCDEF')).toBe(
      '/v1/commitments/0xabcdef/supplier-authorizations',
    )
  })
})
