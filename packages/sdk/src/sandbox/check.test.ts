import {
  dollars,
  JOB_CATEGORY,
  mandateHash,
  SANDBOX_PATHS,
  SERVICE_CATEGORY,
  type ServiceOfferVersion,
} from '@avow-finance/spec'
import { generatePrivateKey } from 'viem/accounts'
import { Account } from 'viem/tempo'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { accountSigner, signMandate } from '../sign.js'
import { deployment, domain, LOCK, supplier, TOKEN } from '../test/sandbox-business.js'
import { sandboxMandate } from './mandate.js'
import { memoryStore, saveAgentItem } from './store.js'

// What the lock holds under the mandate and what the key can still move today, in base units.
const chain = vi.hoisted(() => ({ open: 0n, leftToday: 0n, sent: 0, toSeller: 0 }))
vi.mock('../lock.js', async (original) => ({
  ...(await original<typeof import('../lock.js')>()),
  readOpenReserves: async () => chain.open,
}))
vi.mock('../moderato.js', async (original) => ({
  ...(await original<typeof import('../moderato.js')>()),
  moderatoClient: () => ({
    readContract: async (call: { functionName: string }) => {
      if (call.functionName === 'getRemainingLimitWithPeriod') return [chain.leftToday, 0n]
      throw new Error(`unexpected read ${call.functionName}`)
    },
  }),
}))

const { sandboxAgent } = await import('./agent.js')

const SELLER = 'sandbox-00000000000000000000000000000000000000c3'
const STRANGER = 'sandbox-00000000000000000000000000000000000000d4'

/**
 * An agent enrolled with $500 a commitment, $1,000 held at once and $1,000 a day, for the example
 * supplier's compute unless `o` names other suppliers and categories.
 */
async function enrolled(
  o: { suppliers?: string[]; categories?: string[]; days?: bigint; priceCap?: bigint } = {},
) {
  const root = Account.fromSecp256k1(generatePrivateKey())
  const agentKey = generatePrivateKey()
  const agent = Account.fromSecp256k1(agentKey, { access: root.address })
  const message = sandboxMandate({
    businessId: 'sandbox-business',
    agentId: 'agt_test',
    account: root.address,
    agentKey: agent.accessKeyAddress,
    suppliers: o.suppliers ?? [supplier.id],
    ...(o.categories ? { categories: o.categories } : {}),
    token: TOKEN,
    capPerCommitment: dollars(500),
    capOpenReserves: dollars(1000),
    ...(o.priceCap === undefined ? {} : { priceCapPerCommitment: o.priceCap }),
    dailyLimit: dollars(1000),
    expiry: BigInt(Math.floor(Date.now() / 1000)) + (o.days ?? 300n) * 86_400n,
  })
  const store = memoryStore()
  await saveAgentItem(store, {
    agentKey,
    business: {
      chainId: deployment.chainId,
      apiUrl: deployment.apiUrl,
      factory: deployment.factory,
      token: TOKEN,
      account: root.address,
      lock: LOCK,
      businessId: 'sandbox-business',
    },
    mandate: await signMandate(message, domain, accountSigner(root.address, root)),
    mandateHash: mandateHash(message, domain),
    keyAuthorizedIn: `0x${'ab'.repeat(32)}`,
    suppliers: [supplier],
  })
  // Anything sent anywhere is counted, since a check sends nothing. The agent reads its mandates
  // from Avow once when it starts, which this API answers it has no route for, so the agent keeps
  // the one it was enrolled with.
  const fetch = (async (input: string | URL | Request) => {
    if (String(input).endsWith(SANDBOX_PATHS.agentMandates)) {
      return Response.json({ error: { code: 'request.invalid' } }, { status: 404 })
    }
    // Avow publishes the seller's profile, and has none for a business it doesn't know.
    if (String(input).endsWith(SANDBOX_PATHS.supplier(SELLER))) {
      chain.toSeller++
      const account = '0x00000000000000000000000000000000000000c3'
      return Response.json({ businessId: SELLER, account, payee: account, signingKey: account })
    }
    if (String(input).endsWith(SANDBOX_PATHS.supplier(STRANGER))) {
      return Response.json({ error: { reason: 'supplier.unknown' } }, { status: 404 })
    }
    chain.sent++
    return new Response('{}', { status: 500 })
  }) as typeof globalThis.fetch
  return sandboxAgent({ store, deployment, session: null, fetch, log: () => {} })
}

const booking = (reserve: number, s = supplier.id) => ({
  supplier: s,
  resource: { gpu: 'H100', count: 8, hours: 1 },
  reserve,
})

beforeEach(() => {
  chain.open = 0n
  chain.leftToday = dollars(1000)
  chain.sent = 0
  chain.toSeller = 0
})

describe("checking a booking before it's made", () => {
  it('passes a booking inside every limit, with the amounts behind it, and sends nothing', async () => {
    chain.open = dollars(200)
    chain.leftToday = dollars(800)
    const agent = await enrolled()
    expect(await agent.check(booking(300))).toEqual({
      passes: true,
      amounts: {
        needed: dollars(300),
        left: dollars(800),
        authority: dollars(1000),
        capPerCommitment: dollars(500),
        price: dollars(24),
        priceCapPerCommitment: null,
        dailyLimit: dollars(1000),
        dailyLeft: dollars(800),
      },
    })
    expect(chain.sent).toBe(0)
  })

  it('holds a booking to the price limit, which only the SDK and Avow read', async () => {
    // Eight H100s for an hour at the example supplier's rate come to $24.
    const agent = await enrolled({ priceCap: dollars(23) })
    expect(agent.priceCapPerCommitment).toBe(23)
    expect(await agent.check(booking(300))).toMatchObject({
      passes: false,
      code: 'mandate.over_price_limit',
      layer: 'sdk',
      amounts: { price: dollars(24), priceCapPerCommitment: dollars(23) },
    })
    const roomy = await enrolled({ priceCap: dollars(24) })
    expect(await roomy.check(booking(300))).toMatchObject({ passes: true })
    expect((await enrolled()).priceCapPerCommitment).toBeNull()
    expect(chain.sent).toBe(0)
  })

  it('names the layer that would refuse each limit', async () => {
    const agent = await enrolled()
    // The SDK refuses a supplier the mandate doesn't name, and a reserve over the per-commitment cap.
    expect(await agent.check(booking(100, 'someone-else'))).toMatchObject({
      passes: false,
      code: 'mandate.supplier_not_allowed',
      layer: 'sdk',
    })
    expect(await agent.check(booking(600))).toMatchObject({
      passes: false,
      code: 'mandate.over_commitment_cap',
      layer: 'sdk',
    })
    // Avow refuses what would take the lock's open reserves past the cap.
    chain.open = dollars(700)
    expect(await agent.check(booking(400))).toMatchObject({
      passes: false,
      code: 'mandate.over_open_reserves_cap',
      layer: 'avow',
      amounts: { left: dollars(300) },
    })
    // The keychain refuses what the key can't move today.
    chain.open = 0n
    chain.leftToday = dollars(250)
    expect(await agent.check(booking(300))).toMatchObject({
      passes: false,
      code: 'keychain.over_daily_limit',
      layer: 'keychain',
      amounts: { dailyLeft: dollars(250) },
    })
    expect(chain.sent).toBe(0)
  })
})

const HOUR = 3600n

/** Transcription at $50 a unit. Not taking delivery can cost half the price, the larger charge. */
const transcripts = (from = SELLER): ServiceOfferVersion => ({
  supplier: from,
  item: { name: 'Transcript', summary: 'One hour of audio transcribed into English text' },
  currency: 'USD',
  unitPrice: dollars(50),
  rules: {
    evidence: 'The transcript is delivered to the buyer as a text file',
    leadTime: 24n * HOUR,
    maxPerBooking: 10,
    dailyCapacity: 20,
    freeCancelWindow: 2n * HOUR,
    lateCancellationBps: 2_000,
    noShowBps: 5_000,
    payment: { route: 'transfer', dueAfterDelivery: 7n * 24n * HOUR },
  },
})

/** A buyer whose mandate names the seller and the categories an order between businesses needs. */
const buyer = (
  o: { suppliers?: string[]; categories?: string[]; days?: bigint; priceCap?: bigint } = {},
) =>
  enrolled({
    suppliers: [SELLER, STRANGER, 'sandbox-business'],
    categories: ['compute', JOB_CATEGORY, SERVICE_CATEGORY],
    ...o,
  })

describe("checking a service order before it's sent", () => {
  it('passes an order inside every limit, with the price and the reserve, and orders nothing', async () => {
    chain.open = dollars(200)
    const agent = await buyer()
    // Four units cost $200, and reserve half of that.
    expect(await agent.checkOrder({ offer: transcripts(), quantity: 4 })).toEqual({
      passes: true,
      price: dollars(200),
      amounts: {
        needed: dollars(100),
        left: dollars(800),
        authority: dollars(1000),
        capPerCommitment: dollars(500),
        price: dollars(200),
        priceCapPerCommitment: null,
        dailyLimit: dollars(1000),
        dailyLeft: dollars(1000),
      },
    })
    // It asked Avow whether it knows the seller, and nothing else left the machine.
    expect(chain.toSeller).toBe(1)
    expect(chain.sent).toBe(0)
  })

  it("refuses an order whose price is over the mandate's price limit", async () => {
    const agent = await buyer({ priceCap: dollars(150) })
    expect(await agent.checkOrder({ offer: transcripts(), quantity: 4 })).toMatchObject({
      passes: false,
      code: 'mandate.over_price_limit',
      layer: 'sdk',
      price: dollars(200),
    })
    expect(await agent.checkOrder({ offer: transcripts(), quantity: 3 })).toMatchObject({
      passes: true,
    })
  })

  it("refuses an offer that can't be priced in that quantity, before anything is read", async () => {
    const agent = await buyer()
    for (const order of [
      { offer: transcripts(), quantity: 11 },
      { offer: transcripts(), quantity: 0 },
      { offer: { ...transcripts(), unitPrice: 0n }, quantity: 1 },
    ]) {
      expect(await agent.checkOrder(order)).toEqual({
        passes: false,
        code: 'terms.template_invalid',
        layer: 'sdk',
        price: null,
        amounts: null,
      })
    }
    expect(chain.sent).toBe(0)
  })

  it("refuses a seller the mandate doesn't name, and a mandate that names no services", async () => {
    const named = await buyer({ suppliers: [supplier.id] })
    expect(await named.checkOrder({ offer: transcripts(), quantity: 1 })).toMatchObject({
      passes: false,
      code: 'mandate.supplier_not_allowed',
      layer: 'sdk',
      price: dollars(50),
    })
    const computeOnly = await buyer({ categories: ['compute'] })
    expect(await computeOnly.checkOrder({ offer: transcripts(), quantity: 1 })).toMatchObject({
      passes: false,
      code: 'mandate.category_not_allowed',
      layer: 'sdk',
    })
  })

  it("refuses a seller Avow doesn't know, and an order a business sends itself", async () => {
    const agent = await buyer()
    expect(await agent.checkOrder({ offer: transcripts(STRANGER), quantity: 1 })).toMatchObject({
      passes: false,
      code: 'supplier.unknown',
      layer: 'avow',
    })
    const own = transcripts('sandbox-business')
    expect(await agent.checkOrder({ offer: own, quantity: 1 })).toMatchObject({
      passes: false,
      code: 'order.supplier_mismatch',
      layer: 'avow',
    })
  })

  it('counts the reserve against each limit, and never the price', async () => {
    const agent = await buyer()
    // Ten units cost $500 and reserve $250, inside a $500 cap on one commitment.
    expect(await agent.checkOrder({ offer: transcripts(), quantity: 10 })).toMatchObject({
      passes: true,
      price: dollars(500),
      amounts: { needed: dollars(250) },
    })
    // A dearer service's reserve passes the cap on one commitment.
    const dear = { ...transcripts(), unitPrice: dollars(200) }
    expect(await agent.checkOrder({ offer: dear, quantity: 10 })).toMatchObject({
      passes: false,
      code: 'mandate.over_commitment_cap',
      layer: 'sdk',
      price: dollars(2000),
      amounts: { needed: dollars(1000) },
    })
    // What the lock already holds leaves too little.
    chain.open = dollars(900)
    expect(await agent.checkOrder({ offer: transcripts(), quantity: 10 })).toMatchObject({
      passes: false,
      code: 'mandate.over_open_reserves_cap',
      layer: 'avow',
      amounts: { left: dollars(100) },
    })
    // The keychain refuses what the key can't move today.
    chain.open = 0n
    chain.leftToday = dollars(200)
    expect(await agent.checkOrder({ offer: transcripts(), quantity: 10 })).toMatchObject({
      passes: false,
      code: 'keychain.over_daily_limit',
      layer: 'keychain',
    })
  })

  it("refuses when the mandate ends before the commitment's window does", async () => {
    // A transcript is delivered a day after it's ordered, and its window ends after that.
    const agent = await buyer({ days: 1n })
    expect(await agent.checkOrder({ offer: transcripts(), quantity: 1 })).toMatchObject({
      passes: false,
      code: 'mandate.ends_before_window',
      layer: 'sdk',
    })
  })
})
