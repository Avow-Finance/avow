import {
  type CommitmentReference,
  offerVersionId,
  parseServiceInbox,
  parseServiceOfferVersion,
  parseServiceOrder,
  parseServiceOrderRequest,
  publishedOffer,
  type ReasonCode,
  SANDBOX_PATHS,
  SERVICE_ACCEPT_WITHIN,
  SERVICE_ORDER_ACCEPT_MARGIN,
  type ServiceOfferVersion,
  type ServiceOrder,
  type ServiceOrderRequest,
  serviceOfferProblem,
  serviceOrderProblem,
  serviceQuoteProblem,
  toWire,
} from '@avow-finance/spec'
import { type Hex, toHex } from 'viem'
import { AvowApiError, signingRequestKey } from '../http.js'
import { quoteService } from '../service/quote.js'
import { pause } from './connect.js'
import {
  awaitAccepted,
  listenFor,
  type MailboxOptions,
  mailboxContext,
  systemClock,
} from './mailbox-context.js'
import { addCommitment, isRecord, loadCommitments, readJson, write } from './store.js'

/**
 * Services through the sandbox mailbox, from an agent's side. A supplier's agent publishes offers
 * it keeps in its own folder, reads its inbox, quotes an order for an offer it published, and
 * accepts once the buyer has funded. A buyer's agent orders units of an offer it was given, checks
 * the quote that comes back against its own order, and funds it under its mandate. Avow keeps
 * every order, so an agent that stops part way picks up where it was, and each step it repeats is
 * answered the same, so it never makes a second commitment.
 */

/**
 * A request to the mailbox, with the answer of a sandbox that has no route for service orders said
 * plainly. Any other failure passes through as it came.
 */
const carried = <T>(sent: Promise<T>): Promise<T> =>
  sent.catch((error: unknown) => {
    const unserved =
      error instanceof AvowApiError && error.status === 404 && error.reason === 'request.invalid'
    throw unserved ? new Error("This Avow sandbox doesn't carry service orders yet.") : error
  })

const random = (bytes: number): Hex => toHex(crypto.getRandomValues(new Uint8Array(bytes)))

/** The longest a service order can wait to be funded, which leaves the supplier time to accept. */
export const SERVICE_ORDER_SECONDS = SERVICE_ACCEPT_WITHIN - SERVICE_ORDER_ACCEPT_MARGIN
/** How long a supplier's quote stays valid, in seconds. */
const QUOTE_VALIDITY = 120n
/** The day an offer's capacity counts over, in seconds. */
const DAY = 24n * 60n * 60n

/** Where buying a service got to, in order. */
export type ServiceBuyStep =
  | { step: 'ordered'; order: ServiceOrder }
  | { step: 'quoted'; order: ServiceOrder }
  | { step: 'reserved'; fundedIn: Hex | null }
  | { step: 'accepted'; acceptedIn: Hex | null }

/** How buying a service ended. */
export type ServiceBuyOutcome =
  | { ok: true; order: ServiceOrder }
  | { ok: false; reason: ReasonCode | 'order.expired' | 'acceptance.missed'; order: ServiceOrder }

/** Where selling a service got to, in order. */
export type ServiceSellStep = { step: 'quoted' } | { step: 'accepted'; acceptedIn: Hex | null }

/** An offer as its supplier writes it, before its business is named for it. */
export type ServiceOfferDraft = Omit<ServiceOfferVersion, 'supplier'>

export interface SandboxServices {
  readonly businessId: string
  /**
   * Publishes an offer under this business, and answers with the version and its id. A version of
   * the same item it had published is replaced, since an item has one current version. Publishing
   * keeps the offer in this folder and tells nobody, so hand the version to whoever should order.
   */
  publish(draft: ServiceOfferDraft): Promise<{ version: ServiceOfferVersion; id: Hex }>
  /** The offers this business has published and not withdrawn, oldest first. */
  published(): Promise<ServiceOfferVersion[]>
  /** Withdraws a published version by its id, and says whether there was one. */
  withdraw(id: Hex): Promise<boolean>
  /**
   * Sends an order for units of an offer, with nothing reserved. The order is kept in the store
   * before it's sent, so `buy` can pick it up after a restart.
   */
  order(o: {
    offer: ServiceOfferVersion
    quantity: number
    expiresIn?: bigint
  }): Promise<ServiceOrder>
  /** The orders this agent sent and hasn't seen through, oldest first, for `buy` to resume. */
  unfinished(): Promise<ServiceOrderRequest[]>
  /** Reads one order, as either side. */
  read(orderId: string): Promise<ServiceOrder>
  /**
   * Orders units of an offer and sees it through: waits for the quote, checks it against the
   * order, funds the commitment, tells the mailbox, and waits for the supplier to accept. An order
   * nobody quotes lapses unfunded. With `resume`, it picks up an unfinished order from where it
   * stands instead of sending one, and never funds a commitment the lock already holds.
   */
  buy(
    o: ({ offer: ServiceOfferVersion; quantity: number } | { resume: string }) & {
      expiresIn?: bigint
      onStep?: (step: ServiceBuyStep) => void
      pollEvery?: number
      signal?: AbortSignal
    },
  ): Promise<ServiceBuyOutcome>
  /** The orders waiting on this business as supplier: new ones to quote, funded ones to accept. */
  inbox(): Promise<ServiceOrder[]>
  /**
   * Takes the next step on one order from the inbox: quotes a new one, or accepts a funded one.
   * It throws for an order whose offer this business never published, and for one past the offer's
   * capacity for the day, and quotes nothing for either. A quote counts against the capacity
   * whether or not the buyer funds it, since the signed agreement is what the buyer can fund.
   */
  sell(order: ServiceOrder, onStep?: (step: ServiceSellStep) => void): Promise<void>
  /**
   * Reads the inbox every few seconds and takes each order's next step, until the signal stops it.
   * An order the handler declines is left to lapse, as is one for an offer this business never
   * published. Nothing wakes this when it isn't running.
   */
  listen(o?: {
    accept?: (order: ServiceOrder) => boolean | Promise<boolean>
    onStep?: (order: ServiceOrder, step: ServiceSellStep) => void
    onError?: (order: ServiceOrder, error: unknown) => void
    every?: number
    signal?: AbortSignal
  }): Promise<void>
}

/** An order this business quoted, which counts against its item's capacity for a day. */
interface Quoted {
  orderId: string
  item: string
  at: bigint
}

/** What the store keeps for services: a supplier's offers and quotes, and a buyer's unfinished orders. */
interface Kept {
  published: ServiceOfferVersion[]
  buying: ServiceOrderRequest[]
  quoted: Quoted[]
}

/** Services for the agent in this folder, as buyer and, when it holds a signing key, supplier. */
export async function sandboxServices(o: MailboxOptions = {}): Promise<SandboxServices> {
  const context = await mailboxContext(o)
  const { store, deployment, domain, asAgent } = context
  const { business } = context.item
  const settlement = {
    arbiter: deployment.arbiter,
    day90SupplierShareBps: deployment.day90SupplierShareBps,
  }
  const orderReader = (json: unknown) => {
    const order = parseServiceOrder(json)
    return order
      ? { ok: true as const, value: order }
      : { ok: false as const, reason: 'message.invalid' as const }
  }

  async function kept(): Promise<Kept> {
    const text = await store.read('services')
    const json = text ? readJson(text, 'services') : {}
    const unreadable = () => new Error("The sandbox's services file holds something it can't read.")
    const published = (Array.isArray(json.published) ? json.published : []).map((v: unknown) => {
      const version = parseServiceOfferVersion(v)
      if (!version.ok) throw unreadable()
      return version.value
    })
    const buying = (Array.isArray(json.buying) ? json.buying : []).map((r: unknown) => {
      const request = parseServiceOrderRequest(r)
      if (!request) throw unreadable()
      return request
    })
    const since = systemClock() - DAY
    const quoted = (Array.isArray(json.quoted) ? json.quoted : []).flatMap(
      (q: unknown): Quoted[] => {
        if (!isRecord(q) || typeof q.orderId !== 'string' || typeof q.item !== 'string') return []
        if (typeof q.at !== 'string' || !/^[0-9]{1,15}$/.test(q.at)) return []
        const at = BigInt(q.at)
        // A quote older than a day no longer counts, so it's dropped the next time the file is kept.
        return at > since ? [{ orderId: q.orderId, item: q.item, at }] : []
      },
    )
    return { published, buying, quoted }
  }

  async function keep(change: (k: Kept) => Partial<Kept>) {
    const now = await kept()
    await write(store, 'services', toWire({ ...now, ...change(now) }) as object)
  }

  // The supplier's offers.

  async function publish(draft: ServiceOfferDraft) {
    const version: ServiceOfferVersion = { ...draft, supplier: business.businessId }
    const problem = serviceOfferProblem(version)
    if (problem) throw new RangeError(problem)
    const id = offerVersionId(version)
    await keep((k) => ({
      published: [...k.published.filter((v) => v.item.name !== version.item.name), version],
    }))
    return { version, id }
  }

  const published = async () => (await kept()).published

  async function withdraw(id: Hex): Promise<boolean> {
    const before = await published()
    const after = before.filter((v) => offerVersionId(v) !== id.toLowerCase())
    if (after.length === before.length) return false
    await keep(() => ({ published: after }))
    return true
  }

  // The buyer's side.

  const finish = (orderId: string) =>
    keep((k) => ({ buying: k.buying.filter((r) => r.orderId !== orderId) }))

  const place = (request: ServiceOrderRequest) =>
    carried(
      asAgent({ domain, path: SANDBOX_PATHS.serviceOrders, body: request, read: orderReader }),
    )

  async function order(p: Parameters<SandboxServices['order']>[0]): Promise<ServiceOrder> {
    const builtAt = systemClock()
    const wait = p.expiresIn ?? SERVICE_ORDER_SECONDS
    const request: ServiceOrderRequest = {
      orderId: random(16).slice(2),
      commitmentId: random(32),
      offer: p.offer,
      quantity: p.quantity,
      builtAt,
      expiry: builtAt + (wait < SERVICE_ORDER_SECONDS ? wait : SERVICE_ORDER_SECONDS),
    }
    // An order the mailbox would refuse is refused here, before it's kept or sent.
    const problem = serviceOrderProblem(request, builtAt)
    if (problem) throw new RangeError(`The order can't be sent: ${problem}`)
    await keep((k) => ({ buying: [...k.buying, request] }))
    return place(request).catch(async (error: unknown) => {
      // An order Avow refused outright was never held, so there's nothing to pick up later.
      if (!(error instanceof AvowApiError) || error.definite) await finish(request.orderId)
      throw error
    })
  }

  const unfinished = async () => (await kept()).buying

  const read = (orderId: string) =>
    carried(
      asAgent({ domain, path: SANDBOX_PATHS.serviceOrder(orderId), body: {}, read: orderReader }),
    )

  async function buy(p: Parameters<SandboxServices['buy']>[0]): Promise<ServiceBuyOutcome> {
    const every = p.pollEvery ?? 3000
    let current: ServiceOrder
    if ('resume' in p) {
      const resumed = (await unfinished()).find((r) => r.orderId === p.resume)
      if (!resumed) throw new Error(`This agent has no unfinished order ${p.resume}.`)
      // Sending a kept order again is answered with where it stands.
      current = await place(resumed)
    } else {
      current = await order(p)
    }
    p.onStep?.({ step: 'ordered', order: current })
    const end = async (outcome: ServiceBuyOutcome) => {
      await finish(current.orderId)
      return outcome
    }
    while (current.status === 'requested') {
      await pause(every, p.signal)
      current = await read(current.orderId)
    }
    if (current.status === 'expired')
      return end({ ok: false, reason: 'order.expired', order: current })
    if (current.status === 'quoted') {
      const funded = await fund(current, p)
      if ('reason' in funded) return end(funded)
      current = funded.order
    }
    return end(await awaitAcceptance(current, every, p))
  }

  /** Checks the quote and funds it, unless the lock already holds it, and tells the mailbox. */
  async function fund(
    current: Extract<ServiceOrder, { status: 'quoted' }>,
    p: Parameters<SandboxServices['buy']>[0],
  ): Promise<{ order: ServiceOrder } | Extract<ServiceBuyOutcome, { ok: false }>> {
    p.onStep?.({ step: 'quoted', order: current })
    const { quote } = current

    // The buyer's own check, before anything is reserved: the quote has to answer this order.
    const changed = serviceQuoteProblem(current, quote, settlement)
    if (changed) return { ok: false, reason: changed, order: current }

    // A reserve already on the lock, from a run that stopped after funding, is reported as it is.
    let fundedIn: Hex | null = null
    if (!(await context.held(current.commitmentId))) {
      const result = await context.commit({
        supplier: await context.supplierProfile(current.offer.supplier),
        terms: quote.terms,
        salt: quote.salt,
        agreement: quote.agreement,
        supplierSignature: quote.supplierSignature,
      })
      if (!result.ok) return { ok: false, reason: result.reason, order: current }
      fundedIn = result.commitment.reservedIn ?? null
    }
    await record(current)
    const reported = await context.reportReserved(
      SANDBOX_PATHS.serviceReserved(current.orderId),
      fundedIn,
      orderReader,
      p.signal,
    )
    p.onStep?.({ step: 'reserved', fundedIn })
    return { order: reported }
  }

  /** Adds the commitment to the ones this agent made, once, so it's listed with the others. */
  async function record(funded: Extract<ServiceOrder, { status: 'quoted' }>) {
    const reference: CommitmentReference = {
      kind: 'commitment',
      chainId: deployment.chainId,
      lock: business.lock,
      commitmentId: funded.commitmentId,
      side: 'buyer',
      termsHash: funded.quote.agreement.termsHash,
    }
    const made = await loadCommitments(store)
    if (made.some((c) => c.reference.commitmentId === reference.commitmentId)) return
    await addCommitment(store, {
      reference,
      amount: funded.quote.terms.backing.amount,
      supplier: funded.offer.supplier,
      mandateHash: funded.quote.agreement.mandateHash,
      madeAt: systemClock(),
    })
  }

  async function awaitAcceptance(
    from: ServiceOrder,
    every: number,
    p: Parameters<SandboxServices['buy']>[0],
  ): Promise<ServiceBuyOutcome> {
    const waited = await awaitAccepted(from, read, every, p.signal)
    if (!waited.ok) return waited
    p.onStep?.({ step: 'accepted', acceptedIn: waited.acceptedIn })
    return { ok: true, order: waited.order }
  }

  // The supplier's side.

  async function inbox(): Promise<ServiceOrder[]> {
    const { asSupplier } = context.needSupplier()
    return carried(
      asSupplier({
        domain,
        path: SANDBOX_PATHS.serviceInbox,
        body: {},
        read: (json) => {
          const read = parseServiceInbox(json)
          return read ? { ok: true, value: read.orders } : { ok: false, reason: 'message.invalid' }
        },
      }),
    )
  }

  async function sell(sale: ServiceOrder, onStep?: (step: ServiceSellStep) => void): Promise<void> {
    const { asSupplier, signing, supplier } = context.needSupplier()
    if (sale.status === 'requested') {
      // The offer in an order is the buyer's copy, so only a version published here is quoted.
      const version = publishedOffer(sale, await published())
      if (!version) throw new Error("The order is for an offer this business hasn't published.")
      const problem = serviceOrderProblem(sale, systemClock())
      if (problem) throw new Error(`The order can't be quoted: ${problem}`)
      // The terms don't carry the offer's capacity, so the supplier's own agent counts against it.
      // An order it already quoted is quoted again without counting twice.
      const { quoted } = await kept()
      const name = version.item.name
      if (!quoted.some((q) => q.orderId === sale.orderId)) {
        if (quoted.filter((q) => q.item === name).length >= version.rules.dailyCapacity) {
          throw new Error(
            "The offer's capacity for the day is taken, so the order is left to lapse.",
          )
        }
        const taken = { orderId: sale.orderId, item: name, at: systemClock() }
        await keep((k) => ({ quoted: [...k.quoted, taken] }))
      }
      const quote = await quoteService({
        order: { ...sale, offer: version },
        buyer: sale.buyer,
        supplier: supplier.profile,
        signingKey: signingRequestKey(signing),
        settlement,
        expiry: systemClock() + QUOTE_VALIDITY,
      })
      await asSupplier({
        domain,
        path: SANDBOX_PATHS.serviceQuote(sale.orderId),
        body: quote,
        read: orderReader,
      })
      onStep?.({ step: 'quoted' })
      return
    }
    if (sale.status === 'reserved') {
      // Null when an earlier run's acceptance was already on the lock, which Avow reads either way.
      const acceptedIn = await context.accept(sale.buyer, sale.quote)
      await asSupplier({
        domain,
        path: SANDBOX_PATHS.serviceAccepted(sale.orderId),
        body: { acceptedIn },
        read: orderReader,
      })
      onStep?.({ step: 'accepted', acceptedIn })
    }
  }

  const listen = (p: Parameters<SandboxServices['listen']>[0] = {}) =>
    listenFor<ServiceOrder, ServiceSellStep>({ ...p, inbox, sell })

  return {
    businessId: business.businessId,
    publish,
    published,
    withdraw,
    order,
    unfinished,
    read,
    buy,
    inbox,
    sell,
    listen,
  }
}
