import { describe, expect, it } from 'vitest'
import type { Commitment } from './commitment.js'
import { testnetDemoTerms } from './demo.js'
import type { SupplierAuthorization } from './eip712.js'
import { termsHash } from './terms.js'
import {
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
import {
  parseCommitment,
  parseComputeTerms,
  parseMandate,
  parseReserveRequest,
  parseSigned,
  supplierAuthorizationJson,
  toWire,
} from './wire.js'

const roundTrip = (value: unknown) => JSON.parse(JSON.stringify(toWire(value)))
const agent = newKey()
const terms = testnetDemoTerms(START)
const SALT = `0x${'44'.repeat(32)}` as const

describe('records over JSON', () => {
  it('round-trips terms, mandates and reserve requests', () => {
    const mandate = demoMandate(newKey().address, agent.address)
    const request = demoRequest(agent.address)
    expect(parseComputeTerms(roundTrip(terms))).toEqual(terms)
    expect(parseMandate(roundTrip(mandate))).toEqual(mandate)
    expect(parseReserveRequest(roundTrip(request))).toEqual(request)
  })

  it('refuses amounts that are negative, fractional, padded or not strings', () => {
    for (const reserve of ['-1', '1.5', '01', 500, '1e9', '']) {
      expect(() => parseComputeTerms({ ...roundTrip(terms), reserve })).toThrow()
    }
  })

  it('refuses a time too large for the uint64 that signed messages carry it in', () => {
    const tooLate = (2n ** 64n).toString()
    expect(() => parseComputeTerms({ ...roundTrip(terms), releaseDate: tooLate })).toThrow()
    expect(
      parseComputeTerms({ ...roundTrip(terms), releaseDate: (2n ** 64n - 1n).toString() })
        .releaseDate,
    ).toBe(2n ** 64n - 1n)
  })

  it('refuses fields the schema version has no place for', () => {
    expect(() => parseComputeTerms({ ...roundTrip(terms), token: TOKEN.token })).toThrow()
  })

  it('refuses a currency v1 has no rail for', () => {
    expect(() => parseComputeTerms({ ...roundTrip(terms), currency: 'EUR' })).toThrow()
  })
})

describe('parseCommitment', () => {
  const commitment: Commitment = {
    schemaVersion: '1',
    commitmentId: id('commitment-1'),
    category: 'compute',
    buyer: { businessId: 'biz_buyer', agentId: 'agt_1', mandateId: id('mandate-1') },
    supplier: { businessId: 'biz_supplier', agentId: null },
    terms,
    termsHash: termsHash(terms, SALT),
    state: 'reserved',
    backing: [
      {
        side: 'buyer',
        type: 'cash',
        provider: 'avow-lock',
        enforcement: 'reserve',
        ref: {
          rail: 'tempo',
          chainId: CHAIN_ID,
          lock: LOCK,
          commitmentId: id('commitment-1'),
          side: 'buyer',
          token: TOKEN.token,
          amount: terms.reserve,
          payee: PAYEE,
          acceptBy: terms.acceptBy,
          chargeDeadline: terms.chargeDeadline,
          contestWindow: terms.contestWindow,
          releaseDate: terms.releaseDate,
          termsHash: termsHash(terms, SALT),
        },
        status: 'reserved',
      },
    ],
    start: null,
    contest: null,
    outcome: null,
  }

  it('round-trips a commitment', () => {
    expect(parseCommitment(roundTrip(commitment))).toEqual({ ok: true, value: commitment })
  })

  it('refuses a schema version it can read nothing of', () => {
    expect(parseCommitment({ ...roundTrip(commitment), schemaVersion: '2' })).toEqual({
      ok: false,
      reason: 'message.schema_unknown',
    })
    expect(parseCommitment({ schemaVersion: '1' })).toEqual({
      ok: false,
      reason: 'message.invalid',
    })
  })
})

describe('parseSigned', () => {
  const authorization: SupplierAuthorization = {
    commitmentId: id('commitment-1'),
    termsHash: termsHash(terms, SALT),
    salt: SALT,
    amount: terms.reserve,
    token: TOKEN.token,
    buyerBusinessId: 'biz_buyer',
    kybReference: 'mock-kyb-1',
    kybTestData: true,
    agentKey: agent.address,
    mandateHash: id('mandate hash'),
    payee: PAYEE,
    acceptBy: terms.acceptBy,
    chargeDeadline: terms.chargeDeadline,
    releaseDate: terms.releaseDate,
    nonce: 1n,
    expiry: NOW + 300n,
  }
  const envelope = roundTrip({
    type: 'SupplierAuthorization',
    schemaVersion: '1',
    chainId: CHAIN_ID,
    lock: LOCK,
    message: authorization,
    signature: `0x${'ab'.repeat(65)}`,
  })
  const parse = (json: unknown, lock?: typeof LOCK) =>
    parseSigned(json, 'SupplierAuthorization', supplierAuthorizationJson, {
      chainId: CHAIN_ID,
      ...(lock ? { lock } : {}),
    })

  it('parses an envelope and its message', () => {
    const result = parse(envelope)
    expect(result.ok && result.value.message).toEqual(authorization)
  })

  it('refuses an unknown schema version before reading the message (acceptance test 5)', () => {
    expect(parse({ ...envelope, schemaVersion: '2', message: { anything: 'else' } })).toEqual({
      ok: false,
      reason: 'message.schema_unknown',
    })
  })

  it('refuses another type, chain or lock', () => {
    expect(parse({ ...envelope, type: 'Approval' })).toEqual({
      ok: false,
      reason: 'message.schema_unknown',
    })
    expect(parse({ ...envelope, chainId: 1 })).toEqual({ ok: false, reason: 'message.wrong_chain' })
    expect(parse(envelope, OTHER_LOCK)).toEqual({ ok: false, reason: 'message.wrong_contract' })
  })

  it('refuses a malformed message or an extra field', () => {
    expect(parse({ ...envelope, message: { ...envelope.message, amount: '-5' } })).toEqual({
      ok: false,
      reason: 'message.invalid',
    })
    expect(parse({ ...envelope, extra: true })).toEqual({ ok: false, reason: 'message.invalid' })
    expect(parse({ ...envelope, signature: '0xabc' })).toEqual({
      ok: false,
      reason: 'message.invalid',
    })
  })
})
