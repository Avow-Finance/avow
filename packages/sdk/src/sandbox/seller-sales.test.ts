import {
  digestOf,
  GPU_RESERVATION,
  JOB_CATEGORY,
  parseQuoteRequest,
  SANDBOX_PATHS,
  type SellerMandate,
  type Signed,
  saleFacts,
  sellerMandateHash,
  sellerMandateTypedData,
  termsAgreementTypedData,
  termsAgreementVersion,
  testnetDemoJobTerms,
  testnetDemoTerms,
  toWire,
} from '@avow-finance/spec'
import { type Address, type Hex, keccak256, recoverAddress, stringToHex } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import { folderWithAgent, json, wire } from '../test/agent-folder.js'
import { deployment, domain, LOCK, supplier } from '../test/sandbox-business.js'
import { memoryStore, write } from './store.js'

// Tempo's verifier is asked whether the business account signed a digest, which for a secp256k1
// root key is whether the signature recovers to the account.
vi.mock('@avow-finance/spec', async (original) => ({
  ...(await original<typeof import('@avow-finance/spec')>()),
  tempoKeychainCheck:
    () =>
    async ({ signer, digest, signature }: { signer: Address; digest: Hex; signature: Hex }) =>
      (await recoverAddress({ hash: digest, signature })).toLowerCase() === signer.toLowerCase(),
}))
// Booking compute goes through the agent, which a test only watches.
const bookings = vi.fn()
vi.mock('./agent.js', async (original) => ({
  ...(await original<typeof import('./agent.js')>()),
  sandboxAgent: async () => ({ bookTerms: bookings }),
}))
vi.mock('../moderato.js', async (original) => ({
  ...(await original<typeof import('../moderato.js')>()),
  moderatoClient: () => ({ readContract: async () => LOCK }),
}))

const { sandboxMailbox } = await import('./mailbox.js')
const { NAMED_MANDATE_CHANGED, SellerMandateRefusal } = await import('./seller-mandate.js')
const { holdJobInTurn, holdJobQuote, releaseJob } = await import('./seller-sales.js')

const id = (word: string): Hex => keccak256(stringToHex(word))
const SELLER = 'sandbox-seller'
const BUYER = 'sandbox-buyer'
const NOW = BigInt(Math.floor(Date.now() / 1000))

/** The demo job, ordered from the seller, due to start a while from now. */
const anOrder = (orderId: string) => {
  const expiry = NOW + 600n
  return {
    orderId,
    commitmentId: id(`commitment-${orderId}`),
    supplierBusinessId: SELLER,
    terms: testnetDemoJobTerms(expiry + 600n, deployment.arbiter),
    requirement: { template: GPU_RESERVATION, condition: 'accepted', disclosed: 'subject' },
    expiry,
  }
}
const PRICE = saleFacts(anOrder('x').terms)?.price ?? 0n

/** The compute the seller already booked for an order, so the test books nothing on a chain. */
const computeFor = (n: number) => ({
  reference: {
    kind: 'commitment',
    chainId: deployment.chainId,
    lock: LOCK.toLowerCase(),
    commitmentId: id(`compute-${n}`),
    side: 'buyer',
    termsHash: id(`compute-terms-${n}`),
  },
  terms: testnetDemoTerms(NOW, deployment.arbiter),
  salt: id(`compute-salt-${n}`),
})

/** A seller's mandate for the demo job at its price or more, up to two a day. */
const mandateFor = (account: Address, signingKey: Address, change: Partial<SellerMandate> = {}) =>
  ({
    mandateId: id('seller-mandate-1'),
    businessId: SELLER,
    account: account.toLowerCase() as Address,
    signingKey: signingKey.toLowerCase() as Address,
    currency: 'USD',
    limits: [
      {
        category: JOB_CATEGORY,
        item: 'fine-tuning',
        minUnitPrice: PRICE,
        maxUnitsPerOrder: 1,
        maxUnitsPerDay: 2,
      },
    ],
    maxOrderValue: PRICE * 10n,
    maxOutstanding: PRICE * 10n,
    maxDeliveryHorizon: 365n * 86_400n,
    minLateCancellationBps: 0,
    minNoShowBps: 0,
    maxFreeCancelWindow: 86_400n,
    buyers: [],
    excludedBuyers: [],
    excludedCountries: [],
    requiresBusinessCheck: false,
    negotiable: [],
    approvalRule: { kind: 'never' },
    expiry: 1_900_000_000n,
    nonce: 1n,
    replaces: null,
    ...change,
  }) as SellerMandate

/**
 * A selling agent's folder with the compute booked for each order, and Avow answering it: the
 * orders in its inbox, the seller's mandate it serves or none, and a record of what was sent.
 */
async function sellingJobs(
  orderIds: string[],
  change?: Partial<SellerMandate> | null,
  o: { booked?: boolean } = {},
) {
  const { store, root } = await folderWithAgent(SELLER, {
    sells: true,
    suppliers: [SELLER, supplier.id],
    categories: [JOB_CATEGORY, 'compute'],
  })
  const kept = JSON.parse((await store.read('supplier')) ?? '{}') as {
    profile: { signingKey: Address }
  }
  const signingKey = kept.profile.signingKey
  const orders = orderIds.map(anOrder)
  const sales = Object.fromEntries(orders.map((o, i) => [o.orderId, { compute: computeFor(i) }]))
  if (o.booked !== false) await write(store, 'mailbox', { sales })
  const mandate = change === null ? null : mandateFor(root.address, signingKey, change)
  const servedFor = async (mandate: SellerMandate | null) =>
    mandate
      ? toWire({
          current: {
            type: 'SellerMandate',
            schemaVersion: '1',
            chainId: deployment.chainId,
            lock: LOCK.toLowerCase(),
            message: mandate,
            signature: await root.sign({ hash: digestOf(sellerMandateTypedData(mandate, domain)) }),
          } as Signed<SellerMandate>,
          earlier: [],
          revocation: null,
        })
      : null
  let served = await servedFor(mandate)
  /** Serves a mandate with these changes in place of the first, as an administrator's new one. */
  const serve = async (next: Partial<SellerMandate>) => {
    served = await servedFor(mandateFor(root.address, signingKey, { ...change, ...next }))
  }
  const posted: { path: string; body: Record<string, unknown> }[] = []
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    if (path === '/config.json') return json(wire(deployment))
    const body = init?.body ? JSON.parse(new TextDecoder().decode(init.body as Uint8Array)) : {}
    posted.push({ path, body })
    if (path === SANDBOX_PATHS.sellerMandates) {
      return served
        ? json(JSON.parse(JSON.stringify(served)))
        : json({ error: { reason: 'request.invalid', message: 'No such route' } }, 404)
    }
    const held = orders.map((o) => ({
      ...wire(o),
      buyer: {
        businessId: BUYER,
        account: LOCK,
        lock: LOCK,
        chainId: deployment.chainId,
        mandateHash: `0x${'cd'.repeat(32)}`,
      },
      requestedAt: NOW.toString(),
      status: 'requested',
    }))
    if (path === SANDBOX_PATHS.mailboxInbox) return json({ orders: held })
    return json(held.find((o) => path.includes(o.orderId)) ?? held[0])
  }) as typeof globalThis.fetch
  const mailbox = await sandboxMailbox({ store, fetch })
  const quoted = (orderId: string) => {
    const sent = posted.find((p) => p.path === SANDBOX_PATHS.mailboxQuote(orderId))
    return sent ? parseQuoteRequest(sent.body) : null
  }
  return { mailbox, mandate, signingKey, quoted, store, posted, serve }
}

describe('a job sold through the mailbox', () => {
  it('names no seller’s mandate when none is in force, and signs at version 1', async () => {
    const { mailbox, quoted } = await sellingJobs(['a1'.repeat(16)], null)
    const [order] = await mailbox.inbox()
    if (!order) throw new Error('the inbox read no order')
    const steps: unknown[] = []
    await mailbox.sell(order, (s) => steps.push(s))
    const quote = quoted(order.orderId)
    if (!quote?.ok) throw new Error('the seller quoted the order')
    expect(quote.value.agreement).not.toHaveProperty('sellerMandate')
    expect(termsAgreementVersion(quote.value.agreement)).toBe('1')
    expect(steps).toContainEqual({
      step: 'quoted',
      standing: expect.objectContaining({ inForce: false }),
    })
  })

  it('names the mandate it held the job to, which its signing key signs at version 2', async () => {
    const { mailbox, mandate, signingKey, quoted } = await sellingJobs(['a2'.repeat(16)])
    if (!mandate) throw new Error('a mandate is served')
    const [order] = await mailbox.inbox()
    if (!order) throw new Error('the inbox read no order')
    await mailbox.sell(order)
    const quote = quoted(order.orderId)
    if (!quote?.ok) throw new Error('the seller quoted the order')
    expect(quote.value.agreement.sellerMandate).toBe(sellerMandateHash(mandate, domain))
    expect(termsAgreementVersion(quote.value.agreement)).toBe('2')
    const who = await recoverAddress({
      hash: digestOf(
        termsAgreementTypedData(quote.value.agreement, {
          chainId: deployment.chainId,
          verifyingContract: LOCK,
        }),
      ),
      signature: quote.value.supplierSignature,
    })
    expect(who.toLowerCase()).toBe(signingKey.toLowerCase())
  })

  it('refuses a job under the mandate’s price floor, and sends no quote', async () => {
    const { mailbox, quoted } = await sellingJobs(['a3'.repeat(16)], {
      limits: [
        {
          category: JOB_CATEGORY,
          item: 'fine-tuning',
          minUnitPrice: PRICE + 1n,
          maxUnitsPerOrder: 1,
          maxUnitsPerDay: 2,
        },
      ],
    })
    const [order] = await mailbox.inbox()
    if (!order) throw new Error('the inbox read no order')
    const sold = mailbox.sell(order)
    await expect(sold).rejects.toBeInstanceOf(SellerMandateRefusal)
    await expect(sold).rejects.toMatchObject({ reason: 'seller_mandate.under_price_floor' })
    expect(quoted(order.orderId)).toBeNull()
  })

  it('counts the services it sold toward what it may have outstanding for a job', async () => {
    const { mailbox, quoted, store } = await sellingJobs(['c1'.repeat(16)], {
      maxOutstanding: PRICE + 1n,
      maxOrderValue: PRICE + 1n,
    })
    // A service accepted an hour ago and due tomorrow, which the same mandate counts.
    await store.write(
      'services',
      JSON.stringify({
        quoted: [
          {
            orderId: 'dd'.repeat(16),
            item: 'Transcript',
            at: String(NOW - 3600n),
            until: String(NOW - 3000n),
            accepted: true,
            hashes: [],
            sale: { units: 1, price: '2', deliverBy: String(NOW + 86_400n) },
          },
        ],
      }),
    )
    const [order] = await mailbox.inbox()
    if (!order) throw new Error('the inbox read no order')
    await expect(mailbox.sell(order)).rejects.toMatchObject({
      reason: 'seller_mandate.over_outstanding',
    })
    expect(quoted(order.orderId)).toBeNull()
  })

  it('doesn’t accept a job whose agreement names a mandate replaced since the quote', async () => {
    const { mailbox, quoted, posted, serve } = await sellingJobs(['c2'.repeat(16)])
    const [order] = await mailbox.inbox()
    if (!order) throw new Error('the inbox read no order')
    await mailbox.sell(order)
    const quote = quoted(order.orderId)
    if (!quote?.ok) throw new Error('the seller quoted the order')
    await serve({ mandateId: id('seller-mandate-2') })
    const reserved = {
      ...order,
      status: 'reserved',
      quote: quote.value,
      reserve: { fundedIn: null, amount: 1n, acceptBy: NOW + 900n },
    } as unknown as typeof order
    await expect(mailbox.sell(reserved)).rejects.toThrow(NAMED_MANDATE_CHANGED)
    expect(posted.some((p) => p.path === SANDBOX_PATHS.mailboxAccepted(order.orderId))).toBe(false)
  })

  it('refuses a job the mandate doesn’t allow before it books any compute for it', async () => {
    bookings.mockReset()
    const { mailbox, quoted } = await sellingJobs(
      ['e1'.repeat(16)],
      {
        limits: [
          {
            category: JOB_CATEGORY,
            item: 'fine-tuning',
            minUnitPrice: PRICE + 1n,
            maxUnitsPerOrder: 1,
            maxUnitsPerDay: 2,
          },
        ],
      },
      { booked: false },
    )
    const [order] = await mailbox.inbox()
    if (!order) throw new Error('the inbox read no order')
    await expect(mailbox.sell(order)).rejects.toMatchObject({
      reason: 'seller_mandate.under_price_floor',
    })
    expect(bookings).not.toHaveBeenCalled()
    expect(quoted(order.orderId)).toBeNull()
  })

  it('goes on to book compute for a job the mandate allows', async () => {
    bookings.mockReset()
    const { mailbox } = await sellingJobs(['e2'.repeat(16)], undefined, { booked: false })
    const [order] = await mailbox.inbox()
    if (!order) throw new Error('the inbox read no order')
    // The check before booking passes, and the test serves no compute offers to book from.
    await expect(mailbox.sell(order)).rejects.toThrow('The compute supplier listed no offers')
  })

  it('counts the jobs it quoted today, and refuses one past the day’s units', async () => {
    const ids = ['b1', 'b2', 'b3'].map((p) => p.repeat(16))
    const { mailbox, quoted } = await sellingJobs(ids)
    const orders = await mailbox.inbox()
    for (const order of orders.slice(0, 2)) {
      await mailbox.sell(order)
      expect(quoted(order.orderId)?.ok).toBe(true)
    }
    const [, , past] = orders
    if (!past) throw new Error('three orders')
    await expect(mailbox.sell(past)).rejects.toMatchObject({
      reason: 'seller_mandate.over_daily_units',
    })
    expect(quoted(past.orderId)).toBeNull()
    // Quoting the same order again keeps its one place.
    const [first] = orders
    if (!first) throw new Error('three orders')
    await expect(mailbox.sell(first)).resolves.toBeUndefined()
  })
})

describe("a job's place in its offer's capacity", () => {
  const none = { inForce: false as const, notice: 'No seller mandate is in force.' }
  const DAY = 86_400n
  /** A job held to its place, accepted by `acceptBy`, which the demo job starts at. */
  const held = (orderId: string, acceptBy = NOW + 1_200n) => ({
    orderId,
    terms: testnetDemoJobTerms(acceptBy, deployment.arbiter),
    offer: null,
    buyer: BUYER,
    signingKey: `0x${'11'.repeat(20)}` as Address,
  })

  it('is taken before compute is booked, so a second job finds the last place gone', async () => {
    const store = memoryStore()
    await holdJobInTurn(store, none, held('first'), 1, NOW)
    await expect(holdJobInTurn(store, none, held('second'), 1, NOW)).rejects.toThrow(
      /capacity for the day is taken/,
    )
    // The job that took the place keeps it through its quote.
    await expect(holdJobQuote(store, none, held('first'), NOW, 1)).resolves.toBeNull()
  })

  it('is given back when the compute behind it is never booked', async () => {
    const store = memoryStore()
    await holdJobInTurn(store, none, held('first'), 1, NOW)
    await releaseJob(store, 'first', NOW)
    await expect(holdJobInTurn(store, none, held('second'), 1, NOW)).resolves.toBeUndefined()
  })

  it('stays taken by a quote until its acceptance deadline, however far ahead the job starts', async () => {
    const store = memoryStore()
    const acceptBy = NOW + 3n * DAY
    expect(held('first', acceptBy).terms.remedies.acceptBy).toBe(acceptBy)
    await holdJobQuote(store, none, held('first', acceptBy), NOW, 1)
    // Two days on, the quote is older than a day and can still be accepted, so it holds its place.
    const later = NOW + 2n * DAY
    await expect(holdJobInTurn(store, none, held('second', later + DAY), 1, later)).rejects.toThrow(
      /capacity/,
    )
    // Past its deadline it holds nothing.
    const after = acceptBy + 1n
    await expect(
      holdJobInTurn(store, none, held('third', after + DAY), 1, after),
    ).resolves.toBeUndefined()
  })
})
