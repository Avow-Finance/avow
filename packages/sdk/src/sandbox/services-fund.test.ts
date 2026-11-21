import {
  dollars,
  offerVersionId,
  parseServiceOrder,
  SANDBOX_PATHS,
  SERVICE_CATEGORY,
  type ServiceOfferVersion,
  serviceOfferTerms,
  termsHash,
} from '@avow-finance/spec'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { folderWithAgent, json, wire } from '../test/agent-folder.js'
import { deployment, LOCK } from '../test/sandbox-business.js'
import { loadCommitments } from './store.js'

const commits = vi.fn()
const accepts = vi.fn()
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
      accept: accepts,
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

const offer: ServiceOfferVersion = { ...draft, supplier: SELLER }

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
    /** Changes the order as the mailbox holds it, as a faulty mailbox could. */
    tamper(change: (request: Record<string, unknown>) => Record<string, unknown>) {
      request = change(request)
    },
    at(next: string) {
      status = next
    },
  }
}

beforeEach(() => {
  commits.mockReset()
  accepts.mockReset()
  onLock = null
  vi.restoreAllMocks()
})

/** Moves the clock every reader of the time sees, by seconds. */
function later(seconds: number) {
  const now = Date.now() + seconds * 1000
  vi.spyOn(Date, 'now').mockReturnValue(now)
}

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

describe("the buyer's own order", () => {
  it('is what the quote is checked against, whatever the mailbox says the order was', async () => {
    const two = await twoAgents()
    const { version } = await two.selling.publish(draft)
    const placed = await two.buying.order({ offer: version, quantity: 1 })
    // The mailbox now holds ten units of a dearer version under the same order id, and the
    // seller honestly quotes what it was shown.
    const dearer = await two.selling.publish({ ...draft, unitPrice: dollars(90) })
    two.tamper((request) => ({ ...request, offer: wire(dearer.version), quantity: 10 }))
    const shown = parseServiceOrder(two.order())
    if (!shown) throw new Error("the mailbox's order didn't parse")
    await two.selling.sell(shown)
    const outcome = await two.buying.buy({ resume: placed.orderId, pollEvery: 1 })
    expect(outcome).toMatchObject({ ok: false, reason: 'order.terms_changed' })
    expect(commits).not.toHaveBeenCalled()
    expect(two.reported).toEqual([])
  })

  it('counts as funded when another run of the agent reserved it first', async () => {
    const two = await twoAgents()
    const { version } = await two.selling.publish(draft)
    const placed = await two.buying.order({ offer: version, quantity: 2 })
    const waiting = parseServiceOrder(two.order())
    if (!waiting) throw new Error("the mailbox's order didn't parse")
    await two.selling.sell(waiting)
    // The other run's reserve lands between this run's look at the lock and its own attempt.
    commits.mockImplementation(async () => {
      onLock = { state: 'reserved' }
      return { ok: false, reason: 'chain.reverted', layer: 'lock' }
    })
    const outcome = await two.buying.buy({ resume: placed.orderId, pollEvery: 1 })
    expect(outcome.ok).toBe(true)
    expect(two.reported.map((r) => r.body)).toEqual([{ fundedIn: null }])
  })
})

describe('a supplier accepting', () => {
  it('accepts an order whose quote it signed, and no other', async () => {
    const two = await twoAgents()
    const { version } = await two.selling.publish(draft)
    await two.buying.order({ offer: version, quantity: 2 })
    const waiting = parseServiceOrder(two.order())
    if (!waiting) throw new Error("the mailbox's order didn't parse")
    await two.selling.sell(waiting)
    two.at('reserved')
    const funded = parseServiceOrder(two.order())
    if (funded?.status !== 'reserved') throw new Error("the mailbox's order didn't parse")
    // The same order with an agreement to other terms, which this agent never signed.
    const other = {
      ...funded,
      quote: {
        ...funded.quote,
        agreement: { ...funded.quote.agreement, termsHash: `0x${'77'.repeat(32)}` as const },
      },
    }
    await expect(two.selling.sell(other)).rejects.toThrow("isn't one this agent signed")
    // An order it never quoted at all is refused the same way.
    await expect(two.selling.sell({ ...funded, orderId: 'ef'.repeat(16) })).rejects.toThrow(
      "isn't one this agent signed",
    )
    expect(accepts).not.toHaveBeenCalled()
    accepts.mockResolvedValue(ACCEPTED)
    const steps: string[] = []
    await two.selling.sell(funded, (s) => steps.push(s.step))
    expect(accepts).toHaveBeenCalledTimes(1)
    expect(accepts.mock.calls[0]?.[1]).toBe(funded.quote)
    expect(steps).toEqual(['accepted'])
  })
})

describe('the terms of an order the seller has quoted', () => {
  it('stand as signed, whatever the seller publishes or withdraws after', async () => {
    const two = await twoAgents()
    const { version, id } = await two.selling.publish(draft)
    const placed = await two.buying.order({ offer: version, quantity: 2 })
    const waiting = parseServiceOrder(two.order())
    if (!waiting) throw new Error("the mailbox's order didn't parse")
    await two.selling.sell(waiting)

    // The seller doubles the price of the same item, then takes the item down altogether.
    const dearer = await two.selling.publish({ ...draft, unitPrice: dollars(100) })
    expect(await two.selling.withdraw(dearer.id)).toBe(true)
    expect(await two.selling.published()).toEqual([])

    two.at('reserved')
    const funded = parseServiceOrder(two.order())
    if (funded?.status !== 'reserved') throw new Error("the mailbox's order didn't parse")
    const { quote } = funded
    // The quote still names the version that was ordered, at the price it had then.
    expect(quote.terms.subject.offer).toBe(id)
    expect(quote.terms.consideration.amount).toBe(dollars(50))
    // Anyone holding the order can build its terms again and check them against the agreement
    // the seller signed, with nothing from the seller's folder.
    const settlement = {
      arbiter: deployment.arbiter,
      day90SupplierShareBps: deployment.day90SupplierShareBps,
    }
    const rebuilt = serviceOfferTerms(placed.offer, placed.quantity, placed.builtAt, settlement)
    expect(offerVersionId(placed.offer)).toBe(id)
    expect(termsHash(rebuilt, quote.salt)).toBe(quote.agreement.termsHash)

    // The seller accepts the agreement it signed, as it signed it. It never reads the offer again.
    accepts.mockResolvedValue(ACCEPTED)
    await two.selling.sell(funded)
    expect(accepts).toHaveBeenCalledTimes(1)
    expect(accepts.mock.calls[0]?.[1]).toEqual(quote)
    // A new order for the version it took down is another matter, and isn't quoted.
    await expect(two.selling.sell({ ...waiting, orderId: 'ef'.repeat(16) })).rejects.toThrow(
      "hasn't published",
    )
  })
})

describe('what a folder keeps', () => {
  it('holds every change made at once, and gives the last place to one order only', async () => {
    const two = await twoAgents()
    const names = ['One', 'Two', 'Three']
    await Promise.all(
      names.map((name) => two.selling.publish({ ...draft, item: { ...draft.item, name } })),
    )
    expect((await two.selling.published()).map((v) => v.item.name).sort()).toEqual(
      [...names].sort(),
    )

    const { version } = await two.selling.publish({
      ...draft,
      rules: { ...draft.rules, dailyCapacity: 1 },
    })
    await two.buying.order({ offer: version, quantity: 1 })
    const first = parseServiceOrder(two.order())
    if (!first) throw new Error("the mailbox's order didn't parse")
    const three = [
      first,
      { ...first, orderId: 'e1'.repeat(16) },
      { ...first, orderId: 'e2'.repeat(16) },
    ]
    const sold = await Promise.allSettled(three.map((o) => two.selling.sell(o)))
    expect(sold.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected', 'rejected'])
  })

  it('drops an order that lapsed unfunded once Avow refuses it, so it blocks nothing after', async () => {
    const { store } = await folder(BUYER)
    let refuse = false
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname
      if (path === '/config.json') return json(wire(deployment))
      const body = JSON.parse(new TextDecoder().decode(init?.body as Uint8Array))
      return refuse
        ? json({ error: { reason: 'message.expired', message: 'The order lapsed' } }, 409)
        : json(held(body, 'requested'))
    }) as typeof globalThis.fetch
    const buying = await sandboxServices({ store, fetch })
    const placed = await buying.order({ offer, quantity: 1 })
    expect((await buying.unfinished()).map((r) => r.orderId)).toEqual([placed.orderId])
    // While the order could still be funded, a refusal leaves it for another try.
    refuse = true
    await expect(buying.buy({ resume: placed.orderId, pollEvery: 1 })).rejects.toThrow('lapsed')
    expect(await buying.unfinished()).toHaveLength(1)
    later(20 * 60)
    await expect(buying.buy({ resume: placed.orderId, pollEvery: 1 })).rejects.toThrow('lapsed')
    expect(await buying.unfinished()).toEqual([])
  })
})

describe("an offer's bookings for the day", () => {
  it('free a place once its order can no longer be accepted, and keep an accepted one for the day', async () => {
    const two = await twoAgents()
    const { version } = await two.selling.publish({
      ...draft,
      rules: { ...draft.rules, dailyCapacity: 1 },
    })
    await two.buying.order({ offer: version, quantity: 1 })
    const first = parseServiceOrder(two.order())
    if (!first) throw new Error("the mailbox's order didn't parse")
    await two.selling.sell(first)
    const next = (id: string) => {
      const builtAt = BigInt(Math.floor(Date.now() / 1000))
      return { ...first, orderId: id.repeat(16), builtAt, expiry: builtAt + 600n }
    }
    await expect(two.selling.sell(next('a1'))).rejects.toThrow('capacity for the day')
    // Nobody funded the first order, and the supplier's time to accept it has passed.
    later(16 * 60)
    const second = next('a2')
    await two.selling.sell(second)
    // The second is funded and accepted, so its place holds past that time.
    accepts.mockResolvedValue(ACCEPTED)
    const signed = (two.order() as unknown as { quote: unknown }).quote
    const funded = parseServiceOrder({
      ...(wire(second) as object),
      status: 'reserved',
      quote: signed,
      reserve: {
        fundedIn: null,
        amount: String(dollars(25)),
        acceptBy: String(second.expiry + 300n),
      },
    })
    if (!funded) throw new Error("the funded order didn't parse")
    await two.selling.sell(funded)
    later(32 * 60)
    await expect(two.selling.sell(next('a3'))).rejects.toThrow('capacity for the day')
    later(25 * 60 * 60)
    await two.selling.sell(next('a4'))
  })

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
