import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  offerVersionId,
  parseServiceQuote,
  SANDBOX_PATHS,
  SERVICE_CATEGORY,
  serviceQuoteProblem,
  toWire,
} from '@avow-finance/spec'
import { describe, expect, it, vi } from 'vitest'
import { NO_SELLER_MANDATE } from '../sandbox/seller-mandate.js'
import { folderWithAgent, json, wire } from '../test/agent-folder.js'
import { deployment, LOCK } from '../test/sandbox-business.js'
import { testPing, testSellersList } from '../test/test-sellers.js'
import { fileStore, SANDBOX_DIR } from './platform.js'
import { readSharedOffer } from './services.js'

// The lock holds nothing under the agent's mandate, and its key can still move $1,000 today.
vi.mock('../lock.js', async (original) => ({
  ...(await original<typeof import('../lock.js')>()),
  readOpenReserves: async () => 0n,
}))
vi.mock('../moderato.js', async (original) => ({
  ...(await original<typeof import('../moderato.js')>()),
  moderatoClient: () => ({
    readContract: async (call: { functionName: string }) =>
      call.functionName === 'getRemainingLimitWithPeriod' ? [1_000_000_000n, 0n] : LOCK,
  }),
}))

const { mcpAgent } = await import('./mcp.js')

const BUYER = 'sandbox-buyer'
const SELLER = 'sandbox-seller'
const settlement = {
  arbiter: deployment.arbiter,
  day90SupplierShareBps: deployment.day90SupplierShareBps,
}
const asked = {
  name: 'Transcript',
  summary: 'One hour of audio transcribed into English text',
  price: 50,
  evidence: 'The transcript is delivered to the buyer as a text file',
  late_cancellation_percent: 20,
  no_show_percent: 50,
  max_per_booking: 10,
}

/** A folder on disk with a connected agent, as the MCP server finds one. */
async function folder(businessId: string, sells = false) {
  const made = await folderWithAgent(businessId, {
    sells,
    suppliers: [SELLER],
    categories: [SERVICE_CATEGORY],
  })
  const dir = mkdtempSync(join(tmpdir(), 'avow-mcp-services-'))
  const store = fileStore(join(dir, SANDBOX_DIR))
  for (const item of ['agent', 'supplier'] as const) {
    const text = await made.store.read(item)
    if (text !== null) await store.write(item, text)
  }
  return dir
}

/** Avow's API as far as a test needs it: the deployment, then whatever the test answers. */
function avow(answer: (path: string, body: Record<string, unknown>) => Response | null) {
  const paths: string[] = []
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    paths.push(path)
    if (path === '/config.json') return json(wire(deployment))
    const body = init?.body ? JSON.parse(new TextDecoder().decode(init.body as Uint8Array)) : {}
    return (
      answer(path, body) ??
      json({ error: { reason: 'request.invalid', message: 'No such route' } }, 404)
    )
  }) as typeof globalThis.fetch
  return { fetch, paths }
}

const held = (request: Record<string, unknown>, status: string, extra = {}) => ({
  ...request,
  buyer: {
    businessId: BUYER,
    account: LOCK,
    lock: LOCK,
    chainId: deployment.chainId,
    mandateHash: `0x${'cd'.repeat(32)}`,
  },
  requestedAt: '1800000000',
  status,
  ...extra,
})

describe("the MCP server's tools for services", () => {
  it("publish a supplier's offer in its folder and hand back what a buyer orders from", async () => {
    const { fetch, paths } = avow(() => null)
    const seller = mcpAgent(await folder(SELLER, true), { fetch })
    const none = await seller.call('offers', {})
    expect(none.text).toMatch(/published no offers/)
    const published = await seller.call('publish_offer', asked)
    expect(published.isError).toBe(false)
    expect(published.text).toMatch(/The offer wasn't sent to Avow/)
    // Avow serves no seller's mandate here, which the answer says plainly.
    expect(published.text).toContain(NO_SELLER_MANDATE)
    const offer = readSharedOffer(published.structured.offer)
    if (!offer) throw new Error('the answer carried no offer')
    expect(offer.supplier).toBe(SELLER)
    expect(published.structured.id).toBe(offerVersionId(offer))
    // The text carries the same offer, for a client that shows a model only the text.
    expect(readSharedOffer(published.text.slice(published.text.indexOf('{"')))).toEqual(offer)
    const listed = await seller.call('offers', {})
    expect(listed.structured.offers).toEqual([published.structured])
    // An offer the template refuses is refused with its reason, and nothing is kept.
    const free = await seller.call('publish_offer', {
      ...asked,
      name: 'Summary',
      late_cancellation_percent: 0,
      no_show_percent: 0,
    })
    expect(free.isError).toBe(true)
    expect((await seller.call('offers', {})).structured.offers).toHaveLength(1)
    // Publishing reaches Avow for nothing but the deployment and the agent's seller's mandates.
    expect(new Set(paths)).toEqual(new Set(['/config.json', SANDBOX_PATHS.sellerMandates]))
  })

  it('check an order from the offer without sending it, with the price beside what is reserved', async () => {
    const sellerSide = mcpAgent(await folder(SELLER, true), { fetch: avow(() => null).fetch })
    const { structured } = await sellerSide.call('publish_offer', asked)
    const account = '0x00000000000000000000000000000000000000c3'
    const { fetch, paths } = avow((path) =>
      path === SANDBOX_PATHS.supplier(SELLER)
        ? json({ businessId: SELLER, account, payee: account, signingKey: account })
        : null,
    )
    const buyer = mcpAgent(await folder(BUYER), { fetch })
    const passes = await buyer.call('check', { offer: structured.offer, quantity: 2 })
    expect(passes.isError).toBe(false)
    expect(passes.structured).toMatchObject({
      status: 'would_pass',
      supplier: SELLER,
      quantity: 2,
      price: 100,
      amounts: { needed: 50, heldAtOnce: 1000, perCommitment: 500 },
    })
    expect(passes.text).toMatch(/would pass now, and nothing was ordered/)
    expect(passes.text).toMatch(/reserve \$50.*The price is \$100, paid outside the lock/)
    expect(passes.text).toMatch(/whether the seller still publishes this version of the offer/)
    // More units than one booking takes can't be priced, and the answer says so with its code.
    const tooMany = await buyer.call('check', { offer: structured.offer, quantity: 11 })
    expect(tooMany.structured).toMatchObject({
      status: 'would_be_refused',
      code: 'terms.template_invalid',
      layer: 'sdk',
      price: null,
    })
    // A check is of one thing or the other.
    const both = await buyer.call('check', { offer: structured.offer, reserve: 100 })
    expect(both.isError).toBe(true)
    // No order was sent, and the seller's agent was asked nothing.
    expect(paths).not.toContain(SANDBOX_PATHS.serviceOrders)
    expect(paths.filter((p) => p === SANDBOX_PATHS.supplier(SELLER))).toHaveLength(1)
  })

  it('order from the offer, send one order however often it is asked, and say when it lapses', async () => {
    const sellerSide = mcpAgent(await folder(SELLER, true), { fetch: avow(() => null).fetch })
    const { structured } = await sellerSide.call('publish_offer', asked)
    const sent: Record<string, unknown>[] = []
    let status = 'requested'
    const { fetch, paths } = avow((path, body) => {
      if (path === SANDBOX_PATHS.serviceOrders) {
        if (!sent.some((s) => s.orderId === body.orderId)) sent.push(body)
        return json(held(body, status, status === 'expired' ? { quote: null } : {}))
      }
      const order = sent[0]
      if (order && path === SANDBOX_PATHS.serviceOrder(String(order.orderId))) {
        return json(held(order, status, status === 'expired' ? { quote: null } : {}))
      }
      return null
    })
    const dir = await folder(BUYER)
    const buyer = mcpAgent(dir, { fetch, pollEvery: 20 })
    const garbled = await buyer.call('order', { offer: { name: 'Transcript' } })
    expect(garbled.isError).toBe(true)
    expect(garbled.text).toMatch(/Give the offer, whole/)
    expect(sent).toEqual([])

    status = 'expired'
    const lapsed = await buyer.call('order', { offer: structured.offer, quantity: 2 })
    expect(lapsed.isError).toBe(false)
    expect(lapsed.text).toMatch(/costs \$100 and reserves \$50/)
    expect(lapsed.text).toMatch(/lapsed, and nothing was reserved/)
    expect(lapsed.structured).toMatchObject({
      status: 'expired',
      ended: 'order.expired',
      supplier: SELLER,
      quantity: 2,
      price: 100,
      reserve: 50,
      link: null,
    })
    expect(sent).toHaveLength(1)
    expect(paths.some((p) => p.includes('/reserved') || p.includes('reserve-approvals'))).toBe(
      false,
    )
    // Asked about again by its id, it answers from the mailbox and sends nothing new.
    const again = await buyer.call('order', { order: lapsed.structured.order })
    expect(again.structured).toMatchObject({ status: 'expired', ended: null })
    expect(sent).toHaveLength(1)
    expect((await buyer.call('orders', {})).text).toMatch(/wasn't connected to sell/)
  })

  it('show a supplier its inbox, and quote only an order for an offer it published', async () => {
    const posted: { path: string; body: Record<string, unknown> }[] = []
    let inbox: unknown[] = []
    const { fetch } = avow((path, body) => {
      posted.push({ path, body })
      if (path === SANDBOX_PATHS.serviceInbox) return json({ orders: inbox })
      return path.endsWith('/quote') ? json(inbox[0]) : null
    })
    const seller = mcpAgent(await folder(SELLER, true), { fetch })
    const { structured } = await seller.call('publish_offer', asked)
    const builtAt = String(Math.floor(Date.now() / 1000))
    const request = {
      orderId: 'ab'.repeat(16),
      commitmentId: `0x${'12'.repeat(32)}`,
      offer: structured.offer,
      quantity: 2,
      builtAt,
      expiry: String(Number(builtAt) + 600),
    }
    inbox = [held(request, 'requested')]
    const waiting = await seller.call('orders', {})
    expect(waiting.text).toMatch(/To your business\. Order abab.+Call sell to quote it\./)
    expect(waiting.structured.selling).toEqual([
      expect.objectContaining({ order: request.orderId, status: 'requested', reserve: 50 }),
    ])
    const quoted = await seller.call('sell', { order: request.orderId })
    expect(quoted.isError).toBe(false)
    expect(quoted.structured).toMatchObject({ step: 'quoted', buyer: BUYER })
    const quote = parseServiceQuote(posted.find((p) => p.path.endsWith('/quote'))?.body)
    const offer = readSharedOffer(structured.offer)
    if (!quote || !offer) throw new Error('no quote was sent')
    expect(
      serviceQuoteProblem(
        {
          offer,
          quantity: 2,
          builtAt: BigInt(builtAt),
          commitmentId: request.commitmentId as `0x${string}`,
        },
        quote,
        settlement,
      ),
    ).toBeNull()

    // The same item at a price the buyer wrote is an offer this business never published.
    inbox = [
      held(
        { ...request, offer: { ...(structured.offer as object), unitPrice: '1000000' } },
        'requested',
      ),
    ]
    posted.length = 0
    const forged = await seller.call('sell', { order: request.orderId })
    expect(forged.isError).toBe(true)
    expect(forged.text).toMatch(/hasn't published/)
    expect(posted.some((p) => p.path.endsWith('/quote'))).toBe(false)
    const gone = await seller.call('sell', { order: 'cd'.repeat(16) })
    expect(gone.isError).toBe(true)
    expect(gone.text).toMatch(/No order cdcd/)
  })

  it('send one order while the first is still open, and say whether anything is seeing it through', async () => {
    const sellerSide = mcpAgent(await folder(SELLER, true), { fetch: avow(() => null).fetch })
    const { structured } = await sellerSide.call('publish_offer', asked)
    const sent: Record<string, unknown>[] = []
    let status = 'requested'
    const { fetch } = avow((path, body) => {
      const extra = status === 'expired' ? { quote: null } : {}
      if (path === SANDBOX_PATHS.serviceOrders) {
        if (!sent.some((s) => s.orderId === body.orderId)) sent.push(body)
        return json(held(body, status, extra))
      }
      // The mailbox knows one more order, which this folder never kept.
      const id = path.split('/').pop()
      const order = sent.find((s) => s.orderId === id) ?? { ...sent[0], orderId: id }
      return json(held(order, status, extra))
    })
    const buyer = mcpAgent(await folder(BUYER), { fetch, pollEvery: 10, orderWait: 40 })
    const first = await buyer.call('order', { offer: structured.offer, quantity: 2 })
    expect(first.text).toMatch(/keeps seeing it through while it runs/)
    expect(first.structured).toMatchObject({ status: 'requested', seeingThrough: true })
    // A client that asks again, after a timeout or a lost answer, gets the same order.
    const again = await buyer.call('order', { offer: structured.offer, quantity: 2 })
    expect(again.text).toMatch(/You had sent this order already/)
    expect(again.structured.order).toBe(first.structured.order)
    expect(sent).toHaveLength(1)
    const listed = await buyer.call('orders', {})
    expect(listed.structured.buying).toEqual([
      expect.objectContaining({ order: first.structured.order, status: 'requested' }),
    ])
    // An order this folder doesn't keep is only read, and the answer says so.
    const other = await buyer.call('order', { order: 'cd'.repeat(16) })
    expect(other.text).toMatch(/isn't seeing that order through/)
    expect(other.structured).toMatchObject({ seeingThrough: false, ended: null })
    expect(sent).toHaveLength(1)
    // Once the first has ended, the same offer and quantity is a new order.
    status = 'expired'
    const ended = await buyer.call('order', { order: first.structured.order })
    expect(ended.structured).toMatchObject({ ended: 'order.expired', seeingThrough: false })
    status = 'requested'
    const second = await buyer.call('order', { offer: structured.offer, quantity: 2 })
    expect(second.structured.order).not.toBe(first.structured.order)
    expect(sent).toHaveLength(2)
    status = 'expired'
    await buyer.call('order', { order: second.structured.order })
  })

  it("tell a supplier when the sandbox can't carry service orders, and take no step it has none of", async () => {
    let inbox: unknown[] | null = null
    const { fetch } = avow((path) =>
      path === SANDBOX_PATHS.serviceInbox && inbox ? json({ orders: inbox }) : null,
    )
    const seller = mcpAgent(await folder(SELLER, true), { fetch })
    const { structured } = await seller.call('publish_offer', asked)
    const unserved = await seller.call('orders', {})
    expect(unserved.isError).toBe(true)
    expect(unserved.text).toMatch(/doesn't carry service orders yet/)
    // A quoted order waits on the buyer, so selling it does nothing and says nothing was done.
    const builtAt = String(Math.floor(Date.now() / 1000))
    const request = {
      orderId: 'ab'.repeat(16),
      commitmentId: `0x${'12'.repeat(32)}`,
      offer: structured.offer,
      quantity: 1,
      builtAt,
      expiry: String(Number(builtAt) + 600),
    }
    inbox = [held(request, 'expired', { quote: null })]
    const nothing = await seller.call('sell', { order: request.orderId })
    expect(nothing.isError).toBe(false)
    expect(nothing.structured.step).toBeNull()
    expect(nothing.text).toMatch(/no step for your business/)
    expect(nothing.text).not.toMatch(/Accepted|Quoted/)
    // An order for an offer the buyer wrote is shown as one sell won't quote.
    inbox = [
      held(
        { ...request, offer: { ...(structured.offer as object), unitPrice: '1000000' } },
        'requested',
      ),
    ]
    expect((await seller.call('orders', {})).text).toMatch(
      /haven't published, so sell won't quote it/,
    )
  })

  it('refuse to sell for an agent connected only to buy', async () => {
    const buyer = mcpAgent(await folder(BUYER), { fetch: avow(() => null).fetch })
    const answer = await buyer.call('sell', { order: 'ab'.repeat(16) })
    expect(answer.isError).toBe(true)
    expect(answer.text).toMatch(/--sell/)
  })

  it('list the test sellers as test businesses with their offers whole, and say when there are none', async () => {
    const sandbox = (extra: Record<string, unknown>) =>
      (async () => json({ ...wire(deployment), ...extra })) as unknown as typeof fetch
    // Listing needs no connection, so a folder with no agent in it lists them too.
    const dir = mkdtempSync(join(tmpdir(), 'avow-mcp-services-'))
    const listed = await mcpAgent(dir, { fetch: sandbox({ testSellers: testSellersList }) }).call(
      'test_sellers',
      {},
    )
    expect(listed.isError).toBe(false)
    expect(listed.structured.sellers).toEqual([
      {
        businessId: testPing.supplier,
        name: 'Test Seller One (test business)',
        label: 'test business',
        offers: [{ id: offerVersionId(testPing), offer: wire(testPing) }],
      },
    ])
    expect(listed.text).toContain('Test Seller One (test business), the test business sandbox-')
    expect(listed.text).toContain('Nothing it sells is delivered or billed.')
    expect(listed.text).toContain(JSON.stringify(toWire(testPing)))
    expect(listed.text).not.toMatch(/verified/i)
    // The offer as listed is one the order tool reads.
    const [first] = listed.structured.sellers as { offers: { offer: unknown }[] }[]
    expect(readSharedOffer(first?.offers[0]?.offer)).toEqual(testPing)
    const none = await mcpAgent(dir, { fetch: sandbox({}) }).call('test_sellers', {})
    expect(none).toEqual({
      text: expect.stringMatching(/^The sandbox lists no test sellers/),
      structured: { sellers: [] },
      isError: false,
    })
  })
})
