import { API_AUTH_SCHEME, type Mandate, SANDBOX_PATHS, toWire } from '@avow-finance/spec'
import { generatePrivateKey } from 'viem/accounts'
import { Account } from 'viem/tempo'
import { describe, expect, it } from 'vitest'
import {
  askForChange,
  type ChangeRow,
  changeWords,
  hasSettled,
  isUsable,
  openModeAsk,
  raiseAsk,
  readOwnRequest,
  supplierAsk,
} from './requests.js'

/** A row's new value and its value now, for a row that sets one beside the other. */
const afterOf = (r: ChangeRow) => ('after' in r ? r.after : null)
const beforeOf = (r: ChangeRow) => ('before' in r ? r.before : null)

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

  it('shows one sale a person is asked to approve, whole, and says it changes no limit', () => {
    const sale = {
      ...base,
      businessId: 'biz_supplier',
      kind: 'sale',
      terms: {
        signingKey: `0x${'5e'.repeat(20)}`,
        buyer: 'sandbox-ab12',
        offer: {
          supplier: 'biz_supplier',
          // A service named as a row of the card still reads as a service's name.
          item: { name: 'Total', summary: 'One fine-tuning run on the dataset sent' },
          currency: 'USD',
          unitPrice: 100_000_000n,
          rules: {
            evidence: 'The tuned weights are delivered to the buyer',
            leadTime: 172_800n,
            maxPerBooking: 4,
            dailyCapacity: 5,
            freeCancelWindow: 7_200n,
            lateCancellationBps: 2_000,
            noShowBps: 5_000,
            payment: { route: 'transfer', dueAfterDelivery: 604_800n },
          },
        },
        units: 4,
      },
      reason: 'sale_needs_person',
      basis: { sellerMandate: `0x${'33'.repeat(32)}` },
    } as const
    const words = changeWords(sale)
    expect(words.title).toBe('Approve one sale')
    // Nothing stood before, so each row states one fact and none sets a value beside another.
    expect(words.rows.map((r) => ('value' in r ? [r.label, r.value] : r))).toEqual([
      ['Approves', 'This one sale, once, within 1 day. No limit changes.'],
      ['Sold by the key', `0x${'5e'.repeat(20)}`],
      ['Buyer', 'sandbox-ab12'],
      ['Sold by', 'biz_supplier'],
      ['Sells', '4 of the service "Total"'],
      ['Described as', '"One fine-tuning run on the dataset sent"'],
      ['Price for each', '$100 USD'],
      ['Total', '$400 USD'],
      ['Counts as delivered when', '"The tuned weights are delivered to the buyer"'],
      ['Delivered within', '2 days'],
      ['Buyer cancels at no charge for', '2 hours'],
      ['Late-cancellation charge', '20%'],
      ['No-show charge', '50%'],
      ['Paid', 'By transfer, within 7 days of delivery'],
    ])
    const due = { ...sale.terms.offer.rules, payment: { route: 'transfer', dueAfterDelivery: 0n } }
    const atDelivery = changeWords({
      ...sale,
      terms: { ...sale.terms, offer: { ...sale.terms.offer, rules: due } },
    } as never)
    expect(atDelivery.rows.at(-1)).toEqual({ label: 'Paid', value: 'By transfer, at delivery' })
    // A sale can be made while its request is approved. A change waits until it's active.
    const at = base.requestedAt
    expect(isUsable({ ...sale, status: { state: 'approved', at } })).toBe(true)
    expect(isUsable({ ...sale, status: { state: 'active', at, transaction: null } })).toBe(false)
  })

  it("shows every limit a seller's mandate would set, and what on testnet is self-declared or simulated", () => {
    const terms = {
      signingKey: `0x${'5e'.repeat(20)}`,
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
    expect(words.rows.map((r) => [r.label, afterOf(r)])).toEqual([
      ['Signing key', `0x${'5e'.repeat(20)}`],
      // An agent names what it sells, so each name shows in quotes after a label the card wrote.
      ['The job "fine-tuning"', 'From $100 a job, up to 3 a day'],
      ['Any other service', 'From $40 a unit, up to 4 an order and 10 a day'],
      ['The service "Bulk eval"', 'Any price a unit, up to 8 an order and 20 a day'],
      ['Sells in', 'USD'],
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
      ['Terms it may bargain over', 'None'],
      ['A person decides', 'Sales over $300'],
      ['Ends', '2027-02-14T08:00:00.000Z'],
    ])
    expect(new Set(words.rows.map(beforeOf))).toEqual(new Set(['Not set']))
    const replacing = changeWords({
      ...asked,
      reason: 'seller_limits',
      basis: { sellerMandate: `0x${'33'.repeat(32)}` },
    })
    expect(replacing.title).toBe('Change what the agent may sell')
    expect(replacing.rows.map(beforeOf)[0]).toBe('Set by the mandate this replaces')

    // Every other way the terms can read, with amounts written exactly however large they are.
    const after = (change: object) =>
      Object.fromEntries(
        changeWords({ ...asked, terms: { ...terms, ...change } }).rows.map((r) => [
          r.label,
          afterOf(r),
        ]),
      )
    const big = 10n ** 22n + 1n
    const other = after({
      limits: [
        { ...terms.limits[0], item: null },
        { ...terms.limits[2], item: 'Most for one order' },
      ],
      maxOrderValue: big,
      maxOutstanding: big,
      maxFreeCancelWindow: 0n,
      buyers: ['biz_a', 'biz_b'],
      excludedBuyers: [],
      excludedCountries: [],
      requiresBusinessCheck: false,
      approvalRule: { kind: 'above', amount: big - 1n },
      expiry: 253_402_300_799n,
    })
    expect(other['Any other job']).toBe('From $100 a job, up to 3 a day')
    // A service named as a row of the card is still read as a service's name.
    expect(other['The service "Most for one order"']).toBeDefined()
    expect(other['Most for one order']).toBe('$10,000,000,000,000,000.000001')
    expect(other['A person decides']).toBe('Sales over $10,000,000,000,000,000')
    expect(other['Longest free cancellation for a service']).toBe('None')
    expect(other.Buyers).toBe('Only biz_a, biz_b')
    expect(other.Ends).toBe('9999-12-31T23:59:59.000Z')
    expect(after({ approvalRule: { kind: 'always' } })['A person decides']).toBe('Every sale')
    expect(after({ approvalRule: { kind: 'never' } })['A person decides']).toBe('No sale')
  })
})
