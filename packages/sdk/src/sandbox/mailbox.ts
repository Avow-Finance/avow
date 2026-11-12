import {
  type ComputeOffer,
  computeOffersPath,
  computeOfferTerms,
  DEMO_JOB_TIMING,
  GPU_RESERVATION,
  isChainedTerms,
  isFirmOffer,
  type MailboxOrder,
  type MailboxOrderRequest,
  offerTakes,
  parseComputeOffers,
  parseMailboxInbox,
  parseMailboxOrder,
  parseSupplierProfile,
  quoteTermsProblem,
  type ReasonCode,
  SANDBOX_PATHS,
  type SandboxDeployment,
  type SupplierProfile,
  TESTNET_DEMO_PROFILE,
  testnetDemoJobTerms,
} from '@avow-finance/spec'
import { readBacking, tempoChainReader, tempoLockReader } from '@avow-finance/verifier'
import { type Address, type Hex, parseAbi, toHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { Account } from 'viem/tempo'
import { type AgentKey, createAgent } from '../agent.js'
import {
  agentRequestKey,
  avowRequests,
  httpAvowApi,
  requestSupplierAuthorization,
  signingRequestKey,
} from '../http.js'
import { acceptJob } from '../job/accept.js'
import { quoteJob } from '../job/quote.js'
import { moderatoClient, moderatoUsdToken } from '../moderato.js'
import { sendOwn, sendSponsored } from '../send.js'
import { platformStore, sandboxAgent } from './agent.js'
import { fundFees } from './business.js'
import { pause } from './connect.js'
import { loadSandboxDeployment } from './deployment.js'
import { SANDBOX_SCREEN_URL } from './session.js'
import { type AgentItem, loadAgentItem, readJson, type SandboxStore, write } from './store.js'
import { loadSupplierItem } from './supplier-key.js'

/**
 * The sandbox mailbox from an agent's side. A buyer's agent orders a job from another business,
 * checks the quote that comes back and funds it. A supplier's agent reads its inbox, books the
 * compute the job relies on, quotes, and accepts once the buyer has funded. Avow keeps every order,
 * so an agent that stops part way picks up where it was, and each step it repeats is answered the
 * same, so it never makes a second commitment.
 */

const APPROVAL_KEY_ABI = parseAbi(['function approvalKey() view returns (address)'])
const systemClock = () => BigInt(Math.floor(Date.now() / 1000))
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
export type SellStep =
  | { step: 'compute'; reservedIn: Hex | null }
  | { step: 'quoted' }
  | { step: 'accepted'; acceptedIn: Hex | null }

export interface MailboxOptions {
  store?: SandboxStore
  screenUrl?: string
  fetch?: typeof fetch
}

/** A supplier's progress on one order, kept so a restart never books its compute twice. */
interface SaleRecord {
  compute: { lock: Address; commitmentId: Hex; terms: unknown; salt: Hex; termsHash: Hex } | null
}

export interface SandboxMailbox {
  readonly businessId: string
  /** Sends an order for the demo job to another business, with nothing reserved. */
  order(o: { supplier: string; expiresIn?: bigint }): Promise<MailboxOrder>
  /** Reads one order, as either side. */
  read(orderId: string): Promise<MailboxOrder>
  /**
   * Orders a job and sees it through: waits for the quote, checks it, funds the commitment, tells
   * the mailbox, and waits for the supplier to accept. An order nobody quotes lapses unfunded.
   */
  buy(o: {
    supplier: string
    expiresIn?: bigint
    onStep?: (step: BuyStep) => void
    pollEvery?: number
    signal?: AbortSignal
  }): Promise<BuyOutcome>
  /** The orders waiting on this business as supplier: new ones to quote, funded ones to accept. */
  inbox(): Promise<MailboxOrder[]>
  /** Takes the next step on one order from the inbox: quotes a new one, or accepts a funded one. */
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
  const send = o.fetch ?? ((input, init) => fetch(input, init))
  const maybeStore = o.store ?? platformStore()
  if (!maybeStore) throw new Error('Pass a store, outside Node.')
  const store: SandboxStore = maybeStore
  const found = await loadAgentItem(store)
  if (!found) throw new Error('This folder has no agent. Run avow-sandbox connect first.')
  const item: AgentItem = found
  const deployment: SandboxDeployment = await loadSandboxDeployment(
    o.screenUrl ?? SANDBOX_SCREEN_URL,
    send,
  )
  const client = moderatoClient(deployment.rpcUrl)
  const { business } = item
  const agentKey: AgentKey = Account.fromSecp256k1(item.agentKey, { access: business.account })
  const domain = { chainId: deployment.chainId, verifyingContract: business.lock }
  const lockReader = tempoLockReader(client, {
    factory: deployment.factory,
    chainId: deployment.chainId,
  })
  const asAgent = avowRequests({
    baseUrl: deployment.apiUrl,
    key: agentRequestKey(agentKey),
    retryFor: 120n,
    fetch: send,
  })
  const orderReader = (json: unknown) => {
    const order = parseMailboxOrder(json)
    return order
      ? { ok: true as const, value: order }
      : { ok: false as const, reason: 'message.invalid' as const }
  }

  async function supplierProfile(businessId: string): Promise<SupplierProfile> {
    const answer = await send(`${deployment.apiUrl}${SANDBOX_PATHS.supplier(businessId)}`, {
      signal: AbortSignal.timeout(15_000),
    })
    const profile = parseSupplierProfile(await answer.json().catch(() => null))
    if (!answer.ok || !profile.ok) throw new Error(`Avow has no sandbox supplier ${businessId}`)
    return profile.value
  }

  // The buyer's side.

  async function order(p: { supplier: string; expiresIn?: bigint }): Promise<MailboxOrder> {
    const expiry = systemClock() + (p.expiresIn ?? MAILBOX_ORDER_SECONDS)
    const request: MailboxOrderRequest = {
      orderId: random(16).slice(2),
      commitmentId: random(32),
      supplierBusinessId: p.supplier,
      terms: testnetDemoJobTerms(expiry + DEMO_JOB_TIMING.accept, deployment.arbiter),
      requirement: { template: GPU_RESERVATION, condition: 'accepted', disclosed: 'subject' },
      expiry,
    }
    return asAgent({ domain, path: SANDBOX_PATHS.mailboxOrders, body: request, read: orderReader })
  }

  const read = (orderId: string) =>
    asAgent({ domain, path: SANDBOX_PATHS.mailboxOrder(orderId), body: {}, read: orderReader })

  async function buy(p: Parameters<SandboxMailbox['buy']>[0]): Promise<BuyOutcome> {
    const every = p.pollEvery ?? 3000
    let current = await order(p)
    p.onStep?.({ step: 'ordered', order: current })
    while (current.status === 'requested') {
      await pause(every, p.signal)
      current = await read(current.orderId)
    }
    if (current.status === 'expired') return { ok: false, reason: 'order.expired', order: current }
    if (current.status !== 'quoted') return { ok: false, reason: 'message.invalid', order: current }
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
    const held = await readBacking(client, business.lock, current.commitmentId, 'buyer')
    if (!held) {
      const avow = httpAvowApi({
        baseUrl: deployment.apiUrl,
        key: agentRequestKey(agentKey),
        domain,
        retryFor: 120n,
        fetch: send,
      })
      const buyer = createAgent({
        client,
        key: agentKey,
        mandate: item.mandate,
        token: moderatoUsdToken(deployment.token),
        profile: TESTNET_DEMO_PROFILE,
        avow,
        send: async (calls) => {
          const receipt = await sendSponsored({
            client,
            account: agentKey,
            calls,
            sponsor: (transaction) => avow.sponsor(transaction),
          })
          return { transactionHash: receipt.transactionHash, blockNumber: receipt.blockNumber }
        },
        dependencies: { readers: [lockReader] },
      })
      const result = await buyer.commitToQuote({
        supplier: await supplierProfile(current.supplierBusinessId),
        terms: quote.terms,
        salt: quote.salt,
        agreement: quote.agreement,
        supplierSignature: quote.supplierSignature,
        disclosed: quote.disclosed,
      })
      if (!result.ok) return { ok: false, reason: result.reason, order: current }
      fundedIn = result.commitment.reservedIn ?? null
    }
    current = await asAgent({
      domain,
      path: SANDBOX_PATHS.mailboxReserved(current.orderId),
      body: { fundedIn },
      read: orderReader,
    })
    p.onStep?.({ step: 'reserved', fundedIn })

    // The supplier accepts under the lock's rules. Past its deadline the reserve goes back.
    const acceptBy = current.status === 'reserved' ? current.reserve.acceptBy : 0n
    while (current.status === 'reserved') {
      if (systemClock() > acceptBy)
        return { ok: false, reason: 'acceptance.missed', order: current }
      await pause(every, p.signal)
      current = await read(current.orderId)
    }
    if (current.status !== 'accepted')
      return { ok: false, reason: 'message.invalid', order: current }
    p.onStep?.({ step: 'accepted', acceptedIn: current.acceptedIn })
    return { ok: true, order: current }
  }

  // The supplier's side.

  const supplierItem = await loadSupplierItem(store)
  const signing = supplierItem ? privateKeyToAccount(supplierItem.signingKey) : null
  const asSupplier = signing
    ? avowRequests({
        baseUrl: deployment.apiUrl,
        key: signingRequestKey(signing),
        retryFor: 120n,
        fetch: send,
      })
    : null
  const needSupplier = () => {
    if (!asSupplier || !signing || !supplierItem) {
      throw new Error('This agent has no signing key to sell with. Connect it with --sell.')
    }
    return { asSupplier, signing, supplier: supplierItem }
  }

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

  async function sales(): Promise<Record<string, SaleRecord>> {
    const text = await store.read('mailbox')
    return text ? (readJson(text, 'mailbox') as Record<string, SaleRecord>) : {}
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

  async function sell(job: MailboxOrder, onStep?: (step: SellStep) => void): Promise<void> {
    const { asSupplier, signing, supplier } = needSupplier()
    if (job.status === 'requested') {
      const records = await sales()
      let compute = records[job.orderId]?.compute ?? null
      if (!compute) {
        const agent = await sandboxAgent({
          store,
          deployment,
          session: null,
          log: () => {},
          fetch: send,
        })
        const { offer, gpus } = await computeFor(job)
        const booked = await agent.bookTerms({
          supplier: offer.supplier,
          terms: computeOfferTerms(offer, gpus, deployment),
        })
        if (!(await booked.accepted())) throw new Error('The compute supplier never accepted')
        compute = {
          lock: business.lock,
          commitmentId: booked.commitment.commitmentId,
          terms: booked.commitment.terms,
          salt: booked.commitment.salt,
          termsHash: booked.commitment.termsHash,
        }
        await write(store, 'mailbox', { ...records, [job.orderId]: { compute } })
        onStep?.({ step: 'compute', reservedIn: booked.commitment.reservedIn })
      }
      const quote = await quoteJob({
        offer: job,
        customer: job.buyer,
        supplier: supplier.profile,
        signingKey: signingRequestKey(signing),
        compute: {
          reference: {
            kind: 'commitment',
            chainId: deployment.chainId,
            lock: compute.lock,
            commitmentId: compute.commitmentId,
            side: 'buyer',
            termsHash: compute.termsHash,
          },
          terms: compute.terms as never,
          salt: compute.salt,
        },
        expiry: systemClock() + QUOTE_VALIDITY,
      })
      await asSupplier({
        domain,
        path: SANDBOX_PATHS.mailboxQuote(job.orderId),
        body: quote,
        read: orderReader,
      })
      onStep?.({ step: 'quoted' })
      return
    }
    if (job.status === 'reserved') {
      const approvalKey = await client.readContract({
        address: job.buyer.lock,
        abi: APPROVAL_KEY_ABI,
        functionName: 'approvalKey',
      })
      await fundFees(client, signing.address)
      const sender = Account.fromSecp256k1(supplier.signingKey)
      const accepted = await acceptJob(
        {
          config: {
            chainId: deployment.chainId,
            avowKeys: [approvalKey as Address],
            businessId: supplier.profile.businessId,
            payee: supplier.profile.payee,
            acceptedTokens: [moderatoUsdToken(deployment.token)],
            profile: TESTNET_DEMO_PROFILE,
            acceptTestData: true,
            account: supplier.profile.account,
            signingKey: supplier.profile.signingKey,
          },
          chain: tempoChainReader(client, {
            factory: deployment.factory,
            chainId: deployment.chainId,
          }),
          dependencies: { readers: [lockReader] },
          authorize: (commitment) =>
            requestSupplierAuthorization(
              { baseUrl: deployment.apiUrl, key: signingRequestKey(signing), fetch: send },
              commitment,
            ),
          signingKey: signing,
          send: async (call) => {
            const receipt = await sendOwn({ client, account: sender, calls: [call] })
            return { transactionHash: receipt.transactionHash, blockNumber: receipt.blockNumber }
          },
          now: systemClock,
        },
        { customer: job.buyer, quote: job.quote },
      )
      if (!accepted.ok) throw new Error(`The acceptance was refused: ${accepted.code}`)
      // Null when an earlier run's acceptance was already on the lock, which Avow reads either way.
      const acceptedIn = accepted.sent?.landed.transactionHash ?? null
      await asSupplier({
        domain,
        path: SANDBOX_PATHS.mailboxAccepted(job.orderId),
        body: { acceptedIn },
        read: orderReader,
      })
      onStep?.({ step: 'accepted', acceptedIn })
    }
  }

  async function listen(p: Parameters<SandboxMailbox['listen']>[0] = {}): Promise<void> {
    for (;;) {
      if (p.signal?.aborted) return
      const orders = await inbox().catch(() => [])
      for (const job of orders) {
        if (job.status === 'requested' && p.accept && !(await p.accept(job))) continue
        await sell(job, (step) => p.onStep?.(job, step)).catch((error: unknown) =>
          p.onError?.(job, error),
        )
      }
      await pause(p.every ?? 5000, p.signal).catch(() => {})
    }
  }

  return { businessId: business.businessId, order, read, buy, inbox, sell, listen }
}
