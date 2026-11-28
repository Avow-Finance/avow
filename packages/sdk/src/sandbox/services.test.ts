import {
  dollars,
  offerVersionId,
  parseServiceQuote,
  SANDBOX_PATHS,
  SERVICE_CATEGORY,
  type ServiceOfferVersion,
  serviceOfferTerms,
  serviceQuoteProblem,
} from '@avow-finance/spec'
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
    expect((await again.published()).map((v) => [v.item.name, v.unitPrice])).toEqual([
      ['Transcript', dollars(60)],
      ['Summary', dollars(50)],
    ])
    expect(await again.withdraw(dearer.id)).toBe(true)
    expect(await again.withdraw(dearer.id)).toBe(false)
    expect((await again.published()).map((v) => v.item.name)).toEqual(['Summary'])
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
  const listingOf = (version: ServiceOfferVersion, replaced: string | null = null) =>
    wire({
      id: offerVersionId(version),
      version,
      listedAt: 1_800_000_000n,
      sellerMandate: `0x${'ab'.repeat(32)}`,
      replaced,
    })

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

  it('quotes nothing for an offer it never published, which a buyer could have written', async () => {
    const { store } = await folder(SELLER, true)
    const { fetch, paths } = avow(() => json({}))
    const services = await sandboxServices({ store, fetch })
    await services.publish(draft)
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
    await expect(services.sell(forged)).rejects.toThrow("hasn't published")
    expect(paths.some((p) => p.endsWith('/quote'))).toBe(false)
  })

  it('needs a signing key, which an agent connected only to buy has none of', async () => {
    const { store } = await folder(BUYER)
    const services = await sandboxServices({ store, fetch: avow(() => null).fetch })
    await expect(services.inbox()).rejects.toThrow('--sell')
  })
})
