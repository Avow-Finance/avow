import { dollars, parseServiceOrder, SANDBOX_PATHS, SERVICE_CATEGORY } from '@avow-finance/spec'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { folderWithAgent, json, wire } from '../test/agent-folder.js'
import { deployment, LOCK } from '../test/sandbox-business.js'
import { loadCommitments } from './store.js'

const commits = vi.fn()
/** What the buyer's lock holds for the commitment, as far as these tests go. */
let onLock: { state: string } | null = null

vi.mock('../moderato.js', async (original) => ({
  ...(await original<typeof import('../moderato.js')>()),
  moderatoClient: () => ({ readContract: async () => LOCK }),
}))
// Funding goes to Avow and the chain, so the tests stand in for the two calls that do.
vi.mock('./mailbox-context.js', async (original) => {
  const real = await original<typeof import('./mailbox-context.js')>()
  return {
    ...real,
    mailboxContext: async (o: Parameters<typeof real.mailboxContext>[0]) => ({
      ...(await real.mailboxContext(o)),
      held: async () => onLock,
      commit: commits,
      supplierProfile: async (businessId: string) => ({ businessId }),
    }),
  }
})

const { sandboxServices } = await import('./services.js')

const BUYER = 'sandbox-buyer'
const SELLER = 'sandbox-seller'
const HOUR = 3600n
const FUNDED = `0x${'aa'.repeat(32)}`
const ACCEPTED = `0x${'bb'.repeat(32)}`

const draft = {
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
} as const

const folder = (businessId: string, sells = false) =>
  folderWithAgent(businessId, { sells, suppliers: [SELLER], categories: [SERVICE_CATEGORY] })

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

/**
 * A mailbox for one order between a buyer and a seller in two folders. It keeps the request and
 * the quote it's sent, and moves the order on as each side reports, as Avow's does.
 */
async function twoAgents() {
  const buyer = await folder(BUYER)
  const seller = await folder(SELLER, true)
  let request: Record<string, unknown> = {}
  let quote: unknown = null
  let status = 'requested'
  const reported: { path: string; body: Record<string, unknown> }[] = []
  const reserve = () => ({
    fundedIn: reported.find((r) => r.path.endsWith('/reserved'))?.body.fundedIn ?? null,
    amount: String(dollars(50)),
    acceptBy: String(Math.floor(Date.now() / 1000) + 600),
  })
  const order = () =>
    held(request, status, {
      ...(status === 'requested' ? {} : { quote }),
      ...(status === 'reserved' || status === 'accepted' ? { reserve: reserve() } : {}),
      ...(status === 'accepted' ? { acceptedIn: ACCEPTED } : {}),
    })
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    if (path === '/config.json') return json(wire(deployment))
    const body = init?.body ? JSON.parse(new TextDecoder().decode(init.body as Uint8Array)) : {}
    if (path === SANDBOX_PATHS.serviceOrders) {
      request = body
    } else if (path.endsWith('/quote')) {
      quote = body
      status = 'quoted'
    } else if (path.endsWith('/reserved')) {
      reported.push({ path, body })
      // The supplier accepts as soon as the reserve is reported, which the next read shows.
      const now = held(request, 'reserved', { quote, reserve: reserve() })
      status = 'accepted'
      return json(now)
    }
    return json(order())
  }) as typeof globalThis.fetch
  return {
    buying: await sandboxServices({ store: buyer.store, fetch }),
    selling: await sandboxServices({ store: seller.store, fetch }),
    store: buyer.store,
    order,
    reported,
  }
}

beforeEach(() => {
  commits.mockReset()
  onLock = null
})

describe('a service order between two agents', () => {
  it('is quoted by the seller, funded once by the buyer, and listed among its commitments', async () => {
    const two = await twoAgents()
    const { version } = await two.selling.publish(draft)
    const placed = await two.buying.order({ offer: version, quantity: 2 })
    const waiting = parseServiceOrder(two.order())
    if (!waiting) throw new Error("the mailbox's order didn't parse")
    await two.selling.sell(waiting)

    commits.mockResolvedValue({ ok: true, commitment: { reservedIn: FUNDED }, dependencies: [] })
    const steps: string[] = []
    const outcome = await two.buying.buy({
      resume: placed.orderId,
      pollEvery: 1,
      onStep: (s) => steps.push(s.step),
    })
    expect(outcome.ok).toBe(true)
    expect(steps).toEqual(['ordered', 'quoted', 'reserved', 'accepted'])
    // The buyer funds the seller's signed quote as it came, for the seller Avow registered.
    expect(commits).toHaveBeenCalledTimes(1)
    const funded = commits.mock.calls[0]?.[0]
    expect(funded.supplier).toEqual({ businessId: SELLER })
    expect(funded.terms.backing.amount).toBe(dollars(50))
    expect(funded.agreement.commitmentId).toBe(placed.commitmentId)
    expect(two.reported.map((r) => r.body)).toEqual([{ fundedIn: FUNDED }])
    // The commitment is one of the agent's own from then on, at the reserve the terms name.
    expect(await loadCommitments(two.store)).toEqual([
      expect.objectContaining({
        amount: dollars(50),
        supplier: SELLER,
        reference: expect.objectContaining({
          lock: LOCK.toLowerCase(),
          commitmentId: placed.commitmentId,
          termsHash: funded.agreement.termsHash,
          side: 'buyer',
        }),
      }),
    ])
    expect(await two.buying.unfinished()).toEqual([])
  })

  it('never funds a commitment the lock already holds, after a run that stopped part way', async () => {
    const two = await twoAgents()
    const { version } = await two.selling.publish(draft)
    const placed = await two.buying.order({ offer: version, quantity: 2 })
    const waiting = parseServiceOrder(two.order())
    if (!waiting) throw new Error("the mailbox's order didn't parse")
    await two.selling.sell(waiting)
    // An earlier run funded the reserve and stopped before it told the mailbox.
    onLock = { state: 'reserved' }
    const outcome = await two.buying.buy({ resume: placed.orderId, pollEvery: 1 })
    expect(outcome.ok).toBe(true)
    expect(commits).not.toHaveBeenCalled()
    expect(two.reported.map((r) => r.body)).toEqual([{ fundedIn: null }])
    expect(await loadCommitments(two.store)).toHaveLength(1)
  })

  it("reserves nothing when the buyer's own limits refuse the quote", async () => {
    const two = await twoAgents()
    const { version } = await two.selling.publish(draft)
    const placed = await two.buying.order({ offer: version, quantity: 2 })
    const waiting = parseServiceOrder(two.order())
    if (!waiting) throw new Error("the mailbox's order didn't parse")
    await two.selling.sell(waiting)
    commits.mockResolvedValue({ ok: false, reason: 'mandate.over_commitment_cap', layer: 'sdk' })
    const outcome = await two.buying.buy({ resume: placed.orderId, pollEvery: 1 })
    expect(outcome).toMatchObject({ ok: false, reason: 'mandate.over_commitment_cap' })
    expect(two.reported).toEqual([])
    expect(await loadCommitments(two.store)).toEqual([])
  })
})

describe("an offer's bookings for the day", () => {
  it('are counted by the seller as it quotes, once an order, and refused past the capacity', async () => {
    const two = await twoAgents()
    await two.selling.publish({ ...draft, rules: { ...draft.rules, dailyCapacity: 1 } })
    const [published] = await two.selling.published()
    if (!published) throw new Error('nothing was published')
    await two.buying.order({ offer: published, quantity: 1 })
    const first = parseServiceOrder(two.order())
    if (!first) throw new Error("the mailbox's order didn't parse")
    await two.selling.sell(first)
    // Quoting the same order again, after a send that failed, takes no second place.
    await two.selling.sell(first)
    const second = { ...first, orderId: 'ef'.repeat(16) }
    await expect(two.selling.sell(second)).rejects.toThrow('capacity for the day')
    // Another item's bookings are its own.
    const other = await two.selling.publish({ ...draft, item: { ...draft.item, name: 'Summary' } })
    await two.selling.sell({ ...second, offer: other.version })
  })
})
