import {
  dollars,
  JOB,
  type JobOfferVersion,
  jobOfferVersionId,
  OFFER_LISTING_JOB_VERSION,
  type OfferVersion,
  offerIdOf,
  offerItemOf,
  offerListingOf,
  offerVersionId,
  openingProposal,
  parseServiceQuote,
  SANDBOX_PATHS,
  SERVICE_CATEGORY,
  type ServiceOfferVersion,
  serviceOfferTerms,
  serviceQuoteProblem,
} from '@avow-finance/spec'
import type { Hex } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import { folderWithAgent, json, wire } from '../test/agent-folder.js'
import { deployment, LOCK } from '../test/sandbox-business.js'

vi.mock('../moderato.js', async (original) => ({
  ...(await original<typeof import('../moderato.js')>()),
  moderatoClient: () => ({ readContract: async () => LOCK }),
}))

const { sandboxServices, SERVICE_ORDER_SECONDS } = await import('./services.js')

const BUYER = 'sandbox-buyer'
const SELLER = 'sandbox-seller'
const HOUR = 3600n
const settlement = {
  arbiter: deployment.arbiter,
  day90SupplierShareBps: deployment.day90SupplierShareBps,
}

/** Transcription by the hour of audio, at $50 a unit, as its supplier writes it. */
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

/** Fine-tuning on one H100 at $120 a job, as its supplier writes it. */
const jobDraft = {
  template: JOB,
  work: { kind: 'Transcript', summary: 'Fine-tune a small model on the dataset the buyer sends' },
  compute: { gpu: 'H100', count: 1, region: 'demo' },
  currency: 'USD',
  price: dollars(120),
  rules: {
    startAfter: HOUR,
    turnaround: 2n * HOUR,
    gracePeriod: 600n,
    dailyCapacity: 3,
    lateCancellationBps: 2_000,
    noShowBps: 5_000,
  },
} as const
const jobOffer: JobOfferVersion = { ...jobDraft, supplier: SELLER }

const folder = (businessId: string, sells = false) =>
  folderWithAgent(businessId, { sells, suppliers: [SELLER], categories: [SERVICE_CATEGORY] })

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

/** Avow's API as far as a test needs it: the deployment, then whatever the test answers. */
function avow(answer: (path: string, body: Record<string, unknown>) => Response | null) {
  const paths: string[] = []
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    paths.push(path)
    if (path === '/config.json') return json(wire(deployment))
    // Avow serves no seller's mandate yet, so a seller sells as it did before.
    if (path === SANDBOX_PATHS.sellerMandates) {
      return json({ error: { reason: 'request.invalid', message: 'No such route' } }, 404)
    }
    const body = init?.body ? JSON.parse(new TextDecoder().decode(init.body as Uint8Array)) : {}
    return (
      answer(path, body) ??
      json({ error: { reason: 'request.invalid', message: 'No such route' } }, 404)
    )
  }) as typeof globalThis.fetch
  return { fetch, paths }
}

describe("a supplier's offers", () => {
  it('are published under its own business, kept in its folder, and replaced item by item', async () => {
    const { store } = await folder(SELLER, true)
    const { fetch } = avow(() => null)
    const services = await sandboxServices({ store, fetch })
    const first = await services.publish(draft)
    expect(first.version.supplier).toBe(SELLER)
    expect(first.id).toBe(offerVersionId(offer))
    // A new price for the same item is a new version, and the old one is no longer published.
    const dearer = await services.publish({ ...draft, unitPrice: dollars(60) })
    expect(dearer.id).not.toBe(first.id)
    await services.publish({ ...draft, item: { ...draft.item, name: 'Summary' } })
    // Another run of the agent reads the same offers from the folder.
    const again = await sandboxServices({ store, fetch })
    expect(await again.published()).toMatchObject([
      { item: { name: 'Transcript' }, unitPrice: dollars(60) },
      { item: { name: 'Summary' }, unitPrice: dollars(50) },
    ])
    expect(await again.withdraw(dearer.id)).toBe(true)
    expect(await again.withdraw(dearer.id)).toBe(false)
    expect((await again.published()).map((v) => offerItemOf(v).name)).toEqual(['Summary'])
  })

  it('take a job offer beside a service of the same name, as two items, each replaced by its own', async () => {
    const { store } = await folder(SELLER, true)
    const services = await sandboxServices({ store, fetch: avow(() => null).fetch })
    const service = await services.publish(draft)
    const job = await services.publish(jobDraft)
    expect(job.version).toEqual(jobOffer)
    expect(job.id).toBe(jobOfferVersionId(jobOffer))
    expect(await services.published()).toEqual([offer, jobOffer])
    // A new price for the job replaces only the job, under the job offer's own id.
    const dearer = await services.publish({ ...jobDraft, price: dollars(150) })
    expect((await services.published()).map((v) => offerIdOf(v))).toEqual([service.id, dearer.id])
    expect(await services.withdraw(dearer.id)).toBe(true)
    expect(await services.published()).toEqual([offer])
  })

  it("don't publish a job offer its own rules refuse", async () => {
    const { store } = await folder(SELLER, true)
    const services = await sandboxServices({ store, fetch: avow(() => null).fetch })
    const early = { ...jobDraft, rules: { ...jobDraft.rules, startAfter: 60n } }
    await expect(services.publish(early)).rejects.toThrow(RangeError)
    expect(await services.published()).toEqual([])
  })

  it("aren't published when the template's rules refuse them", async () => {
    const { store } = await folder(SELLER, true)
    const services = await sandboxServices({ store, fetch: avow(() => null).fetch })
    const nothingToCharge = { ...draft.rules, lateCancellationBps: 0, noShowBps: 0 }
    await expect(services.publish({ ...draft, rules: nothingToCharge })).rejects.toThrow(RangeError)
    expect(await services.published()).toEqual([])
  })
})

describe("a supplier's listings with Avow", () => {
  const listingOf = (version: OfferVersion, replaced: Hex | null = null) =>
    wire(
      offerListingOf(
        {
          id: offerIdOf(version),
          listedAt: 1_800_000_000n,
          sellerMandate: `0x${'ab'.repeat(32)}`,
          replaced,
        },
        version,
      ),
    )

  it('sends a version published here, signed with the signing key, and answers the listing Avow holds', async () => {
    const { store } = await folder(SELLER, true)
    const sent: Record<string, unknown>[] = []
    const { fetch } = avow((path, body) => {
      if (path !== SANDBOX_PATHS.offerListings) return null
      sent.push(body)
      return json(listingOf(offer))
    })
    const services = await sandboxServices({ store, fetch })
    const { id } = await services.publish(draft)
    const outcome = await services.listWithAvow(id)
    if (!outcome.ok) throw new Error('the offer was listed')
    expect(outcome.listing.id).toBe(id)
    expect(outcome.listing.version).toEqual(offer)
    expect(outcome.standing.inForce).toBe(false)
    expect(sent).toEqual([{ version: wire(offer) }])
  })

  it("sends a job offer published here, and answers Avow's listing of it under the job's id", async () => {
    const { store } = await folder(SELLER, true)
    const sent: Record<string, unknown>[] = []
    const { fetch } = avow((path, body) => {
      if (path !== SANDBOX_PATHS.offerListings) return null
      sent.push(body)
      return json(listingOf(jobOffer))
    })
    const services = await sandboxServices({ store, fetch })
    await services.publish(draft)
    const { id } = await services.publish(jobDraft)
    const outcome = await services.listWithAvow(id)
    if (!outcome.ok) throw new Error('the job offer was listed')
    expect(outcome.listing).toMatchObject({ id: jobOfferVersionId(jobOffer), version: jobOffer })
    expect(sent).toEqual([{ schemaVersion: OFFER_LISTING_JOB_VERSION, version: wire(jobOffer) }])
  })

  it('lists nothing it never published here, and sends nothing for it', async () => {
    const { store } = await folder(SELLER, true)
    const { fetch, paths } = avow(() => null)
    const services = await sandboxServices({ store, fetch })
    await expect(services.listWithAvow(offerVersionId(offer))).rejects.toThrow(/hasn't published/)
    expect(paths).not.toContain(SANDBOX_PATHS.offerListings)
  })

  it('says plainly when the sandbox lists no offers, whichever way it says so', async () => {
    for (const refusal of [
      json({ error: { reason: 'offer.listing_unavailable', message: 'No listings' } }, 409),
      null,
    ]) {
      const { store } = await folder(SELLER, true)
      const { fetch } = avow((path) => (path === SANDBOX_PATHS.offerListings ? refusal : null))
      const services = await sandboxServices({ store, fetch })
      const { id } = await services.publish(draft)
      const { OFFER_LISTINGS_UNTAKEN } = await import('./services.js')
      expect(await services.listWithAvow(id)).toEqual({
        ok: false,
        reason: 'offer.listing_unavailable',
        notice: OFFER_LISTINGS_UNTAKEN,
      })
      expect(await services.listedWithAvow()).toEqual([])
    }
  })

  it("passes on Avow's refusal of a replaced version by its reason", async () => {
    const { store } = await folder(SELLER, true)
    const { fetch } = avow((path) =>
      path === SANDBOX_PATHS.offerListings
        ? json({ error: { reason: 'offer.superseded', message: 'Replaced' } }, 409)
        : null,
    )
    const services = await sandboxServices({ store, fetch })
    const { id } = await services.publish(draft)
    await expect(services.listWithAvow(id)).rejects.toMatchObject({ reason: 'offer.superseded' })
  })

  it('refuses an answer that lists another version than the one sent', async () => {
    const { store } = await folder(SELLER, true)
    const other = { ...offer, unitPrice: dollars(60) }
    const { fetch } = avow((path) =>
      path === SANDBOX_PATHS.offerListings ? json(listingOf(other)) : null,
    )
    const services = await sandboxServices({ store, fetch })
    const { id } = await services.publish(draft)
    await expect(services.listWithAvow(id)).rejects.toThrow(/another version/)
  })

  it('withdraws a listing by its id and reads what Avow lists for the business', async () => {
    const { store } = await folder(SELLER, true)
    const id = offerVersionId(offer)
    const { fetch } = avow((path, body) => {
      if (path === SANDBOX_PATHS.offerWithdrawals) {
        return json(wire({ id: body.id, withdrawnAt: 1_800_000_100n }))
      }
      if (path === SANDBOX_PATHS.offerListingsMine) return json({ listed: [listingOf(offer)] })
      return null
    })
    const services = await sandboxServices({ store, fetch })
    expect(await services.withdrawFromAvow(id)).toEqual({ id, withdrawnAt: 1_800_000_100n })
    expect((await services.listedWithAvow()).map((l) => l.id)).toEqual([id])
  })

  it("refuses a read of listings that holds another business's offer", async () => {
    const { store } = await folder(SELLER, true)
    const theirs = { ...offer, supplier: 'sandbox-other' }
    const { fetch } = avow((path) =>
      path === SANDBOX_PATHS.offerListingsMine ? json({ listed: [listingOf(theirs)] }) : null,
    )
    const services = await sandboxServices({ store, fetch })
    await expect(services.listedWithAvow()).rejects.toThrow(/another business/)
  })

  it('reads a thread order and replays it before trusting it', async () => {
    const { store } = await folder(BUYER)
    const builtAt = BigInt(Math.floor(Date.now() / 1000))
    const proposal = openingProposal({
      thread: `0x${'aa'.repeat(32)}`,
      commitmentId: `0x${'56'.repeat(32)}`,
      base: offer,
      quantity: 2,
      builtAt,
      expiry: builtAt + 120n,
    })
    const thread = {
      base: offer,
      buyer: { businessId: BUYER, mandateHash: `0x${'cd'.repeat(32)}` },
      settlement: {
        arbiter: deployment.arbiter,
        day90SupplierShareBps: deployment.day90SupplierShareBps,
      },
      moves: [{ move: proposal, signature: '0x01', quote: null, current: null }],
    }
    const answer = (moves: unknown[]) => ({
      orderId: 'ab'.repeat(16),
      thread: { ...thread, moves },
      buyer: {
        businessId: BUYER,
        account: LOCK.toLowerCase(),
        lock: LOCK.toLowerCase(),
        chainId: deployment.chainId,
        mandateHash: `0x${'cd'.repeat(32)}`,
      },
      requestedAt: builtAt,
      status: 'open',
    })
    let served = answer(thread.moves)
    const { fetch } = avow((path) =>
      path === SANDBOX_PATHS.threadOrder('ab'.repeat(16)) ? json(wire(served)) : null,
    )
    const services = await sandboxServices({ store, fetch })
    const read = await services.readThread('ab'.repeat(16))
    expect(read).toMatchObject({ problem: null, order: { status: 'open' } })
    // A copy whose first move isn't the buyer's proposal is refused before anything trusts it.
    served = answer([
      { move: { ...proposal, side: 'supplier' }, signature: '0x01', quote: null, current: null },
    ])
    expect((await services.readThread('ab'.repeat(16))).problem).not.toBeNull()
  })

  it('needs a signing key, which an agent connected only to buy has none of', async () => {
    const { store } = await folder(BUYER)
    const services = await sandboxServices({ store, fetch: avow(() => null).fetch })
    await expect(services.listedWithAvow()).rejects.toThrow()
    await expect(services.withdrawFromAvow(offerVersionId(offer))).rejects.toThrow()
  })
})

describe('buying a service', () => {
  it('sends the whole offer, and lets an order nobody quotes lapse with nothing reserved', async () => {
    const { store } = await folder(BUYER)
    let sent: Record<string, unknown> = {}
    const { fetch, paths } = avow((path, body) => {
      if (path === SANDBOX_PATHS.serviceOrders) {
        sent = body
        return json(answered(body, 'requested'))
      }
      if (path === SANDBOX_PATHS.serviceOrder(String(sent.orderId))) {
        return json(answered(sent, 'expired', { quote: null }))
      }
      return null
    })
    const services = await sandboxServices({ store, fetch })
    const steps: string[] = []
    const outcome = await services.buy({
      offer,
      quantity: 2,
      pollEvery: 1,
      onStep: (s) => steps.push(s.step),
    })
    expect(outcome).toMatchObject({ ok: false, reason: 'order.expired' })
    expect(steps).toEqual(['ordered'])
    expect(sent).toMatchObject({ offer: wire(offer), quantity: 2 })
    // The order leaves the supplier its margin to accept, however long it was asked to wait.
    expect(BigInt(String(sent.expiry)) - BigInt(String(sent.builtAt))).toBe(SERVICE_ORDER_SECONDS)
    // Seen through, the order no longer waits to be resumed, and nothing went near a reserve.
    expect(await services.unfinished()).toEqual([])
    expect(paths.some((p) => p.includes('/reserved'))).toBe(false)
  })

  it("says so when the sandbox doesn't carry service orders, and keeps nothing to pick up", async () => {
    const { store } = await folder(BUYER)
    const services = await sandboxServices({ store, fetch: avow(() => null).fetch })
    await expect(services.buy({ offer, quantity: 2 })).rejects.toThrow(
      "doesn't carry service orders yet",
    )
    expect(await services.unfinished()).toEqual([])
  })

  it('refuses a quantity the offer never takes before anything is sent', async () => {
    const { store } = await folder(BUYER)
    const { fetch, paths } = avow(() => null)
    const services = await sandboxServices({ store, fetch })
    await expect(services.buy({ offer, quantity: 11 })).rejects.toThrow(RangeError)
    expect(paths).toEqual(['/config.json'])
    expect(await services.unfinished()).toEqual([])
  })

  it('refuses a quote whose terms moved, before it asks Avow for anything', async () => {
    const { store } = await folder(BUYER)
    const seller = await folder(SELLER, true)
    // An honest quote for a dearer version of the offer than the one ordered.
    const selling = await sandboxServices({ store: seller.store, fetch: avow(() => null).fetch })
    const dearer = (await selling.publish({ ...draft, unitPrice: dollars(60) })).version
    let sent: Record<string, unknown> = {}
    let quote: unknown = null
    const { fetch, paths } = avow((path, body) => {
      if (path === SANDBOX_PATHS.serviceOrders) {
        sent = body
        return json(answered(body, 'requested'))
      }
      if (path === SANDBOX_PATHS.serviceOrder(String(sent.orderId))) {
        return json(answered(sent, 'quoted', { quote }))
      }
      return null
    })
    const services = await sandboxServices({ store, fetch })
    const placed = await services.order({ offer, quantity: 2 })
    const sellerSide = avow((path, body) => {
      quote = body
      return path === SANDBOX_PATHS.serviceQuote(placed.orderId)
        ? json(answered({ ...sent, offer: wire(dearer) }, 'quoted', { quote: body }))
        : null
    })
    const asSeller = await sandboxServices({ store: seller.store, fetch: sellerSide.fetch })
    await asSeller.sell({ ...placed, offer: dearer })
    const outcome = await services.buy({ resume: placed.orderId, pollEvery: 1 })
    expect(outcome).toMatchObject({ ok: false, reason: 'order.terms_changed' })
    expect(paths.some((p) => p.includes('/reserved') || p.includes('reserve-approvals'))).toBe(
      false,
    )
  })
})

describe('selling a service', () => {
  it('quotes an order for an offer it published, with the terms the order builds', async () => {
    const { store } = await folder(SELLER, true)
    const posted: { path: string; body: Record<string, unknown> }[] = []
    const { fetch } = avow((path, body) => {
      posted.push({ path, body })
      return json(answered({}, 'quoted'))
    })
    const services = await sandboxServices({ store, fetch })
    const { version } = await services.publish(draft)
    const builtAt = BigInt(Math.floor(Date.now() / 1000))
    const order = {
      orderId: 'ab'.repeat(16),
      commitmentId: `0x${'12'.repeat(32)}`,
      offer: version,
      quantity: 2,
      builtAt,
      expiry: builtAt + 600n,
      buyer: {
        businessId: BUYER,
        account: LOCK,
        lock: LOCK,
        chainId: deployment.chainId,
        mandateHash: `0x${'cd'.repeat(32)}`,
      },
      requestedAt: builtAt,
      status: 'requested',
    } as const
    // The mailbox's answer to the quote isn't a whole order here, which the send refuses to read.
    await services.sell(order).catch(() => {})
    const sent = posted.find((p) => p.path === SANDBOX_PATHS.serviceQuote(order.orderId))
    const quote = parseServiceQuote(sent?.body)
    if (!quote) throw new Error('no quote was sent')
    expect(quote.terms).toEqual(serviceOfferTerms(version, 2, builtAt, settlement))
    expect(serviceQuoteProblem(order, quote, settlement)).toBeNull()
    expect(quote.agreement).toMatchObject({
      category: SERVICE_CATEGORY,
      supplierBusinessId: SELLER,
      buyerBusinessId: BUYER,
    })
  })

  it('quotes nothing for an offer it never published, and names the version it publishes', async () => {
    const { store } = await folder(SELLER, true)
    const declines: Record<string, unknown>[] = []
    let order: Record<string, unknown> = {}
    const { fetch, paths } = avow((path, body) => {
      if (!path.endsWith('/decline')) return null
      declines.push(body)
      const declinedAt = String(Math.floor(Date.now() / 1000))
      return json({ ...order, status: 'declined', quote: null, decline: { ...body, declinedAt } })
    })
    const services = await sandboxServices({ store, fetch })
    const { version } = await services.publish(draft)
    const builtAt = BigInt(Math.floor(Date.now() / 1000))
    const forged = {
      orderId: 'ab'.repeat(16),
      commitmentId: `0x${'12'.repeat(32)}`,
      offer: { ...offer, unitPrice: 1n },
      quantity: 2,
      builtAt,
      expiry: builtAt + 600n,
      buyer: {
        businessId: BUYER,
        account: LOCK,
        lock: LOCK,
        chainId: deployment.chainId,
        mandateHash: `0x${'cd'.repeat(32)}`,
      },
      requestedAt: builtAt,
      status: 'requested',
    } as const
    order = wire(forged) as Record<string, unknown>
    const steps: string[] = []
    await services.sell(forged, (step) => steps.push(step.step))
    expect(steps).toEqual(['declined'])
    expect(paths.some((p) => p.endsWith('/quote'))).toBe(false)
    // The buyer's copy names the item this folder publishes, so the decline names the current
    // version, whole, for the buyer to check as a new offer.
    expect(declines).toEqual([
      { reason: 'offer.superseded', retryAt: null, available: null, current: wire(version) },
    ])
    // An item this folder doesn't publish at all is withdrawn.
    const other = {
      ...forged,
      orderId: 'cd'.repeat(16),
      offer: { ...offer, item: { ...offer.item, name: 'Poem' } },
    }
    order = wire(other) as Record<string, unknown>
    await services.sell(other)
    expect(declines.at(-1)).toMatchObject({ reason: 'offer.withdrawn', current: null })
  })

  it('tells the buyer why its order was declined, and lets it withdraw one', async () => {
    const { store } = await folder(BUYER)
    let status: 'requested' | 'declined' | 'withdrawn' = 'requested'
    const decline = { reason: 'capacity.exhausted', retryAt: null, available: '1', declinedAt: '1' }
    const { fetch, paths } = avow((path, body) => {
      if (path.endsWith('/withdraw')) status = 'withdrawn'
      const request = path === SANDBOX_PATHS.serviceOrders ? body : held
      held = request
      const order = {
        ...request,
        buyer: buyerOf,
        requestedAt: String(Math.floor(Date.now() / 1000)),
      }
      if (status === 'declined') {
        return json({
          ...order,
          status,
          quote: null,
          decline: { ...decline, available: 1, current: null },
        })
      }
      if (status === 'withdrawn') return json({ ...order, status, quote: null, withdrawnAt: '1' })
      return json({ ...order, status })
    })
    let held: Record<string, unknown> = {}
    const buyerOf = {
      businessId: BUYER,
      account: LOCK.toLowerCase(),
      lock: LOCK.toLowerCase(),
      chainId: deployment.chainId,
      mandateHash: `0x${'cd'.repeat(32)}`,
    }
    const services = await sandboxServices({ store, fetch })
    const placed = await services.order({ offer, quantity: 1 })
    status = 'declined'
    const outcome = await services.buy({ resume: placed.orderId, pollEvery: 1 })
    expect(outcome).toMatchObject({ ok: false, reason: 'capacity.exhausted' })
    expect(await services.unfinished()).toEqual([])
    // A withdrawal is the buyer's own, and stops it waiting on the order.
    status = 'requested'
    const again = await services.order({ offer, quantity: 1 })
    expect((await services.withdrawOrder(again.orderId)).status).toBe('withdrawn')
    expect(paths).toContain(SANDBOX_PATHS.serviceWithdraw(again.orderId))
    expect(await services.unfinished()).toEqual([])
  })

  it('needs a signing key, which an agent connected only to buy has none of', async () => {
    const { store } = await folder(BUYER)
    const services = await sandboxServices({ store, fetch: avow(() => null).fetch })
    await expect(services.inbox()).rejects.toThrow('--sell')
  })
})
