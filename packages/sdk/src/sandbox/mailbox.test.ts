import {
  dollars,
  GPU_RESERVATION,
  JOB,
  JOB_CATEGORY,
  type JobOfferVersion,
  jobOfferTerms,
  jobTermsMatchOffer,
  SANDBOX_PATHS,
  testnetDemoJobTerms,
  testnetDemoTerms,
} from '@avow-finance/spec'
import type { Hex } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import { folderWithAgent, json, wire } from '../test/agent-folder.js'
import { deployment, LOCK, supplier } from '../test/sandbox-business.js'
import { write } from './store.js'

const bookings = vi.fn()
const quotes = vi.fn()

vi.mock('../moderato.js', async (original) => ({
  ...(await original<typeof import('../moderato.js')>()),
  moderatoClient: () => ({ readContract: async () => LOCK }),
}))
vi.mock('./agent.js', async (original) => ({
  ...(await original<typeof import('./agent.js')>()),
  sandboxAgent: async () => ({ bookTerms: bookings }),
}))
vi.mock('../job/quote.js', async (original) => ({
  ...(await original<typeof import('../job/quote.js')>()),
  quoteJob: quotes,
}))

const { sandboxMailbox } = await import('./mailbox.js')
const { readOrderArgs } = await import('../node/mailbox.js')

const BUYER = 'sandbox-buyer'
const SELLER = 'sandbox-seller'
const agentFolder = (businessId: string, sells = false) =>
  folderWithAgent(businessId, {
    sells,
    suppliers: [SELLER, supplier.id],
    categories: [JOB_CATEGORY, 'compute'],
  })

/** An order as the mailbox answers it, for the request an agent sent. */
function answered(request: Record<string, unknown>, status: string, extra = {}) {
  return {
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
  }
}

const anOrder = (expiry: bigint) => ({
  orderId: 'ab'.repeat(16),
  commitmentId: `0x${'12'.repeat(32)}` as Hex,
  supplierBusinessId: SELLER,
  terms: testnetDemoJobTerms(expiry + 600n, deployment.arbiter),
  requirement: { template: GPU_RESERVATION, condition: 'accepted', disclosed: 'subject' },
  expiry,
})

/** A seller's offer of fine-tuning, the demo job's kind of work, at $120 a job. */
const jobOffer: JobOfferVersion = {
  template: JOB,
  supplier: SELLER,
  work: { kind: 'fine-tuning', summary: 'Fine-tune a small model on the dataset the buyer sends' },
  compute: { gpu: 'H100', count: 1, region: 'demo' },
  currency: 'USD',
  price: dollars(120),
  rules: {
    startAfter: 3600n,
    turnaround: 7200n,
    gracePeriod: 600n,
    dailyCapacity: 3,
    lateCancellationBps: 2_000,
    noShowBps: 5_000,
  },
}
const settlement = {
  arbiter: deployment.arbiter,
  day90SupplierShareBps: deployment.day90SupplierShareBps,
}

describe('the sandbox mailbox', () => {
  it('lets an order nobody quotes lapse, and reserves nothing for it', async () => {
    const { store } = await agentFolder(BUYER)
    const paths: string[] = []
    let sent: Record<string, unknown> = {}
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname
      paths.push(path)
      if (path === '/config.json') return json(wire(deployment))
      const body = init?.body ? JSON.parse(new TextDecoder().decode(init.body as Uint8Array)) : {}
      if (path === SANDBOX_PATHS.mailboxOrders) {
        sent = body
        return json(answered(body, 'requested'))
      }
      if (path === SANDBOX_PATHS.mailboxOrder(String(sent.orderId))) {
        return json(answered(sent, 'expired', { quote: null }))
      }
      return json({ error: { reason: 'request.invalid' } }, 404)
    }) as typeof globalThis.fetch

    const mailbox = await sandboxMailbox({ store, fetch })
    const steps: string[] = []
    const outcome = await mailbox.buy({
      supplier: SELLER,
      expiresIn: 60n,
      pollEvery: 1,
      onStep: (s) => steps.push(s.step),
    })
    expect(outcome).toMatchObject({ ok: false, reason: 'order.expired' })
    expect(steps).toEqual(['ordered'])
    // Seen through, the order no longer waits to be resumed.
    expect(await mailbox.unfinished()).toEqual([])
    // The order named the seller and the job, and lapses a minute after it was sent.
    expect(sent).toMatchObject({ supplierBusinessId: SELLER })
    expect(Number(sent.expiry) - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(60)
    // Nothing went to Avow's approvals, the relay or the reserve route.
    expect(paths.filter((p) => p !== '/config.json')).toEqual([
      SANDBOX_PATHS.mailboxOrders,
      SANDBOX_PATHS.mailboxOrder(String(sent.orderId)),
    ])
  })

  it('picks up an order it funded before it stopped, and funds nothing again', async () => {
    const { store } = await agentFolder(BUYER)
    const order = anOrder(1_800_000_600n)
    await write(store, 'mailbox', { buying: [order] })
    const reserve = { fundedIn: null, amount: '200000000', acceptBy: '9999999999' }
    const paths: string[] = []
    let reads = 0
    const fetch = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname
      if (path === '/config.json') return json(wire(deployment))
      paths.push(path)
      const quote = {
        terms: wire(order.terms),
        salt: `0x${'01'.repeat(32)}`,
        agreement: {
          commitmentId: order.commitmentId,
          termsHash: `0x${'02'.repeat(32)}`,
          category: JOB_CATEGORY,
          buyerBusinessId: BUYER,
          supplierBusinessId: SELLER,
          mandateHash: `0x${'cd'.repeat(32)}`,
          nonce: '1',
          expiry: '1800000000',
        },
        supplierSignature: `0x${'11'.repeat(65)}`,
        disclosed: [],
      }
      if (path === SANDBOX_PATHS.mailboxOrders) {
        return json(answered(wire(order), 'reserved', { quote, reserve }))
      }
      reads++
      return json(answered(wire(order), 'accepted', { quote, reserve, acceptedIn: null }))
    }) as typeof globalThis.fetch

    const mailbox = await sandboxMailbox({ store, fetch })
    expect((await mailbox.unfinished()).map((r) => r.orderId)).toEqual([order.orderId])
    const steps: string[] = []
    const outcome = await mailbox.buy({
      supplier: SELLER,
      resume: order.orderId,
      pollEvery: 1,
      onStep: (s) => steps.push(s.step),
    })
    expect(outcome).toMatchObject({ ok: true, order: { status: 'accepted' } })
    expect(steps).toEqual(['ordered', 'accepted'])
    // It sent the same order again and read where it stood, and asked for no approval or funding.
    expect(paths).toEqual([SANDBOX_PATHS.mailboxOrders, SANDBOX_PATHS.mailboxOrder(order.orderId)])
    expect(reads).toBe(1)
    expect(await mailbox.unfinished()).toEqual([])
  })

  it('quotes with the booking it kept after a restart, and books nothing new', async () => {
    bookings.mockReset()
    quotes.mockReset().mockResolvedValue({ quoted: true })
    const { store } = await agentFolder(SELLER, true)
    const order = anOrder(1_800_000_600n)
    const compute = {
      reference: {
        kind: 'commitment',
        chainId: deployment.chainId,
        lock: LOCK.toLowerCase(),
        commitmentId: `0x${'34'.repeat(32)}`,
        side: 'buyer',
        termsHash: `0x${'78'.repeat(32)}`,
      },
      terms: testnetDemoTerms(1_800_000_000n, deployment.arbiter),
      salt: `0x${'56'.repeat(32)}`,
    }
    await write(store, 'mailbox', { sales: { [order.orderId]: { compute } } })
    const posted: { path: string; body: unknown }[] = []
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname
      if (path === '/config.json') return json(wire(deployment))
      const body = init?.body ? JSON.parse(new TextDecoder().decode(init.body as Uint8Array)) : {}
      posted.push({ path, body })
      // A sandbox that serves no seller's mandate, so none is in force.
      if (path === SANDBOX_PATHS.sellerMandates) {
        return json({ error: { reason: 'request.invalid', message: 'No such route' } }, 404)
      }
      const held = answered(wire(order), 'requested')
      return json(path === SANDBOX_PATHS.mailboxInbox ? { orders: [held] } : held)
    }) as typeof globalThis.fetch

    const mailbox = await sandboxMailbox({ store, fetch })
    const [held] = (await mailbox.inbox()) ?? []
    if (!held) throw new Error('The inbox read no order')
    await mailbox.sell(held)
    expect(bookings).not.toHaveBeenCalled()
    expect(quotes).toHaveBeenCalledOnce()
    // The booking comes back as it was booked, its terms as numbers again.
    expect(quotes.mock.calls[0]?.[0]).toMatchObject({ compute, sellerMandate: null })
    expect(posted.map((p) => p.path)).toEqual([
      SANDBOX_PATHS.mailboxInbox,
      SANDBOX_PATHS.sellerMandates,
      SANDBOX_PATHS.mailboxQuote(order.orderId),
    ])
  })
})

/** A compute booking the seller's folder kept for a job, so selling it books nothing new. */
const keptCompute = (now: bigint) => ({
  reference: {
    kind: 'commitment',
    chainId: deployment.chainId,
    lock: LOCK.toLowerCase(),
    commitmentId: `0x${'34'.repeat(32)}`,
    side: 'buyer',
    termsHash: `0x${'78'.repeat(32)}`,
  },
  terms: testnetDemoTerms(now, deployment.arbiter),
  salt: `0x${'56'.repeat(32)}`,
})

describe('a job ordered from a job offer', () => {
  it("builds the order's terms from the offer, and lapses it before work starts", async () => {
    const { store } = await agentFolder(BUYER)
    let sent: Record<string, unknown> = {}
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname
      if (path === '/config.json') return json(wire(deployment))
      const body = init?.body ? JSON.parse(new TextDecoder().decode(init.body as Uint8Array)) : {}
      if (path === SANDBOX_PATHS.mailboxOrders) {
        sent = body
        return json(answered(body, 'requested'))
      }
      return json({ error: { reason: 'request.invalid' } }, 404)
    }) as typeof globalThis.fetch

    const mailbox = await sandboxMailbox({ store, fetch })
    const order = await mailbox.order({ supplier: SELLER, offer: jobOffer, expiresIn: 86_400n })
    expect(jobTermsMatchOffer(order.terms, jobOffer)).toBe(true)
    expect(sent.terms).toEqual(wire(order.terms))
    // Asked to wait a day, the order lapses a minute before work starts instead.
    expect(order.expiry).toBe(order.terms.subject.startsAt - 60n)
    await expect(mailbox.order({ supplier: 'sandbox-other', offer: jobOffer })).rejects.toThrow(
      /another supplier/,
    )
  })

  it("quotes nothing, and books nothing, for an order that isn't the job its current offer builds", async () => {
    bookings.mockReset()
    quotes.mockReset().mockResolvedValue({ quoted: true })
    const { store } = await agentFolder(SELLER, true)
    await write(store, 'services', { published: [wire(jobOffer)] })
    // The demo job is fine-tuning too, at another price and on another clock.
    const order = anOrder(1_800_000_600n)
    const posted: string[] = []
    const fetch = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname
      if (path === '/config.json') return json(wire(deployment))
      posted.push(path)
      return json({ orders: [answered(wire(order), 'requested')] })
    }) as typeof globalThis.fetch

    const mailbox = await sandboxMailbox({ store, fetch })
    const [held] = await mailbox.inbox()
    if (!held) throw new Error('The inbox read no order')
    await expect(mailbox.sell(held)).rejects.toThrow(/current offer of fine-tuning/)
    expect(bookings).not.toHaveBeenCalled()
    expect(quotes).not.toHaveBeenCalled()
    expect(posted).toEqual([SANDBOX_PATHS.mailboxInbox])
  })

  it('quotes an order that is exactly the job its current offer builds', async () => {
    bookings.mockReset()
    quotes.mockReset().mockResolvedValue({ quoted: true })
    const { store } = await agentFolder(SELLER, true)
    await write(store, 'services', { published: [wire(jobOffer)] })
    const now = BigInt(Math.floor(Date.now() / 1000))
    const order = { ...anOrder(now + 600n), terms: jobOfferTerms(jobOffer, now, settlement) }
    await write(store, 'mailbox', { sales: { [order.orderId]: { compute: keptCompute(now) } } })
    const fetch = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname
      if (path === '/config.json') return json(wire(deployment))
      if (path === SANDBOX_PATHS.sellerMandates) {
        return json({ error: { reason: 'request.invalid', message: 'No such route' } }, 404)
      }
      const held = answered(wire(order), 'requested')
      return json(path === SANDBOX_PATHS.mailboxInbox ? { orders: [held] } : held)
    }) as typeof globalThis.fetch

    const mailbox = await sandboxMailbox({ store, fetch })
    const [held] = await mailbox.inbox()
    if (!held) throw new Error('The inbox read no order')
    await mailbox.sell(held)
    expect(quotes).toHaveBeenCalledOnce()
  })
})

describe('a job sold from a job offer, held to the clock and the day', () => {
  const now = () => BigInt(Math.floor(Date.now() / 1000))

  /** A seller folder with the job offer published, selling the order given from its inbox. */
  async function sellerSelling(
    order: ReturnType<typeof anOrder>,
    o: { jobSales?: unknown; computeKept?: boolean } = {},
  ) {
    bookings.mockReset()
    quotes.mockReset().mockResolvedValue({ quoted: true })
    const { store } = await agentFolder(SELLER, true)
    await write(store, 'services', { published: [wire(jobOffer)] })
    if (o.jobSales) await write(store, 'job-sales', { sales: o.jobSales })
    if (o.computeKept) {
      await write(store, 'mailbox', { sales: { [order.orderId]: { compute: keptCompute(now()) } } })
    }
    const fetch = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname
      if (path === '/config.json') return json(wire(deployment))
      if (path === SANDBOX_PATHS.sellerMandates) {
        return json({ error: { reason: 'request.invalid', message: 'No such route' } }, 404)
      }
      const held = answered(wire(order), 'requested')
      return json(path === SANDBOX_PATHS.mailboxInbox ? { orders: [held] } : held)
    }) as typeof globalThis.fetch
    const mailbox = await sandboxMailbox({ store, fetch })
    const [held] = await mailbox.inbox()
    if (!held) throw new Error('The inbox read no order')
    return { mailbox, held }
  }

  it('quotes nothing, and books nothing, for an order built from a moment ahead of its clock', async () => {
    const ahead = now() + 3_600n
    const order = { ...anOrder(ahead + 600n), terms: jobOfferTerms(jobOffer, ahead, settlement) }
    const { mailbox, held } = await sellerSelling(order)
    await expect(mailbox.sell(held)).rejects.toThrow(/dated ahead/)
    expect(bookings).not.toHaveBeenCalled()
    expect(quotes).not.toHaveBeenCalled()
  })

  it("quotes nothing, and books nothing, once the offer's capacity for the day is taken", async () => {
    const t = now()
    const order = { ...anOrder(t + 600n), terms: jobOfferTerms(jobOffer, t, settlement) }
    const place = (accepted: boolean, at: bigint, until: bigint) => ({
      item: jobOffer.work.kind,
      at: String(at),
      until: String(until),
      accepted,
      units: 1,
      price: String(jobOffer.price),
      deliverBy: String(t + 86_400n),
    })
    // One quoted that can still be accepted and two accepted today fill a capacity of three.
    const full = {
      a: place(false, t - 60n, t + 600n),
      b: place(true, t - 3_600n, t - 3_000n),
      c: place(true, t - 7_200n, t - 6_000n),
    }
    const { mailbox, held } = await sellerSelling(order, { jobSales: full })
    await expect(mailbox.sell(held)).rejects.toThrow(/capacity for the day is taken/)
    expect(bookings).not.toHaveBeenCalled()
    expect(quotes).not.toHaveBeenCalled()
    // With the compute already booked, the quote counts the places again and still refuses.
    const booked = await sellerSelling(order, { jobSales: full, computeKept: true })
    await expect(booked.mailbox.sell(booked.held)).rejects.toThrow(/capacity for the day is taken/)
    expect(quotes).not.toHaveBeenCalled()
    // A quote that lapsed unaccepted, and a job of another kind, take no place.
    const room = {
      ...full,
      a: place(false, t - 3_600n, t - 60n),
      d: { ...place(false, t - 60n, t + 600n), item: 'inference' },
    }
    const again = await sellerSelling(order, { jobSales: room, computeKept: true })
    await again.mailbox.sell(again.held)
    expect(quotes).toHaveBeenCalledOnce()
  })
})

describe('avow-sandbox order', () => {
  it('takes the supplier and how long the order waits', () => {
    expect(readOrderArgs(['--supplier', SELLER])).toEqual({ supplier: SELLER, expiresIn: 600n })
    expect(readOrderArgs(['--supplier', SELLER, '--expires-in', '90'])).toEqual({
      supplier: SELLER,
      expiresIn: 90n,
    })
    expect(readOrderArgs([])).toEqual({ error: expect.stringContaining('--supplier') })
    expect(readOrderArgs(['--supplier', SELLER, '--expires-in', 'soon'])).toEqual({
      error: '--expires-in takes whole seconds',
    })
  })
})
