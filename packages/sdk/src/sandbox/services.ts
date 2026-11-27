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
  type ServiceQuote,
  saleFacts,
  serviceOfferProblem,
  serviceOfferTerms,
  serviceOrderProblem,
  serviceQuoteProblem,
  tempoKeychainCheck,
  toWire,
} from '@avow-finance/spec'
import { type Hex, toHex } from 'viem'
import { AvowApiError, signingRequestKey } from '../http.js'
import { moderatoClient } from '../moderato.js'
import { quoteService } from '../service/quote.js'
import { pause } from './connect.js'
import {
  awaitAccepted,
  listenFor,
  type MailboxOptions,
  mailboxContext,
  systemClock,
} from './mailbox-context.js'
import {
  type CountedSale,
  DAY,
  holdOffer,
  holdSale,
  ledgerFor,
  type SellerStanding,
} from './seller-mandate.js'
import { readSellerStanding } from './seller-mandate-read.js'
import {
  addCommitment,
  isRecord,
  loadCommitments,
  readJson,
  type SandboxStore,
  write,
} from './store.js'

/**
 * Services through the sandbox mailbox, from an agent's side. A supplier's agent publishes offers
 * it keeps in its own folder, reads its inbox, quotes an order for an offer it published, and
 * accepts once the buyer has funded. A buyer's agent orders units of an offer it was given, checks
 * the quote that comes back against its own order, and funds it under its mandate. Avow keeps
 * every order, so an agent that stops part way picks up where it was, and each step it repeats is
 * answered the same, so it never makes a second commitment.
 */

/** What a sandbox with no route for service orders is told, whichever call found out. */
export const SERVICE_ORDERS_UNSERVED = "This Avow sandbox doesn't carry service orders yet."

/**
 * A request to the mailbox, with the answer of a sandbox that has no route for service orders said
 * plainly. Any other failure passes through as it came, a missing order included.
 */
const carried = <T>(sent: Promise<T>): Promise<T> =>
  sent.catch((error: unknown) => {
    const unserved =
      error instanceof AvowApiError &&
      error.status === 404 &&
      error.reason === 'request.invalid' &&
      /no such route/i.test(error.message)
    throw unserved ? new Error(SERVICE_ORDERS_UNSERVED) : error
  })

/**
 * One change at a time to what a store keeps, in this process. Each change reads the file and
 * writes it back, so two at once would lose one. Another process on the same folder isn't held
 * back by this, so run one seller on a folder at a time.
 */
const turns = new WeakMap<SandboxStore, Promise<unknown>>()
function inTurn<T>(store: SandboxStore, change: () => Promise<T>): Promise<T> {
  const turn = (turns.get(store) ?? Promise.resolve()).then(change, change)
  turns.set(
    store,
    turn.catch(() => {}),
  )
  return turn
}

const random = (bytes: number): Hex => toHex(crypto.getRandomValues(new Uint8Array(bytes)))

/** The longest a service order can wait to be funded, which leaves the supplier time to accept. */
export const SERVICE_ORDER_SECONDS = SERVICE_ACCEPT_WITHIN - SERVICE_ORDER_ACCEPT_MARGIN
/** How long a supplier's quote stays valid, in seconds. */
const QUOTE_VALIDITY = 120n

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

/**
 * Where selling a service got to, in order. Each step says where the agent stood as a seller when
 * it took it, so whoever runs it can say whether a seller's mandate was in force.
 */
export type ServiceSellStep =
  | { step: 'quoted'; standing: SellerStanding }
  | { step: 'accepted'; acceptedIn: Hex | null; standing: SellerStanding }

/** An offer as its supplier writes it, before its business is named for it. */
export type ServiceOfferDraft = Omit<ServiceOfferVersion, 'supplier'>

export interface SandboxServices {
  readonly businessId: string
  /** Whether the folder holds a signing key, so the agent can quote and accept as a supplier. */
  readonly sells: boolean
  /**
   * Publishes an offer under this business, and answers with the version, its id and where the
   * agent stands as a seller. A version of the same item it had published is replaced, since an
   * item has one current version. Publishing keeps the offer in this folder and tells nobody, so
   * hand the version to whoever should order. An agent that sells under a seller's mandate lists
   * only an offer the mandate allows, and throws a `SellerMandateRefusal` for any other.
   */
  publish(
    draft: ServiceOfferDraft,
  ): Promise<{ version: ServiceOfferVersion; id: Hex; standing: SellerStanding | null }>
  /**
   * Reads where the agent stands as a seller: the seller's mandate in force for its signing key,
   * read from Avow and checked as one chain the business account signed, or none. With none, it
   * sells as it did before, and Avow doesn't enforce seller limits yet either way.
   */
  sellerStanding(): Promise<SellerStanding>
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
   * capacity for the day, and quotes nothing for either. A quote holds its place while the order
   * can still be accepted, and an accepted order holds it for the day. It accepts only an order
   * whose quote it signed. Under a seller's mandate it checks the sale against the newest mandate
   * before it quotes and again before it accepts, and throws a `SellerMandateRefusal` with the
   * spec's reason for a sale the mandate doesn't allow, so the order lapses.
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

/**
 * An order this business quoted. It holds a place in its item's capacity until the supplier can no
 * longer accept it, and for the rest of the day once the supplier has.
 */
interface Quoted {
  orderId: string
  item: string
  at: bigint
  /** The last moment the supplier can accept the order, in unix seconds. */
  until: bigint
  accepted: boolean
  /** The terms hash of each agreement this agent signed for the order. */
  hashes: Hex[]
  /**
   * What the sale comes to, as the seller's mandate counts it: its units, its whole price in micros
   * and when it's delivered by. Null for a quote kept before the agent counted sales, which a
   * mandate's ledger then leaves out, and which is dropped a day after it was made.
   */
  sale: { units: number; price: bigint; deliverBy: bigint } | null
}

/** What the store keeps for services: a supplier's offers and quotes, and a buyer's unfinished orders. */
interface Kept {
  published: ServiceOfferVersion[]
  buying: ServiceOrderRequest[]
  quoted: Quoted[]
}

const isSeconds = (v: unknown): v is string => typeof v === 'string' && /^[0-9]{1,15}$/.test(v)
const isHash = (v: unknown): v is Hex => typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v)

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
    const now = systemClock()
    const since = now - DAY
    const quoted = (Array.isArray(json.quoted) ? json.quoted : []).flatMap(
      (q: unknown): Quoted[] => {
        if (!isRecord(q) || typeof q.orderId !== 'string' || typeof q.item !== 'string') return []
        if (!isSeconds(q.at) || !isSeconds(q.until) || typeof q.accepted !== 'boolean') return []
        const hashes = Array.isArray(q.hashes) ? q.hashes.filter(isHash) : []
        const at = BigInt(q.at)
        const s = isRecord(q.sale) ? q.sale : null
        const sale =
          s &&
          Number.isSafeInteger(s.units) &&
          (s.units as number) >= 0 &&
          typeof s.price === 'string' &&
          /^[0-9]{1,78}$/.test(s.price) &&
          isSeconds(s.deliverBy)
            ? { units: s.units as number, price: BigInt(s.price), deliverBy: BigInt(s.deliverBy) }
            : null
        // A quote older than a day no longer takes a place, so it's dropped the next time the file
        // is kept, unless it was accepted and isn't due yet, which a seller's mandate still counts
        // as outstanding.
        const owed = q.accepted && sale !== null && sale.deliverBy > now
        return at > since || owed
          ? [
              {
                orderId: q.orderId,
                item: q.item,
                at,
                until: BigInt(q.until),
                accepted: q.accepted,
                hashes,
                sale,
              },
            ]
          : []
      },
    )
    return { published, buying, quoted }
  }

  /**
   * Changes what's kept, one change at a time. The change sees the file as it is when its turn
   * comes, and a change that throws writes nothing.
   */
  const keep = (change: (k: Kept) => Partial<Kept>) =>
    inTurn(store, async () => {
      const now = await kept()
      await write(store, 'services', toWire({ ...now, ...change(now) }) as object)
    })

  const sells = (() => {
    try {
      context.needSupplier()
      return true
    } catch {
      return false
    }
  })()

  // Where the agent stands as a seller.

  const client = moderatoClient(deployment.rpcUrl)
  function sellerStanding(): Promise<SellerStanding> {
    const { signing } = context.needSupplier()
    return readSellerStanding({
      apiUrl: deployment.apiUrl,
      signing,
      fetch: context.send,
      domain,
      agent: {
        businessId: business.businessId,
        account: business.account,
        signingKey: signing.address,
      },
      isAccountSignature: tempoKeychainCheck(client),
    })
  }

  /** The sales the ledger counts, from the quotes this agent kept, apart from one order. */
  const counted = (k: Kept, apart: string): CountedSale[] =>
    k.quoted.flatMap((q) =>
      q.sale && q.orderId !== apart
        ? [{ item: q.item, at: q.at, until: q.until, accepted: q.accepted, ...q.sale }]
        : [],
    )

  /**
   * Throws a refusal when the mandate in force doesn't allow this sale on these terms, counting the
   * ledger from what's kept apart from this order. It reads nothing, so it runs inside the change
   * that takes the order's place, and two orders at once can't both pass the same limit.
   */
  function holdToMandate(
    k: Kept,
    standing: SellerStanding,
    sale: ServiceOrder,
    terms: ServiceQuote['terms'],
    version: ServiceOfferVersion,
    now: bigint,
  ) {
    if (!standing.inForce) return
    const { signing } = context.needSupplier()
    holdSale(
      standing,
      {
        terms,
        offer: version,
        buyer: sale.buyer.businessId,
        signingKey: signing.address,
        ledger: ledgerFor(standing, version.item.name, counted(k, sale.orderId), now),
      },
      now,
    )
  }

  // The supplier's offers.

  async function publish(draft: ServiceOfferDraft) {
    const version: ServiceOfferVersion = { ...draft, supplier: business.businessId }
    const problem = serviceOfferProblem(version)
    if (problem) throw new RangeError(problem)
    // An agent that can sell lists only what its seller's mandate allows, when one is in force.
    const standing = sells ? await sellerStanding() : null
    if (standing)
      holdOffer(standing, version, context.needSupplier().signing.address, systemClock())
    // An offer that wouldn't read back, such as one with a time too long to write, is never kept.
    if (!parseServiceOfferVersion(JSON.parse(JSON.stringify(toWire(version)))).ok) {
      throw new RangeError('The offer holds a number too large to keep.')
    }
    const id = offerVersionId(version)
    await keep((k) => ({
      published: [...k.published.filter((v) => v.item.name !== version.item.name), version],
    }))
    return { version, id, standing }
  }

  const published = async () => (await kept()).published

  async function withdraw(id: Hex): Promise<boolean> {
    let gone = false
    await keep((k) => {
      const left = k.published.filter((v) => offerVersionId(v) !== id.toLowerCase())
      gone = left.length !== k.published.length
      return { published: left }
    })
    return gone
  }

  // The buyer's side.

  const finish = (orderId: string) =>
    keep((k) => ({ buying: k.buying.filter((r) => r.orderId !== orderId) }))

  const place = (request: ServiceOrderRequest) =>
    carried(
      asAgent({ domain, path: SANDBOX_PATHS.serviceOrders, body: request, read: orderReader }),
    )

  /** Keeps a new order, then sends it, and answers with both the request and the mailbox's order. */
  async function send(p: Parameters<SandboxServices['order']>[0]) {
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
    const order = await place(request).catch(async (error: unknown) => {
      // An order Avow refused outright was never held, so there's nothing to pick up later.
      if (!(error instanceof AvowApiError) || error.definite) await finish(request.orderId)
      throw error
    })
    return { request, order }
  }

  const order = async (p: Parameters<SandboxServices['order']>[0]) => (await send(p)).order

  const unfinished = async () => (await kept()).buying

  const read = (orderId: string) =>
    carried(
      asAgent({ domain, path: SANDBOX_PATHS.serviceOrder(orderId), body: {}, read: orderReader }),
    )

  async function buy(p: Parameters<SandboxServices['buy']>[0]): Promise<ServiceBuyOutcome> {
    const every = p.pollEvery ?? 3000
    // The request this agent kept is what every later check is made against. The mailbox's copy
    // of the order says where it stands and carries the quote, and is trusted for nothing else.
    let mine: ServiceOrderRequest
    let current: ServiceOrder
    if ('resume' in p) {
      const resumed = (await unfinished()).find((r) => r.orderId === p.resume)
      if (!resumed) throw new Error(`This agent has no unfinished order ${p.resume}.`)
      mine = resumed
      // Sending a kept order again is answered with where it stands.
      current = await place(mine).catch(async (error: unknown) => {
        // An order Avow refuses, past its expiry, with nothing on the lock, can never be funded.
        const refused = !(error instanceof AvowApiError) || error.definite
        if (refused && mine.expiry < systemClock() && !(await context.held(mine.commitmentId))) {
          await finish(mine.orderId)
        }
        throw error
      })
    } else {
      const sent = await send(p)
      mine = sent.request
      current = sent.order
    }
    p.onStep?.({ step: 'ordered', order: current })
    const end = async (outcome: ServiceBuyOutcome) => {
      await finish(mine.orderId)
      return outcome
    }
    while (current.status === 'requested') {
      await pause(every, p.signal)
      current = await read(mine.orderId)
    }
    if (current.status === 'expired')
      return end({ ok: false, reason: 'order.expired', order: current })
    if (current.status === 'quoted') {
      const funded = await fund(mine, current, p)
      if ('reason' in funded) return end(funded)
      current = funded.order
    }
    return end(await awaitAcceptance(current, every, p))
  }

  /** Checks the quote and funds it, unless the lock already holds it, and tells the mailbox. */
  async function fund(
    mine: ServiceOrderRequest,
    current: Extract<ServiceOrder, { status: 'quoted' }>,
    p: Parameters<SandboxServices['buy']>[0],
  ): Promise<{ order: ServiceOrder } | Extract<ServiceBuyOutcome, { ok: false }>> {
    p.onStep?.({ step: 'quoted', order: current })
    const { quote } = current

    // The buyer's own check, before anything is reserved. The quote has to answer the order this
    // agent kept, for this business, whatever the mailbox's copy of the order now says.
    const buyer = { businessId: business.businessId, mandateHash: current.buyer.mandateHash }
    const changed = serviceQuoteProblem({ ...mine, buyer }, quote, settlement)
    if (changed) return { ok: false, reason: changed, order: current }

    // A reserve already on the lock, from a run that stopped after funding, is reported as it is.
    let fundedIn: Hex | null = null
    if (!(await context.held(mine.commitmentId))) {
      const result = await context.commit({
        supplier: await context.supplierProfile(mine.offer.supplier),
        terms: quote.terms,
        salt: quote.salt,
        agreement: quote.agreement,
        supplierSignature: quote.supplierSignature,
      })
      if (result.ok) {
        fundedIn = result.commitment.reservedIn ?? null
      } else if (!(await context.held(mine.commitmentId))) {
        return { ok: false, reason: result.reason, order: current }
      }
      // Refused with the reserve on the lock means another run of this agent funded it meanwhile.
    }
    await record(mine, quote)
    const reported = await context.reportReserved(
      SANDBOX_PATHS.serviceReserved(mine.orderId),
      fundedIn,
      orderReader,
      p.signal,
    )
    p.onStep?.({ step: 'reserved', fundedIn })
    return { order: reported }
  }

  /** Adds the commitment to the ones this agent made, once, so it's listed with the others. */
  const record = (mine: ServiceOrderRequest, quote: ServiceQuote) =>
    inTurn(store, async () => {
      const reference: CommitmentReference = {
        kind: 'commitment',
        chainId: deployment.chainId,
        lock: business.lock,
        commitmentId: mine.commitmentId,
        side: 'buyer',
        termsHash: quote.agreement.termsHash,
      }
      const made = await loadCommitments(store)
      if (made.some((c) => c.reference.commitmentId === reference.commitmentId)) return
      await addCommitment(store, {
        reference,
        amount: quote.terms.backing.amount,
        supplier: mine.offer.supplier,
        mandateHash: quote.agreement.mandateHash,
        madeAt: systemClock(),
      })
    })

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

  const change = (orderId: string, to: (q: Quoted) => Quoted) =>
    keep((k) => ({ quoted: k.quoted.map((q) => (q.orderId === orderId ? to(q) : q)) }))

  async function sell(sale: ServiceOrder, onStep?: (step: ServiceSellStep) => void): Promise<void> {
    const { asSupplier, signing, supplier } = context.needSupplier()
    if (sale.status === 'requested') {
      // The offer in an order is the buyer's copy, so only a version published here is quoted.
      const version = publishedOffer(sale, await published())
      if (!version) throw new Error("The order is for an offer this business hasn't published.")
      const early = serviceOrderProblem(sale, systemClock())
      if (early) throw new Error(`The order can't be quoted: ${early}`)
      // The mandate in force is read first, so nothing below waits on Avow inside a change.
      const standing = await sellerStanding()
      // The read can take a while, so the order, the mandate and the quote's expiry are all held
      // to the clock as it reads once the mandate is in hand.
      const now = systemClock()
      const problem = serviceOrderProblem(sale, now)
      if (problem) throw new Error(`The order can't be quoted: ${problem}`)
      // The terms this order builds, which the quote signs and the seller's mandate reads.
      const terms = serviceOfferTerms(version, sale.quantity, sale.builtAt, settlement)
      const facts = saleFacts(terms)
      if (!facts) throw new Error("The order's terms aren't a service's.")
      const counts = { units: facts.units, price: facts.price, deliverBy: facts.deliverBy }
      // The terms don't carry the offer's capacity, so the supplier's own agent counts against it,
      // and holds the sale to its seller's mandate. The counts, the check and the place they take
      // are one change, so two orders at once can't share the last place or both pass a limit. An
      // order already quoted is checked again and keeps its place either way.
      const name = version.item.name
      await keep((k) => {
        holdToMandate(k, standing, sale, terms, version, now)
        if (k.quoted.some((q) => q.orderId === sale.orderId)) return {}
        const taken = k.quoted.filter(
          (q) => q.item === name && (q.accepted ? q.at > now - DAY : q.until > now),
        )
        if (taken.length >= version.rules.dailyCapacity) {
          throw new Error(
            "The offer's capacity for the day is taken, so the order is left to lapse.",
          )
        }
        const place: Quoted = {
          orderId: sale.orderId,
          item: name,
          at: now,
          until: sale.builtAt + SERVICE_ACCEPT_WITHIN,
          accepted: false,
          hashes: [],
          sale: counts,
        }
        return { quoted: [...k.quoted, place] }
      })
      const quote = await quoteService({
        order: { ...sale, offer: version },
        buyer: sale.buyer,
        supplier: supplier.profile,
        signingKey: signingRequestKey(signing),
        settlement,
        expiry: now + QUOTE_VALIDITY,
      })
      // The quote signs exactly the terms the mandate read, or it goes nowhere.
      if (JSON.stringify(toWire(quote.terms)) !== JSON.stringify(toWire(terms))) {
        throw new Error("The quote's terms aren't the ones the order builds, so it isn't sent.")
      }
      // Kept before it's sent, so the agent knows every agreement it signed when one comes back.
      const signed = quote.agreement.termsHash.toLowerCase() as Hex
      await change(sale.orderId, (q) => ({ ...q, hashes: [...q.hashes, signed] }))
      await asSupplier({
        domain,
        path: SANDBOX_PATHS.serviceQuote(sale.orderId),
        body: quote,
        read: orderReader,
      })
      onStep?.({ step: 'quoted', standing })
      return
    }
    if (sale.status === 'reserved') {
      // The order comes from the mailbox, so its quote has to be one this agent signed.
      const signed = (await kept()).quoted.find((q) => q.orderId === sale.orderId)
      if (!signed?.hashes.includes(sale.quote.agreement.termsHash.toLowerCase() as Hex)) {
        throw new Error("The order's quote isn't one this agent signed, so it isn't accepted.")
      }
      // The mandate may have changed, ended or been revoked since the quote, so the sale is held to
      // the newest one again before the acceptance binds the seller.
      const standing = await sellerStanding()
      const version = publishedOffer(sale, await published())
      if (standing.inForce) {
        if (!version) {
          throw new Error("The order is for an offer this business hasn't published.")
        }
        holdToMandate(await kept(), standing, sale, sale.quote.terms, version, systemClock())
      }
      // Null when an earlier run's acceptance was already on the lock, which Avow reads either way.
      const acceptedIn = await context.accept(sale.buyer, sale.quote)
      await change(sale.orderId, (q) => ({ ...q, accepted: true }))
      await asSupplier({
        domain,
        path: SANDBOX_PATHS.serviceAccepted(sale.orderId),
        body: { acceptedIn },
        read: orderReader,
      })
      onStep?.({ step: 'accepted', acceptedIn, standing })
    }
  }

  const listen = (p: Parameters<SandboxServices['listen']>[0] = {}) =>
    listenFor<ServiceOrder, ServiceSellStep>({ ...p, inbox, sell })

  return {
    businessId: business.businessId,
    sells,
    publish,
    sellerStanding,
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
