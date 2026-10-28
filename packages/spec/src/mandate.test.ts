import { describe, expect, it } from 'vitest'
import { dollars } from './demo.js'
import { checkMandate, type MandateCheckInput, validateMandate } from './mandate.js'
import { PRODUCTION_PROFILE, TESTNET_DEMO_PROFILE } from './profiles.js'
import { demoMandate, demoRequest, NOW, newKey, START, TOKEN } from './test-helpers.js'
import type { Mandate, ReserveRequest } from './types.js'

const admin = newKey()
const agent = newKey()

function input(
  mandate: Partial<Mandate> = {},
  request: Partial<ReserveRequest> = {},
  rest: Partial<MandateCheckInput> = {},
): MandateCheckInput {
  return {
    mandate: { ...demoMandate(admin.address, agent.address), ...mandate },
    request: { ...demoRequest(agent.address), ...request },
    token: TOKEN,
    openReserves: 0n,
    revoked: false,
    now: NOW,
    profile: TESTNET_DEMO_PROFILE,
    ...rest,
  }
}

const denied = (reason: string) => ({ result: 'denied', reason })

describe('checkMandate', () => {
  it('approves a reserve within the mandate (acceptance test 1)', () => {
    expect(checkMandate(input())).toEqual({ result: 'approved', reason: 'approved' })
  })

  it('denies a reserve above the cap per commitment with a reason code (acceptance test 1)', () => {
    expect(checkMandate(input({ capPerCommitment: dollars(499) }))).toEqual(
      denied('mandate.over_commitment_cap'),
    )
  })

  it('denies a reserve that would take open reserves above the cap', () => {
    expect(checkMandate(input({}, {}, { openReserves: dollars(1501) }))).toEqual(
      denied('mandate.over_open_reserves_cap'),
    )
    expect(checkMandate(input({}, {}, { openReserves: dollars(1500) }))).toEqual({
      result: 'approved',
      reason: 'approved',
    })
  })

  it('denies an expired or revoked mandate (acceptance test 2)', () => {
    expect(checkMandate(input({ expiry: NOW }))).toEqual(denied('mandate.expired'))
    expect(checkMandate(input({}, {}, { revoked: true }))).toEqual(denied('mandate.revoked'))
  })

  it('denies a supplier or category outside the mandate (acceptance test 3)', () => {
    expect(checkMandate(input({}, { supplier: 'biz_other' }))).toEqual(
      denied('mandate.supplier_not_allowed'),
    )
    expect(checkMandate(input({}, { category: 'storage' }))).toEqual(
      denied('mandate.category_not_allowed'),
    )
  })

  it('treats an empty supplier or category list as no limit on it', () => {
    expect(checkMandate(input({ suppliers: [] }, { supplier: 'biz_other' }))).toEqual({
      result: 'approved',
      reason: 'approved',
    })
    expect(checkMandate(input({ categories: [] }, { category: 'storage' }))).toEqual({
      result: 'approved',
      reason: 'approved',
    })
  })

  it("denies a request from a key that isn't the mandate's agent", () => {
    expect(checkMandate(input({}, { agentKey: newKey().address }))).toEqual(
      denied('agent.key_mismatch'),
    )
  })

  it("denies a reserve when the mandate doesn't permit reserving", () => {
    expect(checkMandate(input({ actions: ['cancel', 'start'] }))).toEqual(
      denied('mandate.action_not_permitted'),
    )
  })

  it("denies a token the mandate has no limit for, and an amount over the token's limit", () => {
    const otherToken = { ...TOKEN, token: '0x20c0000000000000000000000000000000000002' } as const
    expect(checkMandate(input({}, {}, { token: otherToken }))).toEqual(
      denied('mandate.token_not_allowed'),
    )
    const limits = [{ token: TOKEN.token, amount: dollars(400), period: 86_400n }]
    expect(checkMandate(input({ paymentLimits: limits }))).toEqual(
      denied('mandate.over_payment_limit'),
    )
  })

  it("converts micros into the token's base units before comparing with its limit", () => {
    const eighteen = { ...TOKEN, decimals: 18 }
    const limits = [{ token: TOKEN.token, amount: dollars(500) * 10n ** 12n, period: 0n }]
    expect(checkMandate(input({ paymentLimits: limits }, {}, { token: eighteen }))).toEqual({
      result: 'approved',
      reason: 'approved',
    })
    expect(checkMandate(input({}, {}, { token: eighteen }))).toEqual(
      denied('mandate.over_payment_limit'),
    )
  })

  it("denies terms whose currency isn't the lock token's", () => {
    const euroToken = { ...TOKEN, currency: 'EUR' } as unknown as typeof TOKEN
    expect(checkMandate(input({}, {}, { token: euroToken }))).toEqual(
      denied('terms.currency_mismatch'),
    )
  })

  it('denies a mandate that expires before the window ends', () => {
    expect(checkMandate(input({ expiry: START + 60n }))).toEqual(
      denied('mandate.ends_before_window'),
    )
  })

  it('denies terms that fail on their own, before any limit', () => {
    const terms = demoRequest(agent.address).terms
    expect(
      checkMandate(
        input({}, { terms: { ...terms, backing: { ...terms.backing, amount: dollars(250) } } }),
      ),
    ).toEqual(denied('terms.reserve_mismatch'))
    expect(checkMandate(input({}, {}, { profile: PRODUCTION_PROFILE }))).toEqual(
      denied('terms.contest_window_short'),
    )
  })

  it('asks the administrator when the mandate says to', () => {
    const needsHuman = { result: 'needs_human', reason: 'approval.human_required' }
    expect(checkMandate(input({ approvalRule: { kind: 'always' } }))).toEqual(needsHuman)
    expect(checkMandate(input({ approvalRule: { kind: 'above', amount: dollars(499) } }))).toEqual(
      needsHuman,
    )
    expect(checkMandate(input({ approvalRule: { kind: 'above', amount: dollars(500) } }))).toEqual({
      result: 'approved',
      reason: 'approved',
    })
    expect(checkMandate(input({ approvalRule: { kind: 'never' } }))).toEqual({
      result: 'approved',
      reason: 'approved',
    })
  })

  it('checks the hard limits before asking anyone, so an approval never widens them', () => {
    expect(
      checkMandate(input({ approvalRule: { kind: 'always' }, capPerCommitment: dollars(100) })),
    ).toEqual(denied('mandate.over_commitment_cap'))
  })
})

describe('validateMandate', () => {
  const m = demoMandate(admin.address, agent.address)

  it('accepts the demo mandate', () => {
    expect(validateMandate(m)).toBeNull()
  })

  it('refuses a mandate that limits nothing or whose caps conflict', () => {
    expect(validateMandate({ ...m, suppliers: [], categories: [] })).toBe('mandate.invalid')
    expect(validateMandate({ ...m, capPerCommitment: 0n })).toBe('mandate.invalid')
    expect(validateMandate({ ...m, capPerCommitment: m.capOpenReserves + 1n })).toBe(
      'mandate.invalid',
    )
    expect(validateMandate({ ...m, paymentLimits: [] })).toBe('mandate.invalid')
    expect(validateMandate({ ...m, actions: [] })).toBe('mandate.invalid')
  })

  it('refuses a malformed mandate in the check too', () => {
    expect(checkMandate(input({ paymentLimits: [] }))).toEqual(denied('mandate.invalid'))
  })
})
