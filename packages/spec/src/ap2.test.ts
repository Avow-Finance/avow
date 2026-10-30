import { describe, expect, it } from 'vitest'
import { fromAp2IntentMandate, toAp2IntentMandate } from './ap2.js'
import { dollars } from './demo.js'
import { demoMandate, newKey, TOKEN } from './test-helpers.js'
import type { ApprovalRule, Mandate } from './types.js'
import { parseMandate, toWire } from './wire.js'

const mandate = demoMandate(newKey().address, newKey().address)
const RULES: ApprovalRule[] = [
  { kind: 'never' },
  { kind: 'always' },
  { kind: 'above', amount: dollars(800) },
]

/** The pair `toAp2IntentMandate` writes for a mandate it can write. */
function pairOf(m: Mandate, description = 'Book GPUs for training runs') {
  const written = toAp2IntentMandate(m, description)
  if (!written.ok) throw new Error(`Expected a pair, got ${written.reason}`)
  return written.value
}

/** A mandate as any parser of one returns it, with its hex in lower case. */
const stored = (m: Mandate) => parseMandate(toWire(m))

/** An object without one of its fields, as a sender that leaves the field out sends it. */
const without = (o: object, field: string) =>
  Object.fromEntries(Object.entries(o).filter(([k]) => k !== field))

describe('toAp2IntentMandate', () => {
  it("maps suppliers onto AP2's merchants and the expiry onto an ISO date", () => {
    const { intent_mandate } = pairOf(mandate)
    expect(intent_mandate.merchants).toEqual(['biz_supplier'])
    expect(intent_mandate.natural_language_description).toBe('Book GPUs for training runs')
    expect(intent_mandate.intent_expiry).toBe(new Date(Number(mandate.expiry) * 1000).toISOString())
    expect(intent_mandate.skus).toBeNull()
    expect(intent_mandate.requires_refundability).toBe(false)
  })

  it('leaves merchants open when the mandate limits categories only', () => {
    expect(pairOf({ ...mandate, suppliers: [] }).intent_mandate.merchants).toBeNull()
  })

  it('requires cart confirmation under every approval rule, since the pair carries no signature', () => {
    for (const approvalRule of RULES) {
      const { intent_mandate } = pairOf({ ...mandate, approvalRule })
      expect(intent_mandate.user_cart_confirmation_required, approvalRule.kind).toBe(true)
    }
  })

  it('carries what AP2 has no field for in the avow extension', () => {
    expect(pairOf(mandate).avow).toEqual({
      mandate_id: mandate.mandateId,
      business_id: 'biz_buyer',
      agent_id: 'agt_1',
      account: mandate.account,
      agent_key: mandate.agentKey,
      actions: [...mandate.actions],
      categories: ['compute'],
      currency: 'USD',
      cap_per_commitment: '1000000000',
      cap_open_reserves: '2000000000',
      payment_limits: [{ token: TOKEN.token, amount: '5000000000', period_seconds: '86400' }],
      approval_rule: { above: '800000000' },
      nonce: mandate.nonce.toString(),
    })
  })

  it('refuses an expiry an ISO 8601 time with a four-digit year cannot write', () => {
    const last = { ...mandate, expiry: 253_402_300_799n }
    expect(pairOf(last).intent_mandate.intent_expiry).toBe('9999-12-31T23:59:59.000Z')
    expect(fromAp2IntentMandate(pairOf(last))).toEqual({ ok: true, value: stored(last) })
    // The first second of the year 10000, the last a Date can hold, and the largest a u64 holds.
    for (const expiry of [253_402_300_800n, 8_640_000_000_000n, 2n ** 64n - 1n]) {
      expect(toAp2IntentMandate({ ...mandate, expiry }, 'x')).toEqual({
        ok: false,
        reason: 'message.validity_too_long',
      })
    }
  })
})

describe('fromAp2IntentMandate', () => {
  const pair = pairOf(mandate)
  const intent = pair.intent_mandate

  it('reads back the Avow mandate the pair was made from, under every approval rule', () => {
    expect(fromAp2IntentMandate(pair)).toEqual({ ok: true, value: stored(mandate) })
    for (const approvalRule of RULES) {
      const m = { ...mandate, suppliers: [], approvalRule }
      expect(fromAp2IntentMandate(pairOf(m)), approvalRule.kind).toEqual({
        ok: true,
        value: stored(m),
      })
    }
  })

  it('takes a true confirmation flag with a rule that never asks the administrator', () => {
    const never = pairOf({ ...mandate, approvalRule: { kind: 'never' } })
    expect(never.intent_mandate.user_cart_confirmation_required).toBe(true)
    expect(fromAp2IntentMandate(never)).toEqual({
      ok: true,
      value: stored({ ...mandate, approvalRule: { kind: 'never' } }),
    })
  })

  it('reads a pair that went through JSON', () => {
    expect(fromAp2IntentMandate(JSON.parse(JSON.stringify(pair)))).toEqual({
      ok: true,
      value: stored(mandate),
    })
  })

  it('reads a field AP2 leaves optional as AP2 defines it when the field is left out', () => {
    const read = (changed: object) => fromAp2IntentMandate({ ...pair, intent_mandate: changed })
    // Left out, SKUs and refundability restrict nothing, and the confirmation flag is true.
    for (const field of ['skus', 'requires_refundability', 'user_cart_confirmation_required']) {
      expect(read(without(intent, field)), field).toEqual({ ok: true, value: stored(mandate) })
    }
    // Left out, merchants allow any supplier.
    expect(read(without(intent, 'merchants'))).toEqual({
      ok: true,
      value: stored({ ...mandate, suppliers: [] }),
    })
    for (const changed of [
      { ...intent, requires_refundability: null },
      { ...intent, required_refundability: false },
      { ...intent, required_refundability: null },
    ]) {
      expect(read(changed)).toEqual({ ok: true, value: stored(mandate) })
    }
  })

  it('reads a time with an offset as the moment it names', () => {
    const tokyo = new Date(Number(mandate.expiry) * 1000 + 9 * 3_600_000)
      .toISOString()
      .replace('.000Z', '+09:00')
    expect(
      fromAp2IntentMandate({ ...pair, intent_mandate: { ...intent, intent_expiry: tokyo } }),
    ).toEqual({ ok: true, value: stored(mandate) })
  })

  it('refuses an intent mandate that waives confirmation, adds a restriction or allows no merchant', () => {
    const changes: object[] = [
      { ...intent, skus: ['h100-8x'] },
      { ...intent, skus: [] },
      { ...intent, requires_refundability: true },
      { ...intent, required_refundability: true },
      { ...intent, merchants: [] },
    ]
    for (const approvalRule of RULES) {
      const p = pairOf({ ...mandate, approvalRule })
      expect(
        fromAp2IntentMandate({
          ...p,
          intent_mandate: { ...p.intent_mandate, user_cart_confirmation_required: false },
        }),
        approvalRule.kind,
      ).toEqual({ ok: false, reason: 'mandate.ap2_mismatch' })
    }
    for (const changed of changes) {
      expect(fromAp2IntentMandate({ ...pair, intent_mandate: changed })).toEqual({
        ok: false,
        reason: 'mandate.ap2_mismatch',
      })
    }
  })

  it('refuses a time that is not ISO 8601 with an offset, or not a whole second', () => {
    for (const intent_expiry of [
      'next week',
      // Date.parse reads both of these, the second in the reader's own time zone.
      'Nov 5, 2026 09:00 GMT',
      '2026-11-05T09:00:00',
      '2026-11-05T09:00:00.500Z',
      '2026-02-30T09:00:00Z',
      // A moment before 1970, which no expiry can be.
      '0000-01-01T00:00:00Z',
      '+010000-01-01T00:00:00.000Z',
    ]) {
      expect(
        fromAp2IntentMandate({ ...pair, intent_mandate: { ...intent, intent_expiry } }),
        intent_expiry,
      ).toEqual({ ok: false, reason: 'message.invalid' })
    }
  })

  it('refuses values no mandate can hold', () => {
    for (const changed of [
      { ...pair, avow: { ...pair.avow, account: 'not an address' } },
      { ...pair, avow: { ...pair.avow, actions: ['reserve', 'withdraw'] } },
      { ...pair, avow: { ...pair.avow, cap_per_commitment: '-1' } },
      { ...pair, avow: { ...pair.avow, payment_limits: [] } },
      { ...pair, intent_mandate: { ...intent, merchants: [''] } },
    ]) {
      expect(fromAp2IntentMandate(changed)).toEqual({ ok: false, reason: 'message.invalid' })
    }
  })

  it('refuses a malformed shape without throwing', () => {
    for (const malformed of [
      null,
      undefined,
      42,
      'a pair',
      [],
      {},
      { intent_mandate: intent },
      { ...pair, intent_mandate: null },
      { ...pair, extra: true },
      { ...pair, avow: { ...pair.avow, approval_rule: null } },
      { ...pair, avow: { ...pair.avow, approval_rule: { above: 800 } } },
      { ...pair, avow: without(pair.avow, 'payment_limits') },
      { ...pair, avow: { ...pair.avow, payment_limits: [{ token: TOKEN.token }] } },
      { ...pair, avow: { ...pair.avow, nonce: 1 } },
      { ...pair, avow: { ...pair.avow, signature: '0x' } },
      { ...pair, intent_mandate: without(intent, 'intent_expiry') },
      { ...pair, intent_mandate: without(intent, 'natural_language_description') },
      { ...pair, intent_mandate: { ...intent, user_cart_confirmation_required: null } },
      { ...pair, intent_mandate: { ...intent, merchants: 'biz_supplier' } },
      { ...pair, intent_mandate: { ...intent, intent_expiry: Number(mandate.expiry) } },
      { ...pair, intent_mandate: { ...intent, user_signature: '0x' } },
    ]) {
      expect(fromAp2IntentMandate(malformed)).toEqual({ ok: false, reason: 'message.invalid' })
    }
  })
})
