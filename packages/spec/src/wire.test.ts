import { describe, expect, it } from 'vitest'
import type { Commitment } from './commitment.js'
import { testnetDemoTerms } from './demo.js'
import type { Approval, SupplierAuthorization } from './eip712.js'
import type { PaymentReference } from './references.js'
import { discloseSection, lockTerms, termsHash } from './terms.js'
import { testnetDemoTermsV1 } from './terms-v1.js'
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
import { COMMITMENT_RECORD_VERSION } from './version.js'
import {
  approvalJson,
  parseAnyTerms,
  parseAttributions,
  parseCommitment,
  parseMandate,
  parseReference,
  parseReserveRequest,
  parseSectionDisclosure,
  parseSigned,
  parseTerms,
  supplierAuthorizationJson,
  toWire,
} from './wire.js'

const roundTrip = (value: unknown) => JSON.parse(JSON.stringify(toWire(value)))
/** What parsing returns for a value: the same, with every hex string in lower case. */
const lowerHex = <T>(value: T): T =>
  JSON.parse(
    JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)),
    (_k, v) =>
      typeof v === 'string' && /^0x[0-9a-fA-F]*$/.test(v)
        ? v.toLowerCase()
        : typeof v === 'string' && /^-?[0-9]+n$/.test(v)
          ? BigInt(v.slice(0, -1))
          : v,
  )
const agent = newKey()
const terms = testnetDemoTerms(START, ARBITER)
const lock = lockTerms(terms, TOKEN.decimals)
const SALT = `0x${'44'.repeat(32)}` as const

describe('records over JSON', () => {
  it('round-trips terms, mandates and reserve requests', () => {
    const mandate = demoMandate(newKey().address, agent.address)
    const request = demoRequest(agent.address)
    expect(parseTerms(roundTrip(terms))).toEqual({ ok: true, value: lowerHex(terms) })
    expect(parseMandate(roundTrip(mandate))).toEqual(lowerHex(mandate))
    expect(parseReserveRequest(roundTrip(request))).toEqual(lowerHex(request))
  })

  const withBacking = (backing: unknown) => ({ ...roundTrip(terms), backing })
  const withRemedies = (change: object) => ({
    ...roundTrip(terms),
    remedies: { ...roundTrip(terms).remedies, ...change },
  })

  it('refuses amounts that are negative, fractional, padded or not strings', () => {
    for (const amount of ['-1', '1.5', '01', 500, '1e9', '']) {
      expect(parseTerms(withBacking({ ...roundTrip(terms).backing, amount }))).toEqual({
        ok: false,
        reason: 'terms.invalid',
      })
    }
  })

  it('refuses a time too large for the uint64 that signed messages carry it in', () => {
    const tooLate = (2n ** 64n).toString()
    expect(parseTerms(withRemedies({ chargeDeadline: tooLate })).ok).toBe(false)
    const latest = parseTerms(withRemedies({ chargeDeadline: (2n ** 64n - 1n).toString() }))
    expect(latest.ok && latest.value.remedies.chargeDeadline).toBe(2n ** 64n - 1n)
  })

  it('refuses fields the version has no place for, at the top and in each section', () => {
    expect(parseTerms({ ...roundTrip(terms), token: TOKEN.token }).ok).toBe(false)
    for (const section of ['subject', 'consideration', 'remedies', 'resolution', 'backing']) {
      const json = roundTrip(terms)
      expect(parseTerms({ ...json, [section]: { ...json[section], extra: 1 } })).toEqual({
        ok: false,
        reason: 'terms.invalid',
      })
    }
  })

  it('refuses a currency v1 has no rail for, and amounts in anything but micros', () => {
    expect(parseTerms({ ...roundTrip(terms), currency: 'EUR' }).ok).toBe(false)
    expect(parseTerms({ ...roundTrip(terms), amountDecimals: 2 }).ok).toBe(false)
  })

  it('refuses a terms version it does not read, before reading the rest', () => {
    for (const version of [1, 3, '2', undefined]) {
      expect(parseTerms({ ...roundTrip(terms), version, subject: 'anything' })).toEqual({
        ok: false,
        reason: 'terms.version_unknown',
      })
    }
  })

  it('refuses a template it does not know', () => {
    expect(parseTerms({ ...roundTrip(terms), template: 'freight-booking/1' })).toEqual({
      ok: false,
      reason: 'terms.template_unknown',
    })
    expect(parseTerms({ ...roundTrip(terms), template: 'gpu-reservation/2' })).toEqual({
      ok: false,
      reason: 'terms.template_unknown',
    })
  })

  it('refuses a backing a lock cannot enforce', () => {
    const reserve = roundTrip(terms).backing
    for (const backing of [
      { ...reserve, kind: 'partner' },
      { ...reserve, kind: 'agreement' },
      { ...reserve, kind: 'payment' },
      { ...reserve, side: 'supplier' },
    ]) {
      expect(parseTerms(withBacking(backing))).toEqual({
        ok: false,
        reason: 'terms.backing_unsupported',
      })
    }
  })

  it('needs the resolution, with a share from 0 to 10,000', () => {
    const { resolution: _, ...withoutResolution } = roundTrip(terms)
    expect(parseTerms(withoutResolution).ok).toBe(false)
    for (const day90SupplierShareBps of [-1, 10_001, 50.5, '5000']) {
      const json = roundTrip(terms)
      expect(
        parseTerms({ ...json, resolution: { ...json.resolution, day90SupplierShareBps } }).ok,
      ).toBe(false)
    }
  })

  it('reads version 1 terms only where a commitment made under them is checked', () => {
    const v1 = testnetDemoTermsV1(START, ARBITER)
    expect(parseAnyTerms(roundTrip(v1))).toEqual({ ok: true, value: lowerHex(v1) })
    expect(parseAnyTerms(roundTrip(terms))).toEqual({ ok: true, value: lowerHex(terms) })
    expect(parseTerms(roundTrip(v1))).toEqual({ ok: false, reason: 'terms.version_unknown' })
    expect(parseAnyTerms({ ...roundTrip(v1), reserve: '-1' })).toEqual({
      ok: false,
      reason: 'terms.invalid',
    })
  })
})

describe('a section shown on its own over JSON', () => {
  it('round-trips each section, checking its shape for the template', () => {
    for (const section of [
      'subject',
      'consideration',
      'remedies',
      'resolution',
      'backing',
    ] as const) {
      const shown = discloseSection(terms, SALT, section)
      expect(parseSectionDisclosure(roundTrip(shown))).toEqual({ ok: true, value: lowerHex(shown) })
    }
  })

  it("refuses a section whose shape doesn't fit, an unknown template or another version", () => {
    const shown = roundTrip(discloseSection(terms, SALT, 'subject'))
    expect(parseSectionDisclosure({ ...shown, content: { anything: 1 } })).toEqual({
      ok: false,
      reason: 'terms.invalid',
    })
    expect(
      parseSectionDisclosure({ ...shown, header: { ...shown.header, template: 'freight/1' } }),
    ).toEqual({ ok: false, reason: 'terms.template_unknown' })
    expect(parseSectionDisclosure({ ...shown, header: { ...shown.header, version: 3 } })).toEqual({
      ok: false,
      reason: 'terms.version_unknown',
    })
  })
})

describe('references and attributions over JSON', () => {
  const payment: PaymentReference = {
    kind: 'payment',
    chainId: CHAIN_ID,
    transactionHash: id('payment tx'),
    logIndex: 3,
    token: TOKEN.token,
    from: agent.address,
    to: PAYEE,
    amount: 24_000_000n,
    memo: id('memo'),
  }
  const commitment = {
    kind: 'commitment' as const,
    chainId: CHAIN_ID,
    lock: LOCK,
    commitmentId: id('commitment-1'),
    side: 'buyer' as const,
    termsHash: termsHash(terms, SALT),
  }

  it('round-trips both kinds of reference', () => {
    expect(parseReference(roundTrip(payment))).toEqual({ ok: true, value: lowerHex(payment) })
    expect(parseReference(roundTrip(commitment))).toEqual({ ok: true, value: lowerHex(commitment) })
  })

  it('refuses a payment with no memo, an unknown kind or a negative log index', () => {
    const { memo: _, ...noMemo } = roundTrip(payment)
    for (const json of [
      noMemo,
      { ...roundTrip(payment), kind: 'calldata' },
      { ...roundTrip(payment), logIndex: -1 },
    ]) {
      expect(parseReference(json)).toEqual({ ok: false, reason: 'message.invalid' })
    }
  })

  it('round-trips attributions as evidence or value', () => {
    const attributions = [
      { payment, obligation: commitment, use: 'evidence' as const },
      { payment, obligation: commitment, use: 'value' as const },
    ]
    expect(parseAttributions(roundTrip(attributions))).toEqual({
      ok: true,
      value: lowerHex(attributions),
    })
    expect(parseAttributions(roundTrip([{ ...attributions[0], use: 'backing' }])).ok).toBe(false)
  })
})

describe("Avow's approval over JSON", () => {
  const approval: Approval = {
    commitmentId: id('commitment-1'),
    side: 'buyer',
    token: TOKEN.token,
    amount: lock.amount,
    supplier: newKey().address,
    supplierSigner: newKey().address,
    payee: PAYEE,
    freeCancelBy: lock.freeCancelBy,
    acceptBy: lock.acceptBy,
    chargeDeadline: lock.chargeDeadline,
    releaseDate: lock.releaseDate,
    contestWindow: lock.contestWindow,
    charges: lock.charges,
    day90SupplierShareBps: 5000,
    arbiter: ARBITER,
    termsHash: termsHash(terms, SALT),
    mandateHash: id('mandate hash'),
    capPerCommitment: 1_000_000_000n,
    capOpenReserves: 2_000_000_000n,
    fundingKey: agent.address,
    nonce: 7n,
    expiry: NOW + 120n,
  }
  const envelope = roundTrip({
    type: 'Approval',
    schemaVersion: '1',
    chainId: CHAIN_ID,
    lock: LOCK,
    message: approval,
    signature: `0x${'ab'.repeat(65)}`,
  })
  const parse = (json: unknown) =>
    parseSigned(json, 'Approval', approvalJson, { chainId: CHAIN_ID, lock: LOCK })

  it('round-trips every field the lock stores', () => {
    const result = parse(envelope)
    expect(result.ok && result.value.message).toEqual(lowerHex(approval))
  })

  it('refuses an approval missing a field, with an unknown charge or too many charges', () => {
    const { arbiter: _, ...withoutArbiter } = envelope.message
    const charge = envelope.message.charges[0]
    const changes = [
      withoutArbiter,
      { ...envelope.message, charges: [] },
      { ...envelope.message, charges: [{ ...charge, kind: 'minimumUse' }] },
      { ...envelope.message, charges: [charge, charge, charge, charge, charge] },
      { ...envelope.message, day90SupplierShareBps: 10_001 },
    ]
    for (const message of changes) {
      expect(parse({ ...envelope, message })).toEqual({ ok: false, reason: 'message.invalid' })
    }
  })
})

describe('parseCommitment', () => {
  const commitment: Commitment = {
    schemaVersion: COMMITMENT_RECORD_VERSION,
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
          amount: lock.amount,
          payee: PAYEE,
          acceptBy: lock.acceptBy,
          chargeDeadline: lock.chargeDeadline,
          contestWindow: lock.contestWindow,
          releaseDate: lock.releaseDate,
          termsHash: termsHash(terms, SALT),
        },
        status: 'reserved',
      },
    ],
    start: null,
    contest: null,
    outcome: null,
    references: [],
  }

  const v1 = testnetDemoTermsV1(START, ARBITER)
  const underV1 = { ...commitment, terms: v1, termsHash: termsHash(v1, SALT) }

  it('round-trips a commitment', () => {
    expect(COMMITMENT_RECORD_VERSION).toBe('2')
    expect(parseCommitment(roundTrip(commitment))).toEqual({
      ok: true,
      value: lowerHex(commitment),
    })
  })

  it('reads a version 2 record made under version 1 terms', () => {
    expect(parseCommitment(roundTrip(underV1))).toEqual({ ok: true, value: lowerHex(underV1) })
  })

  it('reads a version 1 record as version 2, citing nothing, so it is written back as version 2', () => {
    // A record as version 1 wrote it, with version 1 terms and no references.
    const { references: _, ...older } = { ...underV1, schemaVersion: '1' }
    expect(parseCommitment(roundTrip(older))).toEqual({ ok: true, value: lowerHex(underV1) })
  })

  it('refuses a version 1 record with version 2 terms or references, and a version 2 record without references', () => {
    const { references: _, ...unreferenced } = commitment
    const bad = [
      { ...commitment, schemaVersion: '1' },
      { ...underV1, schemaVersion: '1' },
      unreferenced,
    ]
    for (const record of bad) {
      expect(parseCommitment(roundTrip(record))).toEqual({ ok: false, reason: 'message.invalid' })
    }
  })

  it('refuses a schema version it can read nothing of', () => {
    expect(parseCommitment({ ...roundTrip(commitment), schemaVersion: '3' })).toEqual({
      ok: false,
      reason: 'message.schema_unknown',
    })
    expect(parseCommitment({ schemaVersion: '2' })).toEqual({
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
    amount: lock.amount,
    token: TOKEN.token,
    buyerBusinessId: 'biz_buyer',
    kybReference: 'mock-kyb-1',
    kybTestData: true,
    agentKey: agent.address,
    agentKeyAuthorizedIn: id('key authorization tx'),
    mandateHash: id('mandate hash'),
    payee: PAYEE,
    acceptBy: lock.acceptBy,
    chargeDeadline: lock.chargeDeadline,
    releaseDate: lock.releaseDate,
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
    expect(result.ok && result.value.message).toEqual(lowerHex(authorization))
  })

  it('reads hex in any letter case as the same value', () => {
    const shouting = {
      ...envelope,
      message: {
        ...envelope.message,
        termsHash: envelope.message.termsHash.toUpperCase().replace('0X', '0x'),
        payee: '0x000000000000000000000000000000000000BEEF',
      },
    }
    const result = parse(shouting)
    expect(result.ok && result.value.message.termsHash).toBe(authorization.termsHash)
    expect(result.ok && result.value.message.payee).toBe(PAYEE)
  })

  it('accepts a mixed-case address whatever its checksum, so no check can throw on it', () => {
    const badChecksum = '0x000000000000000000000000000000000000BeEf'
    const result = parse({ ...envelope, message: { ...envelope.message, payee: badChecksum } })
    expect(result.ok && result.value.message.payee).toBe(PAYEE)
  })

  it('refuses an unknown schema version before reading the message (acceptance test 5)', () => {
    expect(parse({ ...envelope, schemaVersion: '2', message: { anything: 'else' } })).toEqual({
      ok: false,
      reason: 'message.schema_unknown',
    })
  })

  it('refuses a type named after something every object inherits, without throwing', () => {
    for (const type of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(parse({ ...envelope, type }), type).toEqual({
        ok: false,
        reason: 'message.schema_unknown',
      })
    }
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
