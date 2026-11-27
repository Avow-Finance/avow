import type { Address } from 'viem'
import { describe, expect, it } from 'vitest'
import { dollars } from './demo.js'
import type { Signed } from './eip712.js'
import {
  parseSellerMandate,
  SELLER_MANDATE_TYPES,
  type SellerMandate,
  type SellingLimit,
  sellerMandateHash,
  sellerMandateProblem,
  sellingLimitFor,
} from './seller-mandate.js'
import {
  CHAIN_ID,
  DOMAIN,
  demoSellerMandate,
  id,
  LOCK,
  newKey,
  OTHER_LOCK,
} from './test-helpers.js'
import { toWire } from './wire.js'

const ACCOUNT: Address = '0x00000000000000000000000000000000000a11ce'
const KEY: Address = '0x0000000000000000000000000000000000005e11'
const OTHER_KEY: Address = '0x0000000000000000000000000000000000005e12'

const mandate = demoSellerMandate(ACCOUNT, KEY)
const withMandate = (change: Partial<SellerMandate>): SellerMandate => ({ ...mandate, ...change })
const [jobLine, anyService, bulkEval] = mandate.limits
if (!jobLine || !anyService || !bulkEval) throw new Error('the demo mandate has three lines')
const withLines = (...limits: SellingLimit[]) => withMandate({ limits })
const invalid = 'seller_mandate.invalid'

describe("a well-formed seller's mandate", () => {
  it('passes as the demo writes it, with a checksummed address too', () => {
    expect(sellerMandateProblem(mandate)).toBeNull()
    expect(sellerMandateProblem(withMandate({ account: newKey().address }))).toBeNull()
  })

  it('takes a floor of zero, an empty counterparty policy and a mandate it replaces', () => {
    const open = withMandate({
      limits: [{ ...anyService, minUnitPrice: 0n }],
      excludedBuyers: [],
      minLateCancellationBps: 0,
      minNoShowBps: 0,
      maxFreeCancelWindow: 0n,
      approvalRule: { kind: 'never' },
      replaces: id('the mandate before'),
    })
    expect(sellerMandateProblem(open)).toBeNull()
  })

  it('refuses limits that conflict or could never sell anything', () => {
    const changes: Partial<SellerMandate>[] = [
      { limits: [] },
      { maxOrderValue: 0n },
      { maxOutstanding: mandate.maxOrderValue - 1n },
      { maxDeliveryHorizon: 0n },
      { minLateCancellationBps: 10_001 },
      { minNoShowBps: -1 },
      { minNoShowBps: 0.5 },
      // No term is open to bargaining in version 1.
      { negotiable: ['unitPrice'] },
      // `always` already says every sale.
      { approvalRule: { kind: 'above', amount: 0n } },
      // A list of the only buyers leaves nobody else to exclude.
      { buyers: ['biz_friend'] },
    ]
    for (const change of changes) {
      expect(sellerMandateProblem(withMandate(change)), JSON.stringify(toWire(change))).toBe(
        invalid,
      )
    }
    const lines: SellingLimit[][] = [
      [{ ...anyService, category: 'compute' as never }],
      [{ ...anyService, item: '' }],
      [{ ...anyService, item: '   ' }],
      [{ ...anyService, minUnitPrice: -1n }],
      // A floor above an order's most sells nothing.
      [{ ...anyService, minUnitPrice: mandate.maxOrderValue + 1n }],
      [{ ...anyService, maxUnitsPerOrder: 0 }],
      [{ ...anyService, maxUnitsPerOrder: 1.5 }],
      [{ ...anyService, maxUnitsPerDay: anyService.maxUnitsPerOrder - 1 }],
      [{ ...anyService, maxUnitsPerDay: 2 ** 32 }],
      // A job is one unit, and its kind of work is shorter than a service's name.
      [{ ...jobLine, maxUnitsPerOrder: 2 }],
      [{ ...jobLine, item: 'x'.repeat(65) }],
    ]
    for (const limits of lines) {
      expect(sellerMandateProblem(withLines(...limits)), JSON.stringify(toWire(limits))).toBe(
        invalid,
      )
    }
  })

  it("refuses a line for an item that is tighter than its category's line for every other item", () => {
    // An agent names its own items, so it would sell the item under another name.
    const tighter: Partial<SellingLimit>[] = [
      { minUnitPrice: anyService.minUnitPrice + 1n },
      { maxUnitsPerOrder: anyService.maxUnitsPerOrder - 1 },
      { maxUnitsPerOrder: 4, maxUnitsPerDay: anyService.maxUnitsPerDay - 1 },
    ]
    for (const change of tighter) {
      expect(sellerMandateProblem(withLines(anyService, { ...bulkEval, ...change }))).toBe(invalid)
    }
    // With no line for every other item, a line for an item is the only way to sell at all.
    const alone = { ...bulkEval, minUnitPrice: dollars(400), maxUnitsPerOrder: 1 }
    expect(sellerMandateProblem(withLines(alone))).toBeNull()
  })

  it('refuses lines or lists out of order, so a mandate that says one thing is written one way', () => {
    expect(sellerMandateProblem(withLines(anyService, jobLine, bulkEval))).toBe(invalid)
    expect(sellerMandateProblem(withLines(jobLine, bulkEval, anyService))).toBe(invalid)
    expect(sellerMandateProblem(withLines(jobLine, anyService, anyService))).toBe(invalid)
    expect(sellerMandateProblem(withLines(jobLine, anyService, bulkEval, bulkEval))).toBe(invalid)
    const other = { ...bulkEval, item: 'Audit' }
    expect(sellerMandateProblem(withLines(jobLine, anyService, bulkEval, other))).toBe(invalid)
    expect(sellerMandateProblem(withLines(jobLine, anyService, other, bulkEval))).toBeNull()
    const lists: Partial<SellerMandate>[] = [
      { excludedBuyers: ['biz_b', 'biz_a'] },
      { excludedBuyers: ['biz_a', 'biz_a'] },
      { excludedBuyers: [], buyers: ['biz_b', 'biz_a'] },
      { excludedCountries: ['KP', 'IR'] },
      { excludedCountries: ['IR', 'IR'] },
    ]
    for (const change of lists) expect(sellerMandateProblem(withMandate(change))).toBe(invalid)
    const sorted = withMandate({
      excludedBuyers: ['biz_a', 'biz_b'],
      excludedCountries: ['IR', 'KP'],
    })
    expect(sellerMandateProblem(sorted)).toBeNull()
  })

  it('refuses a value the signed form cannot carry, where hashing would throw', () => {
    const changes: Partial<SellerMandate>[] = [
      { mandateId: '0x12' },
      { mandateId: undefined as never },
      { mandateId: `0x${'AB'.repeat(32)}` },
      { businessId: '' },
      { businessId: 'x'.repeat(101) },
      { account: 'nope' as never },
      { signingKey: undefined as never },
      { currency: 'EUR' as never },
      { maxOrderValue: 2n ** 256n, maxOutstanding: 2n ** 256n },
      { maxOutstanding: 2n ** 256n },
      { maxDeliveryHorizon: 2n ** 64n },
      { maxFreeCancelWindow: 2n ** 64n },
      { maxFreeCancelWindow: -1n },
      { expiry: 2n ** 64n },
      { nonce: 2n ** 256n },
      { nonce: 1 as never },
      { excludedBuyers: [''] },
      { excludedBuyers: [7 as never] },
      { excludedCountries: ['jp'] },
      { excludedCountries: ['JPN'] },
      { requiresBusinessCheck: 1 as never },
      { negotiable: null as never },
      { approvalRule: { kind: 'sometimes' } as never },
      { approvalRule: { kind: 'above', amount: 2n ** 256n } },
      { approvalRule: null as never },
      { replaces: `0x${'00'.repeat(32)}` },
      { replaces: `0x${'AB'.repeat(32)}` },
      { replaces: '0x12' },
      { replaces: undefined as never },
    ]
    for (const change of changes) {
      expect(sellerMandateProblem(withMandate(change)), JSON.stringify(toWire(change))).toBe(
        invalid,
      )
    }
    // A hole in a list is no line and no business.
    const sparse = [jobLine, anyService, bulkEval]
    delete sparse[1]
    expect(sellerMandateProblem(withMandate({ limits: sparse }))).toBe(invalid)
    for (const value of [null, undefined, 'a mandate', 7, []]) {
      expect(sellerMandateProblem(value as never)).toBe(invalid)
    }
  })

  it('refuses anything the signed form would leave unsigned', () => {
    const extra = { ...mandate, weeklyBudget: dollars(100) }
    expect(sellerMandateProblem(extra)).toBe(invalid)
    const { nonce: _, ...missing } = mandate
    expect(sellerMandateProblem(missing as never)).toBe(invalid)
    const line = { ...anyService, note: 'for friends' }
    expect(sellerMandateProblem(withLines(line))).toBe(invalid)
    const rule = { kind: 'never', amount: 5n } as never
    expect(sellerMandateProblem(withMandate({ approvalRule: rule }))).toBe(invalid)
  })

  it('refuses text that is half a character, which two different strings would hash as one', () => {
    expect(sellerMandateProblem(withLines({ ...anyService, item: '\ud800' }))).toBe(invalid)
    expect(sellerMandateProblem(withMandate({ excludedBuyers: ['biz_\ud800'] }))).toBe(invalid)
    expect(sellerMandateProblem(withMandate({ businessId: 'biz_\udc00' }))).toBe(invalid)
  })

  it("finds an item's own line, then its category's line for every other item, by exact name", () => {
    expect(sellingLimitFor(mandate, 'service', 'Bulk eval')).toBe(bulkEval)
    expect(sellingLimitFor(mandate, 'service', 'Bulk eval ')).toBe(anyService)
    expect(sellingLimitFor(mandate, 'service', 'bulk eval')).toBe(anyService)
    expect(sellingLimitFor(mandate, 'compute-job', 'fine-tuning')).toBe(jobLine)
    expect(sellingLimitFor(mandate, 'compute-job', 'inference')).toBeNull()
    expect(sellingLimitFor(mandate, 'compute', 'Bulk eval')).toBeNull()
  })
})

describe("the signed form of a seller's mandate", () => {
  it("hashes one way, pinned so a change to the signed fields can't pass unseen", () => {
    expect(sellerMandateHash(mandate, DOMAIN)).toBe(
      '0x7afe84a60e96c5d801fc682479b63aeff841338b070f43c35338ddf1fcc24685',
    )
  })

  it('names every field of the interface and of a line, and nothing else', () => {
    const fields = (struct: readonly { name: string }[]) => struct.map((f) => f.name).sort()
    expect(fields(SELLER_MANDATE_TYPES.SellerMandate)).toEqual(
      [...Object.keys(mandate), 'approvalAbove'].sort(),
    )
    expect(fields(SELLER_MANDATE_TYPES.SellingLimit)).toEqual(Object.keys(anyService).sort())
  })

  it('changes its hash with any field, the lock or the chain', () => {
    const changes: Partial<SellerMandate>[] = [
      { mandateId: id('seller-mandate-2') },
      { businessId: 'biz_other' },
      { account: OTHER_KEY },
      { signingKey: OTHER_KEY },
      { limits: [jobLine, anyService] },
      { limits: [jobLine, anyService, { ...bulkEval, item: 'Bulk evals' }] },
      { limits: [jobLine, anyService, { ...bulkEval, minUnitPrice: bulkEval.minUnitPrice - 1n }] },
      { limits: [jobLine, anyService, { ...bulkEval, maxUnitsPerOrder: 9 }] },
      { limits: [jobLine, anyService, { ...bulkEval, maxUnitsPerDay: 21 }] },
      { limits: [jobLine, { ...bulkEval, item: null }] },
      { maxOrderValue: mandate.maxOrderValue + 1n },
      { maxOutstanding: mandate.maxOutstanding + 1n },
      { maxDeliveryHorizon: mandate.maxDeliveryHorizon + 1n },
      { minLateCancellationBps: 1_999 },
      { minNoShowBps: 4_999 },
      { maxFreeCancelWindow: mandate.maxFreeCancelWindow + 1n },
      { buyers: ['biz_friend'], excludedBuyers: [] },
      { excludedBuyers: [] },
      { excludedCountries: ['KP'] },
      { requiresBusinessCheck: true },
      { approvalRule: { kind: 'above', amount: dollars(301) } },
      { approvalRule: { kind: 'always' } },
      { approvalRule: { kind: 'never' } },
      { expiry: mandate.expiry + 1n },
      { nonce: 2n },
      { replaces: id('the mandate before') },
    ]
    for (const change of changes) expect(sellerMandateProblem(withMandate(change))).toBeNull()
    const hash = sellerMandateHash(mandate, DOMAIN)
    const hashes = changes.map((change) => sellerMandateHash(withMandate(change), DOMAIN))
    expect(new Set([hash, ...hashes]).size).toBe(changes.length + 1)
    expect(sellerMandateHash(mandate, { ...DOMAIN, verifyingContract: OTHER_LOCK })).not.toBe(hash)
    expect(sellerMandateHash(mandate, { ...DOMAIN, chainId: CHAIN_ID + 1 })).not.toBe(hash)
  })

  const signed: Signed<SellerMandate> = {
    type: 'SellerMandate',
    schemaVersion: '1',
    chainId: CHAIN_ID,
    lock: LOCK,
    message: mandate,
    signature: '0x1234',
  }
  const wire = (value: unknown = signed) => JSON.parse(JSON.stringify(toWire(value)))
  const expected = { chainId: CHAIN_ID, lock: LOCK }
  const reason = (json: unknown) => {
    const read = parseSellerMandate(json, expected)
    return read.ok ? null : read.reason
  }

  it('reads back from JSON as it was written', () => {
    expect(parseSellerMandate(wire(), expected)).toEqual({ ok: true, value: signed })
    const replacing = { ...signed, message: withMandate({ replaces: id('the mandate before') }) }
    expect(parseSellerMandate(wire(replacing), expected)).toEqual({ ok: true, value: replacing })
  })

  it("refuses another chain, lock, type or version, and a field it doesn't know", () => {
    expect(reason({ ...wire(), chainId: CHAIN_ID + 1 })).toBe('message.wrong_chain')
    expect(reason({ ...wire(), lock: OTHER_LOCK })).toBe('message.wrong_contract')
    expect(reason({ ...wire(), type: 'Mandate' })).toBe('message.schema_unknown')
    expect(reason({ ...wire(), schemaVersion: '2' })).toBe('message.schema_unknown')
    expect(reason({ ...wire(), message: { ...wire().message, weeklyBudget: '1' } })).toBe(
      'message.invalid',
    )
    expect(reason(null)).toBe('message.invalid')
  })

  it('refuses a mandate that reads as JSON and is not well formed', () => {
    const message = (change: object) => ({ ...wire(), message: { ...wire().message, ...change } })
    expect(reason(message({ negotiable: ['unitPrice'] }))).toBe(invalid)
    expect(reason(message({ excludedBuyers: ['biz_b', 'biz_a'] }))).toBe(invalid)
    expect(reason(message({ limits: [] }))).toBe(invalid)
    expect(reason(message({ businessId: '' }))).toBe(invalid)
  })
})
