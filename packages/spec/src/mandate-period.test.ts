import { describe, expect, it } from 'vitest'
import { fromAp2IntentMandate, toAp2IntentMandate } from './ap2.js'
import { dollars } from './demo.js'
import { MANDATE_PERIOD_TYPES, mandateHash, mandateTypedData, mandateVersion } from './eip712.js'
import {
  checkMandate,
  MAX_PRICE_PERIOD,
  type MandateCheckInput,
  periodLimitProblem,
  validateMandate,
} from './mandate.js'
import { parseMandateProof } from './mandate-proof.js'
import { TESTNET_DEMO_PROFILE } from './profiles.js'
import { formatPeriod } from './sandbox.js'
import {
  CHAIN_ID,
  DOMAIN,
  demoMandate,
  demoRequest,
  id,
  LOCK,
  NOW,
  newKey,
  TOKEN,
} from './test-helpers.js'
import type { Mandate } from './types.js'
import { MANDATE_PERIOD_VERSION } from './version.js'
import { toWire } from './wire.js'

const DAY = 86_400n
const agent = newKey()
const plain: Mandate = {
  ...demoMandate(newKey().address, agent.address),
  approvalRule: { kind: 'never' },
}
// The demo request books eight H100s for half an hour at $3 a GPU-hour, a price of $12.
const monthly: Mandate = { ...plain, pricePeriodLimit: { amount: dollars(100), period: 30n * DAY } }
const both: Mandate = { ...monthly, priceCapPerCommitment: dollars(50) }
const expected = { chainId: CHAIN_ID, lock: LOCK }
const envelope = (
  message: Mandate,
  proof: Record<string, unknown>,
  version = mandateVersion(message),
) =>
  JSON.parse(
    JSON.stringify(
      toWire({
        type: 'Mandate',
        schemaVersion: version,
        chainId: CHAIN_ID,
        lock: LOCK,
        message,
        ...proof,
      }),
    ),
  )
const SIGNED = { signature: `0x${'11'.repeat(65)}` }
const AUTHORIZED = { authorizedIn: id('key transaction') }
const ZERO = `0x${'00'.repeat(32)}` as const

const input = (mandate: Mandate, committedInPeriod: MandateCheckInput['committedInPeriod']) => ({
  mandate,
  request: demoRequest(agent.address),
  token: TOKEN,
  openReserves: 0n,
  committedInPeriod,
  revoked: false,
  now: NOW,
  profile: TESTNET_DEMO_PROFILE,
})

describe('a mandate with a limit over a period', () => {
  it('signs at version 4, with the price limit or zero, the period limit, then what it replaces', () => {
    expect(mandateVersion(monthly)).toBe(MANDATE_PERIOD_VERSION)
    expect(mandateVersion(both)).toBe('4')
    expect(MANDATE_PERIOD_TYPES.Mandate.slice(-3)).toEqual([
      { name: 'priceCapPerCommitment', type: 'uint256' },
      { name: 'pricePeriodLimit', type: 'PricePeriodLimit' },
      { name: 'replaces', type: 'bytes32' },
    ])
    expect(mandateTypedData(monthly, DOMAIN).message).toMatchObject({
      priceCapPerCommitment: 0n,
      pricePeriodLimit: { amount: dollars(100), period: 30n * DAY },
      replaces: ZERO,
    })
    expect(mandateTypedData(both, DOMAIN).message).toMatchObject({
      priceCapPerCommitment: dollars(50),
    })
  })

  it('hashes apart for each limit, and refuses a price limit of zero, which would sign as none', () => {
    const hashes = [
      plain,
      monthly,
      both,
      { ...monthly, pricePeriodLimit: { amount: dollars(100), period: DAY } },
    ].map((m) => mandateHash(m, DOMAIN))
    expect(new Set(hashes).size).toBe(4)
    expect(() => mandateTypedData({ ...monthly, priceCapPerCommitment: 0n }, DOMAIN)).toThrow(
      RangeError,
    )
  })

  it('keeps its hash, first and replacement', () => {
    const golden: Mandate = {
      mandateId: `0x${'0a'.repeat(32)}`,
      businessId: 'biz_golden',
      agentId: 'agent-golden',
      account: '0x00000000000000000000000000000000000000a1',
      agentKey: '0x00000000000000000000000000000000000000b2',
      actions: ['reserve', 'start', 'cancel'],
      currency: 'USD',
      capPerCommitment: 50_000_000n,
      capOpenReserves: 200_000_000n,
      pricePeriodLimit: { amount: 2_000_000_000n, period: 30n * DAY },
      suppliers: ['biz_supplier'],
      categories: ['compute'],
      paymentLimits: [
        {
          token: '0x20C0000000000000000000000000000000000001',
          amount: 100_000_000n,
          period: 86400n,
        },
      ],
      approvalRule: { kind: 'never' },
      expiry: 1_900_000_000n,
      nonce: 1n,
    }
    const replacement: Mandate = {
      ...golden,
      priceCapPerCommitment: 200_000_000n,
      nonce: 2n,
      replaces: `0x${'0b'.repeat(32)}`,
    }
    expect(mandateHash(golden, DOMAIN)).toBe(
      '0xf335af6072c53af1336f19d2ac1dc1c4acd5636f79a6e8d40b21deeb110f289a',
    )
    expect(mandateHash(replacement, DOMAIN)).toBe(
      '0x9f38fc7c06bdabbf818c68eef9724ef240c3b0b21a24f10a0e80b01d3e391bc1',
    )
  })

  it('reads signed at version 4, a first one shown by its key transaction, and no other label', () => {
    const signed = parseMandateProof(envelope(both, SIGNED), expected)
    expect(signed.ok && signed.value.message.pricePeriodLimit).toEqual({
      amount: dollars(100),
      period: 30n * DAY,
    })
    expect(parseMandateProof(envelope(monthly, AUTHORIZED), expected).ok).toBe(true)
    for (const version of ['1', '2', '3']) {
      expect(parseMandateProof(envelope(monthly, SIGNED, version), expected)).toEqual({
        ok: false,
        reason: 'message.invalid',
      })
    }
    expect(parseMandateProof(envelope(monthly, SIGNED, '5'), expected)).toEqual({
      ok: false,
      reason: 'message.schema_unknown',
    })
  })

  it('is malformed with nothing to spend, no window, a window over a year, or a per-commitment limit above it', () => {
    expect(validateMandate(both)).toBeNull()
    const limit = (amount: bigint, period: bigint) => ({
      ...monthly,
      pricePeriodLimit: { amount, period },
    })
    expect(validateMandate(limit(0n, DAY))).toBe('mandate.invalid')
    expect(validateMandate(limit(dollars(1), 0n))).toBe('mandate.invalid')
    expect(validateMandate(limit(dollars(1), MAX_PRICE_PERIOD + 1n))).toBe('mandate.invalid')
    expect(validateMandate(limit(dollars(1), MAX_PRICE_PERIOD))).toBeNull()
    expect(validateMandate({ ...both, priceCapPerCommitment: dollars(101) })).toBe(
      'mandate.invalid',
    )
  })

  it('carries the limit through AP2 and back', () => {
    const pair = toAp2IntentMandate(both, 'GPU time')
    if (!pair.ok) throw new Error(pair.reason)
    expect(pair.value.avow.price_period_limit).toEqual({
      amount: '100000000',
      period_seconds: '2592000',
    })
    const back = fromAp2IntentMandate(JSON.parse(JSON.stringify(pair.value)))
    expect(back.ok && back.value.pricePeriodLimit).toEqual(both.pricePeriodLimit)
  })
})

describe('checkMandate with a limit over a period', () => {
  it('approves a commitment that brings what was committed to the limit, and refuses one past it', () => {
    expect(checkMandate(input(monthly, dollars(88))).result).toBe('approved')
    expect(checkMandate(input(monthly, dollars(88) + 1n))).toEqual({
      result: 'denied',
      reason: 'mandate.over_price_period_limit',
    })
  })

  it('leaves the limit to the SDK and Avow when the caller counts nothing, as a supplier does', () => {
    expect(checkMandate(input(monthly, 'not_counted')).result).toBe('approved')
    expect(periodLimitProblem(monthly, demoRequest(agent.address).terms, 'not_counted')).toBeNull()
  })

  it('reads no count for a mandate with no such limit', () => {
    expect(checkMandate(input(plain, dollars(1_000_000))).result).toBe('approved')
  })

  it('refuses for the price limit first, when both refuse', () => {
    const tight = { ...both, priceCapPerCommitment: dollars(1) }
    expect(checkMandate(input(tight, dollars(100))).reason).toBe('mandate.over_price_limit')
  })
})

describe('formatPeriod', () => {
  it('names a window as a limit says it after "any"', () => {
    expect(formatPeriod(DAY)).toBe('day')
    expect(formatPeriod(30n * DAY)).toBe('30 days')
    expect(formatPeriod(3_600n)).toBe('hour')
    expect(formatPeriod(12n * 3_600n)).toBe('12 hours')
    expect(formatPeriod(90n)).toBe('90 seconds')
  })
})
