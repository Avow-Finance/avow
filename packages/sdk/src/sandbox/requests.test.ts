import { API_AUTH_SCHEME, type Mandate, SANDBOX_PATHS, toWire } from '@avow-finance/spec'
import { generatePrivateKey } from 'viem/accounts'
import { Account } from 'viem/tempo'
import { describe, expect, it } from 'vitest'
import {
  askForChange,
  changeWords,
  hasSettled,
  isUsable,
  openModeAsk,
  raiseAsk,
  readOwnRequest,
  supplierAsk,
} from './requests.js'

const current = { capPerCommitment: 250_000_000n, capOpenReserves: 1_000_000_000n } as Mandate
const ID = 'ab'.repeat(16)
const DOMAIN = { chainId: 42431, verifyingContract: `0x${'22'.repeat(20)}` } as const

describe('asking to raise a limit', () => {
  it("starts from the agent's current mandate, with the fixed reason for that limit", () => {
    expect(raiseAsk(current, 'per_commitment', 400_000_000n)).toEqual({
      kind: 'raise_limit',
      terms: { limit: 'per_commitment', from: 250_000_000n, to: 400_000_000n },
      reason: 'over_commitment_limit',
    })
    expect(raiseAsk(current, 'open_reserves', 2_000_000_000n).reason).toBe('reserves_limit_full')
  })

  it('refuses to ask for a limit that holds no more than now', () => {
    expect(() => raiseAsk(current, 'per_commitment', 250_000_000n)).toThrow(RangeError)
    expect(() => raiseAsk(current, 'open_reserves', 1n)).toThrow(RangeError)
  })

  it('asks as the agent, and answers with the link that opens its signing page', async () => {
    const agentKey = Account.fromSecp256k1(generatePrivateKey(), {
      access: Account.fromSecp256k1(generatePrivateKey()).address,
    })
    const ask = raiseAsk(current, 'per_commitment', 400_000_000n)
    const record = {
      id: ID,
      ...ask,
      businessId: 'sandbox-test',
      agentKey: agentKey.accessKeyAddress,
      basis: { mandate: `0x${'33'.repeat(32)}` },
      requestedAt: 1_800_000_000n,
      expiresAt: 1_800_086_400n,
      status: { state: 'waiting' },
    }
    const seen: { path: string; body: unknown; signed: boolean }[] = []
    const send = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      seen.push({
        path: url.pathname,
        body: JSON.parse(
          typeof init?.body === 'string'
            ? init.body
            : new TextDecoder().decode(init?.body as Uint8Array),
        ),
        signed:
          new Headers(init?.headers).get('authorization')?.startsWith(`${API_AUTH_SCHEME} `) ??
          false,
      })
      return Response.json(toWire(record), { status: 201 })
    }) as typeof fetch
    const context = { apiUrl: 'https://api.test', agentKey, domain: DOMAIN, send }
    const asked = await askForChange(context, ask)
    expect(asked.link).toBe(`https://testnet.avow.finance/#sign-${ID}`)
    expect(asked.request.status.state).toBe('waiting')
    expect(seen[0]).toMatchObject({ path: SANDBOX_PATHS.approvalRequests, signed: true })
    expect(seen[0]?.body).toEqual(toWire(ask))
    const read = await readOwnRequest(context, ID)
    expect(seen[1]?.path).toBe(SANDBOX_PATHS.approvalRequest(ID))
    expect(isUsable(read.request)).toBe(false)
    expect(hasSettled(read.request)).toBe(false)
  })
})

describe('asking for a supplier or open mode', () => {
  it('carries the fixed reason for each, and refuses open mode at no cap', () => {
    expect(supplierAsk('sandbox-cd34')).toEqual({
      kind: 'name_supplier',
      terms: { supplier: 'sandbox-cd34' },
      reason: 'new_supplier',
    })
    expect(openModeAsk(500_000_000n).reason).toBe('listed_suppliers')
    expect(() => openModeAsk(0n)).toThrow(RangeError)
  })
})

describe("a request's words", () => {
  const base = {
    id: ID,
    businessId: 'sandbox-test',
    agentKey: `0x${'11'.repeat(20)}`,
    requestedAt: 1_800_000_000n,
    expiresAt: 1_800_086_400n,
    status: { state: 'waiting' },
  } as const

  it('puts each value now beside the value asked for, for every kind', () => {
    expect(
      changeWords({
        ...base,
        kind: 'raise_limit',
        terms: { limit: 'per_commitment', from: 250_000_000n, to: 400_000_000n },
        reason: 'over_commitment_limit',
        basis: { mandate: `0x${'33'.repeat(32)}` },
      }),
    ).toEqual({
      title: 'Raise a limit',
      rows: [{ label: 'Most per commitment', before: '$250', after: '$400' }],
    })
    expect(
      changeWords({
        ...base,
        kind: 'open_mode',
        terms: { cap: 500_000_000n },
        reason: 'listed_suppliers',
        basis: { openCap: 0n, openCapChanges: 0n },
      }).rows,
    ).toEqual([
      { label: 'Most held with listed suppliers at once', before: 'Closed', after: '$500' },
    ])
    expect(
      changeWords({
        ...base,
        kind: 'name_supplier',
        terms: { supplier: 'sandbox-cd34' },
        reason: 'new_supplier',
        basis: {
          mandate: `0x${'33'.repeat(32)}`,
          supplier: `0x${'77'.repeat(20)}`,
          supplierChanges: 0n,
        },
      }).rows,
    ).toEqual([{ label: 'Supplier', before: 'Not named', after: 'sandbox-cd34' }])
  })

  it("shows every limit a seller's mandate would set, and what on testnet is self-declared or simulated", () => {
    const terms = {
      currency: 'USD',
      limits: [
        {
          category: 'compute-job',
          item: 'fine-tuning',
          minUnitPrice: 100_000_000n,
          maxUnitsPerOrder: 1,
          maxUnitsPerDay: 3,
        },
        {
          category: 'service',
          item: null,
          minUnitPrice: 40_000_000n,
          maxUnitsPerOrder: 4,
          maxUnitsPerDay: 10,
        },
        {
          category: 'service',
          item: 'Bulk eval',
          minUnitPrice: 0n,
          maxUnitsPerOrder: 8,
          maxUnitsPerDay: 20,
        },
      ],
      maxOrderValue: 500_000_000n,
      maxOutstanding: 2_000_000_000n,
      maxDeliveryHorizon: 604_800n,
      minLateCancellationBps: 2000,
      minNoShowBps: 5000,
      maxFreeCancelWindow: 5_400n,
      buyers: [],
      excludedBuyers: ['sandbox-blocked'],
      excludedCountries: ['IR', 'KP'],
      requiresBusinessCheck: true,
      negotiable: [],
      approvalRule: { kind: 'above', amount: 300_000_000n },
      expiry: 1_802_592_000n,
    } as const
    const asked = {
      ...base,
      kind: 'seller_mandate',
      terms,
      reason: 'new_seller',
      basis: { sellerMandate: null },
    } as const
    const words = changeWords(asked)
    expect(words.title).toBe('Let the agent sell')
    expect(words.rows.map((r) => [r.label, r.after])).toEqual([
      ['fine-tuning', 'From $100 a job, up to 3 a day'],
      ['Any other service', 'From $40 a unit, up to 4 an order and 10 a day'],
      ['Bulk eval', 'Any price a unit, up to 8 an order and 20 a day'],
      ['Most for one order', '$500'],
      ['Most promised and not yet delivered', '$2,000'],
      ['Longest until delivery', '7 days'],
      ['Lowest late-cancellation charge', '20%'],
      ['Lowest no-show charge', '50%'],
      ['Longest free cancellation for a service', '90 minutes'],
      [
        'Buyers',
        "Any business except sandbox-blocked, with a self-declared country other than IR, KP, that passed Avow's simulated business check",
      ],
      ['A person decides', 'Sales over $300'],
      ['Ends', '2027-02-14T08:00:00.000Z'],
    ])
    expect(new Set(words.rows.map((r) => r.before))).toEqual(new Set(['Not set']))
    const replacing = changeWords({
      ...asked,
      reason: 'seller_limits',
      basis: { sellerMandate: `0x${'33'.repeat(32)}` },
    })
    expect(replacing.rows[0]?.before).toBe('As signed before')
  })
})
