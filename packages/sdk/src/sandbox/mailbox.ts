import {
  type BuyerSideReference,
  type ComputeOffer,
  commitmentReferenceJson,
  computeOffersPath,
  computeOfferTerms,
  DEMO_JOB_TIMING,
  GPU_RESERVATION,
  type GpuReservationTerms,
  isChainedTerms,
  isFirmOffer,
  type JobOfferVersion,
  jobOfferTerms,
  type MailboxOrder,
  type MailboxOrderRequest,
  offerTakes,
  parseComputeOffers,
  parseMailboxInbox,
  parseMailboxOrder,
  parseMailboxOrderRequest,
  parseTerms,
  quoteTermsProblem,
  type ReasonCode,
  SANDBOX_PATHS,
  standInComputeBooking,
  testnetDemoJobTerms,
} from '@avow-finance/spec'
import { type Hex, toHex } from 'viem'
import { signingRequestKey } from '../http.js'
import { type ComputeBooking, jobQuoteTerms, quoteJob } from '../job/quote.js'
import { sandboxAgent } from './agent.js'
import { pause } from './connect.js'
import {
  awaitAccepted,
  listenFor,
  type MailboxOptions,
  mailboxContext,
  systemClock,
} from './mailbox-context.js'
import { jobOfferFor, publishedOffers } from './published-offers.js'
import { holdToNamedMandate, type SellerStanding } from './seller-mandate.js'
import { sellerStandingOf } from './seller-mandate-read.js'
import { holdInTurn, holdJobInTurn, holdJobQuote, jobAccepted, releaseJob } from './seller-sales.js'
import { isRecord, readJson, write } from './store.js'

/**
 * The sandbox mailbox from an agent's side. A buyer's agent orders a job from another business,
 * checks the quote that comes back and funds it. A supplier's agent reads its inbox, books the
 * compute the job relies on, quotes, and accepts once the buyer has funded. Avow keeps every order,
 * so an agent that stops part way picks up where it was, and each step it repeats is answered the
 * same, so it never makes a second commitment.
 */

const random = (bytes: number): Hex => toHex(crypto.getRandomValues(new Uint8Array(bytes)))

/** How long an order waits to be funded unless the buyer says otherwise, in seconds. */
export const MAILBOX_ORDER_SECONDS = 600n
/** How long a supplier's quote stays valid, in seconds. */
const QUOTE_VALIDITY = 120n

/** Where a buy got to, in order. */
export type BuyStep =
  | { step: 'ordered'; order: MailboxOrder }
  | { step: 'quoted'; order: MailboxOrder }
  | { step: 'reserved'; fundedIn: Hex | null }
  | { step: 'accepted'; acceptedIn: Hex | null }

/** How a buy ended. */
export type BuyOutcome =
  | { ok: true; order: MailboxOrder }
  | { ok: false; reason: ReasonCode | 'order.expired' | 'acceptance.missed'; order: MailboxOrder }

/** Where a sale got to, in order. */
/**
 * Where a sale got to, in order. A quote and an acceptance say where the agent stood as a seller
 * when it took them, so whoever runs it can say whether a seller's mandate was in force.
 */
export type SellStep =
  | { step: 'compute'; reservedIn: Hex | null }
  | { step: 'quoted'; standing: SellerStanding }
  | { step: 'accepted'; acceptedIn: Hex | null; standing: SellerStanding }

/** The compute a seller booked for one order, kept so a restart never books it twice. */
interface SaleRecord {
  compute: ComputeBooking
}

/** The sales kept in the store, read back to the types they were written from. */
function readSales(json: Record<string, unknown>): Record<string, SaleRecord> {
  const sales: Record<string, SaleRecord> = {}
  for (const [orderId, value] of Object.entries(isRecord(json.sales) ? json.sales : {})) {
    const kept = isRecord(value) && isRecord(value.compute) ? value.compute : {}
    const reference = commitmentReferenceJson.safeParse(kept.reference)
    const terms = parseTerms(kept.terms)
    const salt = typeof kept.salt === 'string' && /^0x[0-9a-f]{64}$/i.test(kept.salt)
    if (
      !reference.success ||
      reference.data.side !== 'buyer' ||
      !terms.ok ||
      terms.value.template !== GPU_RESERVATION ||
      !salt
    ) {
      throw new Error(`The sandbox's mailbox file holds a sale it can't read, for ${orderId}.`)
    }
    sales[orderId] = {
      compute: {
        reference: { ...reference.data, side: 'buyer' },
        terms: terms.value as GpuReservationTerms,
        salt: kept.salt as Hex,
      },
    }
  }
  return sales
}

export interface SandboxMailbox {
  readonly businessId: string
  /**
   * Sends an order for a job to another business, with nothing reserved. With `offer`, a job offer
   * version the supplier published, the job is the one `jobOfferTerms` builds from it now, and the
   * order lapses by the time the offer gives the supplier to accept before work starts. Without
   * one, it's the demo job. The order is kept in the store before it's sent, so `buy` can pick it
   * up after a restart.
   */
  order(o: { supplier: string; offer?: JobOfferVersion; expiresIn?: bigint }): Promise<MailboxOrder>
  /** The orders this agent sent and hasn't seen through, oldest first, for `buy` to resume. */
  unfinished(): Promise<MailboxOrderRequest[]>
  /** Reads one order, as either side. */
  read(orderId: string): Promise<MailboxOrder>
  /**
   * Orders a job and sees it through: waits for the quote, checks it, funds the commitment, tells
   * the mailbox, and waits for the supplier to accept. An order nobody quotes lapses unfunded.
   * With `resume`, it picks up an unfinished order from where it stands instead of sending one,
   * and never funds a commitment the lock already holds.
   */
  buy(o: {
    supplier: string
    offer?: JobOfferVersion
    resume?: string
    expiresIn?: bigint
    onStep?: (step: BuyStep) => void
    pollEvery?: number
    signal?: AbortSignal
  }): Promise<BuyOutcome>
  /** The orders waiting on this business as supplier: new ones to quote, funded ones to accept. */
  inbox(): Promise<MailboxOrder[]>
  /**
   * Takes the next step on one order from the inbox: quotes a new one, or accepts a funded one. An
   * order for a kind of work this business published a job offer of has to be exactly the job its
   * current version builds, or this throws before any compute is booked and nothing is quoted.
   */
  sell(order: MailboxOrder, onStep?: (step: SellStep) => void): Promise<void>
  /**
   * Reads the inbox every few seconds and takes each order's next step, until the signal stops it.
   * An order the handler declines is left to lapse. Nothing wakes this when it isn't running.
   */
  listen(o?: {
    accept?: (order: MailboxOrder) => boolean | Promise<boolean>
    onStep?: (order: MailboxOrder, step: SellStep) => void
    onError?: (order: MailboxOrder, error: unknown) => void
    every?: number
    signal?: AbortSignal
  }): Promise<void>
}

/** The mailbox for the agent in this folder, as buyer and, when it holds a signing key, supplier. */
export async function sandboxMailbox(o: MailboxOptions = {}): Promise<SandboxMailbox> {
  const context = await mailboxContext(o)
  const { send, store, deployment, domain, asAgent } = context
  const { business } = context.item
  const orderReader = (json: unknown) => {
    const order = parseMailboxOrder(json)
    return order
      ? { ok: true as const, value: order }
      : { ok: false as const, reason: 'message.invalid' as const }
  }

  // The buyer's side.

  /** What the store keeps for the mailbox: a seller's bookings, and a buyer's unfinished orders. */
  async function kept(): Promise<{
    sales: Record<string, SaleRecord>
    buying: MailboxOrderRequest[]
  }> {
    const text = await store.read('mailbox')
    const json = text ? readJson(text, 'mailbox') : {}
    const buying = (Array.isArray(json.buying) ? json.buying : []).map((r: unknown) => {
      const request = parseMailboxOrderRequest(r)
      if (!request) throw new Error("The sandbox's mailbox file holds an order it can't read.")
      return request
    })
    return { sales: readSales(json), buying }
  }

  async function keep(
    change: (k: Awaited<ReturnType<typeof kept>>) => Partial<Awaited<ReturnType<typeof kept>>>,
  ) {
    const now = await kept()
    await write(store, 'mailbox', { ...now, ...change(now) })
  }

  const finish = (orderId: string) =>
    keep((k) => ({ buying: k.buying.filter((r) => r.orderId !== orderId) }))

  const place = (request: MailboxOrderRequest) =>
    asAgent({ domain, path: SANDBOX_PATHS.mailboxOrders, body: request, read: orderReader })

  /** The job an order offers and when it lapses, from a job offer version or the demo job. */
  function jobOf(p: { supplier: string; offer?: JobOfferVersion; expiresIn?: bigint }) {
    const now = systemClock()
    const asked = now + (p.expiresIn ?? MAILBOX_ORDER_SECONDS)
    if (!p.offer) {
      return {
        terms: testnetDemoJobTerms(asked + DEMO_JOB_TIMING.accept, deployment.arbiter),
        expiry: asked,
      }
    }
    if (p.offer.supplier !== p.supplier) {
      throw new RangeError('The job offer names another supplier than the one ordered from.')
    }
    const terms = jobOfferTerms(p.offer, now, {
      arbiter: deployment.arbiter,
      day90SupplierShareBps: deployment.day90SupplierShareBps,
    })
    // The supplier accepts by the start, so the order lapses early enough to leave it that time.
    const latest = terms.subject.startsAt - DEMO_JOB_TIMING.accept
    return { terms, expiry: asked < latest ? asked : latest }
  }

  async function order(p: Parameters<SandboxMailbox['order']>[0]): Promise<MailboxOrder> {
    const { terms, expiry } = jobOf(p)
    const request: MailboxOrderRequest = {
      orderId: random(16).slice(2),
      commitmentId: random(32),
      supplierBusinessId: p.supplier,
      terms,
      requirement: { template: GPU_RESERVATION, condition: 'accepted', disclosed: 'subject' },
      expiry,
    }
    await keep((k) => ({ buying: [...k.buying, request] }))
    return place(request)
  }

  const unfinished = async () => (await kept()).buying

  const read = (orderId: string) =>
    asAgent({ domain, path: SANDBOX_PATHS.mailboxOrder(orderId), body: {}, read: orderReader })

  async function buy(p: Parameters<SandboxMailbox['buy']>[0]): Promise<BuyOutcome> {
    const every = p.pollEvery ?? 3000
    const resumed = p.resume ? (await unfinished()).find((r) => r.orderId === p.resume) : null
    if (p.resume && !resumed) throw new Error(`This agent has no unfinished order ${p.resume}.`)
    // Sending a kept order again is answered with where it stands.
    let current = resumed ? await place(resumed) : await order(p)
    p.onStep?.({ step: 'ordered', order: current })
    const end = async (outcome: BuyOutcome) => {
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
    current: Extract<MailboxOrder, { status: 'quoted' }>,
    p: Parameters<SandboxMailbox['buy']>[0],
  ): Promise<{ order: MailboxOrder } | Extract<BuyOutcome, { ok: false }>> {
    p.onStep?.({ step: 'quoted', order: current })
    const quote = current.quote

    // The buyer's own checks, before anything is reserved.
    if (!isChainedTerms(quote.terms))
      return { ok: false, reason: 'dependency.required', order: current }
    const changed =
      quoteTermsProblem(current.terms, quote.terms) ??
      (quote.agreement.commitmentId.toLowerCase() === current.commitmentId.toLowerCase()
        ? null
        : 'order.commitment_mismatch')
    if (changed) return { ok: false, reason: changed, order: current }

    // A reserve already on the lock, from a run that stopped after funding, is reported as it is.
    let fundedIn: Hex | null = null
    if (!(await context.held(current.commitmentId))) {
      const result = await context.commit({
        supplier: await context.supplierProfile(current.supplierBusinessId),
        terms: quote.terms,
        salt: quote.salt,
        agreement: quote.agreement,
        supplierSignature: quote.supplierSignature,
        disclosed: quote.disclosed,
      })
      if (!result.ok) return { ok: false, reason: result.reason, order: current }
      fundedIn = result.commitment.reservedIn ?? null
    }
    const reported = await context.reportReserved(
      SANDBOX_PATHS.mailboxReserved(current.orderId),
      fundedIn,
      orderReader,
      p.signal,
    )
    p.onStep?.({ step: 'reserved', fundedIn })
    return { order: reported }
  }

  async function awaitAcceptance(
    from: MailboxOrder,
    every: number,
    p: Parameters<SandboxMailbox['buy']>[0],
  ): Promise<BuyOutcome> {
    const waited = await awaitAccepted(from, read, every, p.signal)
    if (!waited.ok) return waited
    p.onStep?.({ step: 'accepted', acceptedIn: waited.acceptedIn })
    return { ok: true, order: waited.order }
  }

  // The supplier's side.

  const { needSupplier } = context

  async function inbox(): Promise<MailboxOrder[]> {
    const { asSupplier } = needSupplier()
    return asSupplier({
      domain,
      path: SANDBOX_PATHS.mailboxInbox,
      body: {},
      read: (json) => {
        const read = parseMailboxInbox(json)
        return read ? { ok: true, value: read.orders } : { ok: false, reason: 'message.invalid' }
      },
    })
  }

  /** A firm offer that holds the job's GPUs for its whole run, the cheapest per GPU-hour. */
  async function computeFor(job: MailboxOrder): Promise<{ offer: ComputeOffer; gpus: number }> {
    const s = job.terms.subject
    const url = `${new URL(deployment.supplierUrl).origin}${computeOffersPath(s)}`
    const answer = await send(url, { headers: { accept: 'application/json' }, redirect: 'error' })
    const listing = parseComputeOffers(await answer.json().catch(() => null))
    if (!answer.ok || !listing.ok) throw new Error('The compute supplier listed no offers')
    const gpus = s.compute.count
    const fits = listing.value.offers.filter(
      (offer) =>
        isFirmOffer(offer, listing.value.listedAt) &&
        offer.startsAt <= s.startsAt &&
        offer.startsAt + BigInt(offer.minutes) * 60n >= s.deliverBy &&
        offerTakes(offer, gpus) &&
        offer.gpu === s.compute.gpu,
    )
    const [cheapest] = fits.sort((a, b) => (a.pricePerGpuHour < b.pricePerGpuHour ? -1 : 1))
    if (!cheapest) throw new Error('No compute offer holds the job for its whole run')
    return { offer: cheapest, gpus }
  }

  const sellerStanding = sellerStandingOf({
    deployment,
    send,
    business,
    signing: () => needSupplier().signing,
  })

  /** Books the compute a job relies on, from the testnet's compute offers, and waits for it. */
  async function bookCompute(job: MailboxOrder) {
    const agent = await sandboxAgent({
      store,
      deployment,
      session: null,
      log: () => {},
      fetch: send,
    })
    const { offer, gpus } = await computeFor(job)
    const terms = computeOfferTerms(offer, gpus, deployment)
    const booked = await agent.bookTerms({ supplier: offer.supplier, terms })
    if (!(await booked.accepted())) throw new Error('The compute supplier never accepted')
    const compute: ComputeBooking = {
      reference: booked.reference as BuyerSideReference,
      terms,
      salt: booked.commitment.salt,
    }
    return { compute, reservedIn: booked.commitment.reservedIn }
  }

  async function sell(job: MailboxOrder, onStep?: (step: SellStep) => void): Promise<void> {
    const { asSupplier, signing, supplier } = needSupplier()
    if (job.status === 'requested') {
      // An order for a kind of work this business offers has to be the job its current offer
      // builds, checked before anything is booked, since the terms name no offer of their own.
      const offered = jobOfferFor(job.terms, await publishedOffers(store), systemClock())
      const capacity = offered ? offered.rules.dailyCapacity : null
      let compute = (await kept()).sales[job.orderId]?.compute ?? null
      if (!compute) {
        // The job is held to the seller's mandate before any compute is booked for it, so a job the
        // mandate refuses leaves nothing booked. Its limits don't read the booking a job relies on,
        // so this check runs on the job's terms with a stand-in for the booking, and the check
        // below holds the exact terms the quote signs. A job past its offer's capacity for the day
        // books nothing either.
        await holdJobInTurn(
          store,
          await sellerStanding(),
          {
            orderId: job.orderId,
            terms: jobQuoteTerms(job, {
              reference: standInComputeBooking(deployment.chainId, business.lock),
            }),
            offer: null,
            buyer: job.buyer.businessId,
            signingKey: signing.address,
          },
          capacity,
          systemClock(),
        )
        // The hold above took the job's place, so a booking that fails gives it back.
        let booked: Awaited<ReturnType<typeof bookCompute>>
        try {
          booked = await bookCompute(job)
        } catch (error) {
          await releaseJob(store, job.orderId, systemClock())
          throw error
        }
        compute = booked.compute
        const booking = compute
        await keep((k) => ({ sales: { ...k.sales, [job.orderId]: { compute: booking } } }))
        onStep?.({ step: 'compute', reservedIn: booked.reservedIn })
      }
      // The job is held to the seller's mandate again on the exact terms the quote signs, and the
      // quote names the mandate it was held to. The mandate is read again after the compute is
      // booked, so a booking that took a while is checked against the newest one.
      const terms = jobQuoteTerms(job, compute)
      const standing = await sellerStanding()
      const now = systemClock()
      const sale = {
        orderId: job.orderId,
        terms,
        buyer: job.buyer.businessId,
        signingKey: signing.address,
      }
      const sellerMandate = await holdJobQuote(store, standing, sale, now, capacity)
      const quote = await quoteJob({
        offer: job,
        customer: job.buyer,
        supplier: supplier.profile,
        signingKey: signingRequestKey(signing),
        compute,
        expiry: now + QUOTE_VALIDITY,
        sellerMandate,
      })
      await asSupplier({
        domain,
        path: SANDBOX_PATHS.mailboxQuote(job.orderId),
        body: quote,
        read: orderReader,
      })
      onStep?.({ step: 'quoted', standing })
      return
    }
    if (job.status === 'reserved') {
      // The mandate may have changed, ended or been revoked since the quote, so the job is held to
      // the newest one again before the acceptance binds the seller, and only when it's the one
      // the agreement names.
      const standing = await sellerStanding()
      holdToNamedMandate(standing, job.quote.agreement.sellerMandate)
      const sale = {
        orderId: job.orderId,
        terms: job.quote.terms,
        offer: null,
        buyer: job.buyer.businessId,
        signingKey: signing.address,
      }
      await holdInTurn(store, standing, sale, systemClock())
      // Null when an earlier run's acceptance was already on the lock, which Avow reads either way.
      const acceptedIn = await context.accept(job.buyer, job.quote)
      await jobAccepted(store, job.orderId, systemClock())
      await asSupplier({
        domain,
        path: SANDBOX_PATHS.mailboxAccepted(job.orderId),
        body: { acceptedIn },
        read: orderReader,
      })
      onStep?.({ step: 'accepted', acceptedIn, standing })
    }
  }

  const listen = (p: Parameters<SandboxMailbox['listen']>[0] = {}) =>
    listenFor<MailboxOrder, SellStep>({ ...p, inbox, sell })

  return { businessId: business.businessId, order, unfinished, read, buy, inbox, sell, listen }
}

export type { MailboxOptions }
