import {
  digestOf,
  dollars,
  encodeApiBody,
  parseApprovalAsk,
  parseServiceQuote,
  SANDBOX_PATHS,
  SERVICE_CATEGORY,
  type SellerMandate,
  type ServiceOfferVersion,
  type ServiceQuote,
  type Signed,
  sellerKeyRevocationTypedData,
  sellerMandateHash,
  sellerMandateTermsOf,
  sellerMandateTypedData,
  termsAgreementTypedData,
  termsAgreementVersion,
  toWire,
} from '@avow-finance/spec'
import { type Address, type Hex, keccak256, recoverAddress, stringToHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it, vi } from 'vitest'
import { folderWithAgent, json } from '../test/agent-folder.js'
import { deployment, domain, LOCK } from '../test/sandbox-business.js'

// Tempo's verifier is asked whether the business account signed a digest, which for a secp256k1
// root key is whether the signature recovers to the account.
vi.mock('@avow-finance/spec', async (original) => ({
  ...(await original<typeof import('@avow-finance/spec')>()),
  tempoKeychainCheck:
    () =>
    async ({ signer, digest, signature }: { signer: Address; digest: Hex; signature: Hex }) =>
      (await recoverAddress({ hash: digest, signature })).toLowerCase() === signer.toLowerCase(),
}))
vi.mock('../moderato.js', async (original) => ({
  ...(await original<typeof import('../moderato.js')>()),
  moderatoClient: () => ({ readContract: async () => LOCK }),
}))

const { sandboxServices } = await import('./services.js')
const { holdToNamedMandate, NAMED_MANDATE_CHANGED, NO_SELLER_MANDATE, SellerMandateRefusal } =
  await import('./seller-mandate.js')
const { readSellerStanding, SELLER_STANDING_RETRY_FOR } = await import('./seller-mandate-read.js')
const { SELLER_MANDATE_ASKS_UNTAKEN } = await import('./services.js')

/** A 32-byte id made from a word. */
const id = (word: string): Hex => keccak256(stringToHex(word))

const SELLER = 'sandbox-seller'
const BUYER = 'sandbox-buyer'
const HOUR = 3600n

/** Transcription by the hour of audio, at $50 a unit, as its supplier writes it. */
const draft = {
  item: { name: 'Transcript', summary: 'One hour of audio transcribed into English text' },
  currency: 'USD',
  unitPrice: dollars(50),
  rules: {
    evidence: 'The transcript is delivered to the buyer as a text file',
    leadTime: 24n * HOUR,
    maxPerBooking: 4,
    dailyCapacity: 20,
    freeCancelWindow: 2n * HOUR,
    lateCancellationBps: 2_000,
    noShowBps: 5_000,
    payment: { route: 'transfer', dueAfterDelivery: 7n * 24n * HOUR },
  },
} as const

/** A selling agent's folder, with the root key of its business and its own signing key. */
async function seller() {
  const { store, root } = await folderWithAgent(SELLER, {
    sells: true,
    suppliers: [SELLER],
    categories: [SERVICE_CATEGORY],
  })
  const kept = JSON.parse((await store.read('supplier')) ?? '{}') as {
    profile: { signingKey: Address }
  }
  return { store, root, signingKey: kept.profile.signingKey }
}

/** A seller's mandate for services at $40 or more a unit, up to 4 a booking and 10 a day. */
const mandateFor = (account: Address, signingKey: Address, change: Partial<SellerMandate> = {}) =>
  ({
    mandateId: id('seller-mandate-1'),
    businessId: SELLER,
    account: account.toLowerCase() as Address,
    signingKey: signingKey.toLowerCase() as Address,
    currency: 'USD',
    limits: [
      {
        category: 'service',
        item: null,
        minUnitPrice: dollars(40),
        maxUnitsPerOrder: 4,
        maxUnitsPerDay: 10,
      },
    ],
    maxOrderValue: dollars(500),
    maxOutstanding: dollars(2000),
    maxDeliveryHorizon: 7n * 86_400n,
    minLateCancellationBps: 2000,
    minNoShowBps: 5000,
    maxFreeCancelWindow: 86_400n,
    buyers: [],
    excludedBuyers: ['sandbox-blocked'],
    excludedCountries: [],
    requiresBusinessCheck: false,
    negotiable: [],
    approvalRule: { kind: 'never' },
    expiry: 1_900_000_000n,
    nonce: 1n,
    replaces: null,
    ...change,
  }) as SellerMandate

type Root = Awaited<ReturnType<typeof seller>>['root']
const envelope = <T>(type: Signed<T>['type'], message: T, signature: Hex): Signed<T> =>
  ({
    type,
    schemaVersion: '1',
    chainId: deployment.chainId,
    lock: LOCK.toLowerCase(),
    message,
    signature,
  }) as Signed<T>
const signed = async (m: SellerMandate, by: Root) =>
  envelope('SellerMandate', m, await by.sign({ hash: digestOf(sellerMandateTypedData(m, domain)) }))

/**
 * Avow's API as far as a test needs it: the deployment, the seller's mandates it serves, and an
 * answer to everything else a seller sends, which records what was sent.
 */
function avow(
  mandates: (() => Promise<unknown>) | null,
  respond?: (init?: RequestInit) => Promise<Response>,
  others?: (path: string, body: Record<string, unknown>) => Response | null,
) {
  const posted: { path: string; body: Record<string, unknown>; raw: string }[] = []
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    if (path === '/config.json') return json(JSON.parse(JSON.stringify(toWire(deployment))))
    const raw = init?.body ? new TextDecoder().decode(init.body as Uint8Array) : ''
    const body = raw ? JSON.parse(raw) : {}
    posted.push({ path, body, raw })
    if (path === SANDBOX_PATHS.sellerMandates) {
      if (respond) return respond(init)
      return mandates
        ? json(await mandates())
        : json({ error: { reason: 'request.invalid', message: 'No such route' } }, 404)
    }
    return (
      others?.(path, body) ??
      json({ error: { reason: 'request.invalid', message: 'No such route' } }, 404)
    )
  }) as typeof globalThis.fetch
  return { fetch, posted }
}

/** An order for units of an offer, as the mailbox hands it to the seller. */
const orderFor = (version: ServiceOfferVersion, quantity: number, buyer = BUYER) => {
  const builtAt = BigInt(Math.floor(Date.now() / 1000))
  return {
    orderId: id(`order-${quantity}-${buyer}`).slice(2, 34),
    commitmentId: id(`commitment-${quantity}-${buyer}`),
    offer: version,
    quantity,
    builtAt,
    expiry: builtAt + 600n,
    buyer: {
      businessId: buyer,
      account: LOCK,
      lock: LOCK,
      chainId: deployment.chainId,
      mandateHash: `0x${'cd'.repeat(32)}` as Hex,
    },
    requestedAt: builtAt,
    status: 'requested',
  } as const
}

const quoted = (posted: { path: string; body: Record<string, unknown> }[], orderId: string) =>
  parseServiceQuote(posted.find((p) => p.path === SANDBOX_PATHS.serviceQuote(orderId))?.body)

describe('a selling agent with no seller’s mandate', () => {
  it('says plainly that none is in force and Avow enforces no seller limits, and sells as before', async () => {
    const { store } = await seller()
    const { fetch, posted } = avow(null)
    const services = await sandboxServices({ store, fetch })
    const standing = await services.sellerStanding()
    expect(standing).toEqual({ inForce: false, notice: NO_SELLER_MANDATE })
    expect(NO_SELLER_MANDATE).toMatch(/Avow doesn't enforce seller limits yet/)
    expect(NO_SELLER_MANDATE).not.toMatch(/Avow (enforces|holds)/)
    // An offer no mandate would allow, at $1 a unit, is published as it was before.
    const { version, standing: said } = await services.publish({ ...draft, unitPrice: dollars(1) })
    expect(said).toEqual(standing)
    const steps: unknown[] = []
    const order = orderFor(version, 4)
    await services.sell(order, (s) => steps.push(s)).catch(() => {})
    const quote = quoted(posted, order.orderId)
    if (!quote) throw new Error('the seller quoted the order')
    // With no mandate in force the agreement names none, and signs at version 1 as before.
    expect(quote.agreement).not.toHaveProperty('sellerMandate')
    expect(termsAgreementVersion(quote.agreement)).toBe('1')
    // The read is signed by the agent's signing key, under its business's lock.
    expect(posted.some((p) => p.path === SANDBOX_PATHS.sellerMandates)).toBe(true)
  })

  it('asks nothing of a buyer-only agent, which has no signing key to sell with', async () => {
    const { store } = await folderWithAgent(BUYER, {
      suppliers: [SELLER],
      categories: [SERVICE_CATEGORY],
    })
    const { fetch, posted } = avow(null)
    const services = await sandboxServices({ store, fetch })
    expect((await services.publish(draft)).standing).toBeNull()
    expect(services.signingKey).toBeNull()
    expect(posted.some((p) => p.path === SANDBOX_PATHS.sellerMandates)).toBe(false)
  })

  it('gives the address of the signing key it sells with, which a mandate it asks for names', async () => {
    const { store, signingKey } = await seller()
    const services = await sandboxServices({ store, fetch: avow(null).fetch })
    expect(services.signingKey?.toLowerCase()).toBe(signingKey.toLowerCase())
  })
})

describe('a selling agent under a seller’s mandate', () => {
  async function under(change: Partial<SellerMandate> = {}) {
    const s = await seller()
    const mandate = mandateFor(s.root.address, s.signingKey, change)
    let current: SellerMandate | null = mandate
    const api = avow(null, async () =>
      current
        ? json(toWire({ current: await signed(current, s.root), earlier: [], revocation: null }))
        : json({ error: { reason: 'seller_mandate.missing', message: 'No mandate' } }, 404),
    )
    const services = await sandboxServices({ store: s.store, fetch: api.fetch })
    /** Serves a mandate with these changes in place of the first, as an administrator's new one. */
    const changeTo = (next: Partial<SellerMandate>) => {
      current = mandateFor(s.root.address, s.signingKey, { ...change, ...next })
    }
    /** Serves no mandate, as once the one in force has ended and Avow holds none for the key. */
    const end = () => {
      current = null
    }
    return { ...s, mandate, services, changeTo, end, ...api }
  }

  it('reads its newest mandate as one chain the business account signed, and says it holds itself to it', async () => {
    const { services, mandate } = await under()
    const standing = await services.sellerStanding()
    if (!standing.inForce) throw new Error('a mandate is in force')
    const hash = sellerMandateHash(mandate, domain)
    expect(standing.chain.current.hash).toBe(hash)
    expect(standing.notice).toContain(hash)
    expect(standing.notice).toMatch(/its own SDK holds it to/)
    expect(standing.notice).toMatch(/Avow doesn't enforce seller limits yet/)
  })

  it('publishes an offer the mandate allows, and refuses one under its price floor', async () => {
    const { services } = await under()
    await expect(services.publish(draft)).resolves.toMatchObject({ standing: { inForce: true } })
    const cheap = services.publish({ ...draft, unitPrice: dollars(10) })
    await expect(cheap).rejects.toBeInstanceOf(SellerMandateRefusal)
    await expect(cheap).rejects.toMatchObject({ reason: 'seller_mandate.under_price_floor' })
    expect((await services.published()).map((v) => v.unitPrice)).toEqual([dollars(50)])
  })

  it('refuses an offer whose largest booking goes past the units one order may take', async () => {
    const { services } = await under()
    const big = { ...draft, rules: { ...draft.rules, maxPerBooking: 5 } }
    await expect(services.publish(big)).rejects.toMatchObject({
      reason: 'seller_mandate.over_units_per_order',
    })
  })

  it('quotes a sale the mandate allows, and sends no quote for a buyer it excludes', async () => {
    const { services, posted } = await under()
    const { version } = await services.publish(draft)
    const fine = orderFor(version, 2)
    const steps: { step: string; standing: { inForce: boolean } }[] = []
    await services.sell(fine, (s) => steps.push(s)).catch(() => {})
    expect(quoted(posted, fine.orderId)).not.toBeNull()

    const excluded = orderFor(version, 2, 'sandbox-blocked')
    const refused = services.sell(excluded)
    await expect(refused).rejects.toMatchObject({ reason: 'counterparty.not_eligible' })
    expect(quoted(posted, excluded.orderId)).toBeNull()
  })

  it('names the mandate it sold under in the agreement, which its signing key signs at version 2', async () => {
    const { services, posted, mandate, signingKey } = await under()
    const { version } = await services.publish(draft)
    const order = orderFor(version, 2)
    await services.sell(order).catch(() => {})
    const quote = quoted(posted, order.orderId)
    if (!quote) throw new Error('the seller quoted the order')
    expect(quote.agreement.sellerMandate).toBe(sellerMandateHash(mandate, domain))
    expect(termsAgreementVersion(quote.agreement)).toBe('2')
    const signer = await recoverAddress({
      hash: digestOf(termsAgreementTypedData(quote.agreement, domain)),
      signature: quote.supplierSignature,
    })
    expect(signer.toLowerCase()).toBe(signingKey.toLowerCase())
  })

  it('counts what it already quoted today, and refuses a sale past the day’s units', async () => {
    const { services, posted } = await under({
      limits: [
        {
          category: 'service',
          item: null,
          minUnitPrice: dollars(40),
          maxUnitsPerOrder: 4,
          maxUnitsPerDay: 6,
        },
      ],
    })
    const { version } = await services.publish(draft)
    for (const [i, units] of [4, 2].entries()) {
      const order = { ...orderFor(version, units), orderId: id(`day-${i}`).slice(2, 34) }
      await services.sell(order).catch(() => {})
      expect(quoted(posted, order.orderId), `order ${i}`).not.toBeNull()
    }
    const past = { ...orderFor(version, 1), orderId: id('day-past').slice(2, 34) }
    await expect(services.sell(past)).rejects.toMatchObject({
      reason: 'seller_mandate.over_daily_units',
    })
    expect(quoted(posted, past.orderId)).toBeNull()
  })

  it('refuses a sale a person would have to approve, since Avow takes no such request yet', async () => {
    const { services, posted } = await under({
      approvalRule: { kind: 'above', amount: dollars(100) },
    })
    const { version } = await services.publish(draft)
    const order = orderFor(version, 4)
    await expect(services.sell(order)).rejects.toMatchObject({ reason: 'approval.human_required' })
    expect(quoted(posted, order.orderId)).toBeNull()
  })

  it('lets only one of two orders quoted at once take the last of the day’s units', async () => {
    const { services, posted } = await under({
      limits: [
        {
          category: 'service',
          item: null,
          minUnitPrice: dollars(40),
          maxUnitsPerOrder: 4,
          maxUnitsPerDay: 6,
        },
      ],
    })
    const { version } = await services.publish(draft)
    const orders = [0, 1].map((i) => ({
      ...orderFor(version, 4),
      orderId: id(`race-${i}`).slice(2, 34),
    }))
    const results = await Promise.allSettled(orders.map((o) => services.sell(o)))
    const refused = results.filter(
      (r) =>
        r.status === 'rejected' &&
        r.reason instanceof SellerMandateRefusal &&
        r.reason.reason === 'seller_mandate.over_daily_units',
    )
    expect(refused).toHaveLength(1)
    expect(orders.filter((o) => quoted(posted, o.orderId) !== null)).toHaveLength(1)
  })

  it('still counts a sale accepted days ago as outstanding until it is due', async () => {
    const { services, store, posted } = await under({ maxOutstanding: dollars(500) })
    const { version } = await services.publish(draft)
    const now = BigInt(Math.floor(Date.now() / 1000))
    // A sale of $400 quoted and accepted three days ago, delivered a week from now.
    const kept = JSON.parse((await store.read('services')) ?? '{}')
    kept.quoted = [
      {
        orderId: 'aa'.repeat(16),
        item: 'Transcript',
        at: String(now - 3n * 86_400n),
        until: String(now - 3n * 86_400n + 900n),
        accepted: true,
        hashes: [],
        sale: { units: 8, price: String(dollars(400)), deliverBy: String(now + 7n * 86_400n) },
      },
    ]
    await store.write('services', JSON.stringify(kept))
    const order = orderFor(version, 3)
    await expect(services.sell(order)).rejects.toMatchObject({
      reason: 'seller_mandate.over_outstanding',
    })
    expect(quoted(posted, order.orderId)).toBeNull()
    // The kept sale is still there once the file is written again.
    const again = JSON.parse((await store.read('services')) ?? '{}')
    expect(again.quoted.map((q: { orderId: string }) => q.orderId)).toEqual(['aa'.repeat(16)])
  })

  it('counts the jobs it sold toward what it may have outstanding for a service', async () => {
    const { services, store, posted } = await under({ maxOutstanding: dollars(500) })
    const { version } = await services.publish(draft)
    const now = BigInt(Math.floor(Date.now() / 1000))
    // A job of $400 accepted an hour ago and due tomorrow, which the same mandate counts.
    await store.write(
      'job-sales',
      JSON.stringify({
        sales: {
          ['bb'.repeat(16)]: {
            category: 'compute-job',
            item: 'fine-tuning',
            units: 1,
            price: String(dollars(400)),
            at: String(now - 3600n),
            until: String(now - 3000n),
            deliverBy: String(now + 86_400n),
            accepted: true,
          },
        },
      }),
    )
    const order = orderFor(version, 3)
    await expect(services.sell(order)).rejects.toMatchObject({
      reason: 'seller_mandate.over_outstanding',
    })
    expect(quoted(posted, order.orderId)).toBeNull()
  })

  it('keeps an earlier quote when quoting the same order again is refused', async () => {
    const { services, store, posted, changeTo } = await under()
    const { version } = await services.publish(draft)
    const order = orderFor(version, 2)
    await services.sell(order).catch(() => {})
    expect(quoted(posted, order.orderId)).not.toBeNull()
    changeTo({ excludedBuyers: [BUYER] })
    await expect(services.sell(order)).rejects.toMatchObject({
      reason: 'counterparty.not_eligible',
    })
    const kept = JSON.parse((await store.read('services')) ?? '{}')
    const record = kept.quoted.find((q: { orderId: string }) => q.orderId === order.orderId)
    expect(record?.hashes).toHaveLength(1)
  })

  /** The order as the mailbox holds it once the buyer has funded the seller's quote. */
  const funded = (order: ReturnType<typeof orderFor>, quote: ServiceQuote) =>
    ({
      ...order,
      status: 'reserved',
      quote,
      reserve: { fundedIn: null, amount: dollars(50), acceptBy: order.builtAt + 900n },
    }) as const

  it('doesn’t accept an order whose agreement names a mandate replaced since the quote', async () => {
    const { services, posted, changeTo, mandate } = await under()
    const { version } = await services.publish(draft)
    const order = orderFor(version, 2)
    // Avow's answer to the quote isn't one the test serves, so the step ends after it's sent.
    await services.sell(order).catch(() => {})
    const quote = quoted(posted, order.orderId)
    if (!quote) throw new Error('the seller quoted the order')
    expect(quote.agreement.sellerMandate).toBe(sellerMandateHash(mandate, domain))
    // The administrator signs a new mandate the sale would pass, for the same key.
    changeTo({ mandateId: id('seller-mandate-2') })
    await expect(services.sell(funded(order, quote))).rejects.toThrow(NAMED_MANDATE_CHANGED)
    expect(posted.some((p) => p.path === SANDBOX_PATHS.serviceAccepted(order.orderId))).toBe(false)
  })

  it('doesn’t accept an order whose agreement names a mandate that has ended', async () => {
    const { services, posted, end } = await under()
    const { version } = await services.publish(draft)
    const order = orderFor(version, 2)
    // Avow's answer to the quote isn't one the test serves, so the step ends after it's sent.
    await services.sell(order).catch(() => {})
    const quote = quoted(posted, order.orderId)
    if (!quote) throw new Error('the seller quoted the order')
    end()
    await expect(services.sell(funded(order, quote))).rejects.toThrow(NAMED_MANDATE_CHANGED)
    expect(posted.some((p) => p.path === SANDBOX_PATHS.serviceAccepted(order.orderId))).toBe(false)
  })

  it('reads an agreement that names no mandate as the one in force only while none is', () => {
    const standing = { inForce: false, notice: NO_SELLER_MANDATE } as const
    expect(() => holdToNamedMandate(standing, undefined)).not.toThrow()
    expect(() => holdToNamedMandate(standing, id('seller-mandate-1'))).toThrow(
      NAMED_MANDATE_CHANGED,
    )
  })

  it('says in the refusal itself, once, that Avow enforces no seller limit', async () => {
    const { services } = await under()
    const refused = await services.publish({ ...draft, unitPrice: dollars(10) }).catch((e) => e)
    expect(refused).toBeInstanceOf(SellerMandateRefusal)
    expect(refused.message.match(/Avow doesn't enforce seller limits yet/g)).toHaveLength(1)
  })

  it('refuses to sell at all once its mandate has ended', async () => {
    const { services } = await under({ expiry: 1_700_000_000n })
    await expect(services.publish(draft)).rejects.toMatchObject({
      reason: 'seller_mandate.expired',
    })
  })
})

describe('a selling agent whose mandates don’t read as one chain', () => {
  it('says it couldn’t read its mandates when the chain doesn’t read', async () => {
    const s = await seller()
    const stranger = (await seller()).root
    const mandate = mandateFor(s.root.address, s.signingKey)
    const served = async () =>
      toWire({ current: await signed(mandate, stranger), earlier: [], revocation: null })
    const services = await sandboxServices({ store: s.store, fetch: avow(served).fetch })
    const refused = await services.sellerStanding().catch((e) => e)
    expect(refused).toMatchObject({ of: 'chain' })
    expect(refused.message).toMatch(/couldn't read its seller's mandates/)
  })

  it('reads Avow holding no mandate for its key as none in force, and any other 404 as a refusal', async () => {
    const s = await seller()
    const missing = avow(null, async () =>
      json({ error: { reason: 'seller_mandate.missing', message: 'No mandate' } }, 404),
    )
    const none = await sandboxServices({ store: s.store, fetch: missing.fetch })
    expect(await none.sellerStanding()).toEqual({ inForce: false, notice: NO_SELLER_MANDATE })
    const unknown = avow(null, async () =>
      json({ error: { reason: 'request.signer_unknown', message: 'Unknown key' } }, 404),
    )
    const refused = await sandboxServices({ store: s.store, fetch: unknown.fetch })
    await expect(refused.sellerStanding()).rejects.toThrow(/Unknown key/)
    await expect(refused.publish(draft)).rejects.toThrow()
    expect(await refused.published()).toEqual([])
  })

  it('refuses to sell when the business account didn’t sign its mandate', async () => {
    const s = await seller()
    const stranger = (await seller()).root
    const mandate = mandateFor(s.root.address, s.signingKey)
    const served = async () =>
      toWire({ current: await signed(mandate, stranger), earlier: [], revocation: null })
    const services = await sandboxServices({ store: s.store, fetch: avow(served).fetch })
    await expect(services.sellerStanding()).rejects.toMatchObject({
      reason: 'seller_mandate.signature_invalid',
    })
    await expect(services.publish(draft)).rejects.toBeInstanceOf(SellerMandateRefusal)
  })

  it('refuses to sell once its key is revoked', async () => {
    const s = await seller()
    const mandate = mandateFor(s.root.address, s.signingKey)
    const revocation = {
      businessId: SELLER,
      account: mandate.account,
      signingKey: mandate.signingKey,
    }
    const served = async () =>
      toWire({
        current: await signed(mandate, s.root),
        earlier: [],
        revocation: envelope(
          'SellerKeyRevocation',
          revocation,
          await s.root.sign({ hash: digestOf(sellerKeyRevocationTypedData(revocation, domain)) }),
        ),
      })
    const services = await sandboxServices({ store: s.store, fetch: avow(served).fetch })
    await expect(services.sellerStanding()).rejects.toMatchObject({
      reason: 'seller_mandate.revoked',
    })
  })

  it('refuses to sell when Avow serves something that isn’t a chain of mandates', async () => {
    const s = await seller()
    const services = await sandboxServices({
      store: s.store,
      fetch: avow(async () => ({ current: 'nothing' })).fetch,
    })
    await expect(services.sellerStanding()).rejects.toThrow()
    await expect(services.publish(draft)).rejects.toThrow()
    expect(await services.published()).toEqual([])
  })
})

describe('reading the seller’s mandates when Avow can’t answer', () => {
  async function readWith(respond: (init?: RequestInit) => Promise<Response>) {
    const s = await seller()
    const signing = privateKeyToAccount(
      (JSON.parse((await s.store.read('supplier')) ?? '{}') as { signingKey: Hex }).signingKey,
    )
    return readSellerStanding({
      apiUrl: deployment.apiUrl,
      signing,
      domain,
      agent: { businessId: SELLER, account: s.root.address, signingKey: signing.address },
      isAccountSignature: async () => true,
      fetch: avow(null, respond).fetch,
      retryFor: 0n,
      attemptTimeout: 50,
    })
  }

  it('waits no more than its short retry for its mandates, and gives SELLER_STANDING_RETRY_FOR as that', () => {
    expect(SELLER_STANDING_RETRY_FOR).toBeGreaterThanOrEqual(20n)
    expect(SELLER_STANDING_RETRY_FOR).toBeLessThanOrEqual(30n)
  })

  it('refuses to sell on a 5xx, which says nothing about a mandate', async () => {
    await expect(readWith(async () => json({ error: { message: 'down' } }, 503))).rejects.toThrow(
      /No definite answer/,
    )
  })

  it('refuses to sell when no answer comes in time', async () => {
    // A request that hangs until its own timeout gives up on it.
    const never = (init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })
    await expect(readWith(never)).rejects.toThrow(/No definite answer/)
  })
})

describe('asking for a seller’s mandate', () => {
  const ID = 'ab'.repeat(16)
  /** A request for a seller's mandate as Avow answers it, at a state. */
  const requestAs = (ask: Record<string, unknown>, state: string, sellerMandate: Hex | null) => ({
    id: ID,
    businessId: SELLER,
    agentKey: `0x${'11'.repeat(20)}`,
    requestedAt: '1800000000',
    expiresAt: '1800086400',
    status: state === 'active' ? { state, at: '1800000100', transaction: null } : { state },
    ...ask,
    basis: { sellerMandate },
  })
  const termsOf = (m: SellerMandate) => sellerMandateTermsOf(m)

  async function asking(o: {
    holds?: boolean
    answer?: (body: Record<string, unknown>) => Response
  }) {
    const s = await seller()
    const mandate = mandateFor(s.root.address, s.signingKey)
    const served = o.holds
      ? async () =>
          toWire({ current: await signed(mandate, s.root), earlier: [], revocation: null })
      : null
    const asks: Record<string, unknown>[] = []
    const reads: string[] = []
    const api = avow(served, undefined, (path, body) => {
      if (path === SANDBOX_PATHS.approvalRequests) {
        asks.push(body)
        return o.answer
          ? o.answer(body)
          : json(requestAs(body, 'waiting', o.holds ? sellerMandateHash(mandate, domain) : null))
      }
      if (path === SANDBOX_PATHS.approvalRequest(ID)) {
        reads.push(path)
        const state = reads.length < 3 ? 'waiting' : 'active'
        return json(requestAs(asks[0] ?? {}, state, null))
      }
      return null
    })
    const services = await sandboxServices({ store: s.store, fetch: api.fetch })
    const raw = () =>
      api.posted.filter((p) => p.path === SANDBOX_PATHS.approvalRequests).map((p) => p.raw)
    return { ...s, mandate, services, asks, reads, raw, posted: api.posted }
  }

  it('asks with the exact terms and the reason for a first mandate, and answers with the link', async () => {
    const { services, asks, raw, mandate } = await asking({})
    const outcome = await services.askToSell(termsOf(mandate))
    if (!outcome.ok) throw new Error('the ask was taken')
    const sent = { kind: 'seller_mandate', terms: termsOf(mandate), reason: 'new_seller' } as const
    // What went is exactly the ask, byte for byte as a signed body carries it, and one Avow's own
    // parser reads back.
    expect(raw()).toEqual([new TextDecoder().decode(encodeApiBody(sent))])
    const read = parseApprovalAsk(asks[0])
    expect(read.ok).toBe(true)
    if (read.ok) expect(read.value).toEqual(sent)
    expect(outcome.asked.request).toMatchObject({ id: ID, kind: 'seller_mandate' })
    expect(outcome.asked.link).toContain(ID)
  })

  it('gives the reason for other limits when a mandate is in force', async () => {
    const { services, asks, mandate } = await asking({ holds: true })
    await services.askToSell({ ...termsOf(mandate), maxOrderValue: dollars(400) })
    expect(asks[0]?.reason).toBe('seller_limits')
  })

  it('says plainly that Avow doesn’t take these requests yet, and that nothing was asked', async () => {
    const { services, mandate } = await asking({
      answer: () =>
        json(
          {
            error: {
              reason: 'approval_request.kind_unavailable',
              message: "Avow doesn't take requests of this kind yet, so nothing was asked",
            },
          },
          409,
        ),
    })
    const outcome = await services.askToSell(termsOf(mandate))
    expect(outcome).toEqual({
      ok: false,
      reason: 'approval_request.kind_unavailable',
      notice: SELLER_MANDATE_ASKS_UNTAKEN,
    })
    expect(SELLER_MANDATE_ASKS_UNTAKEN).toMatch(/doesn't take seller's mandate requests yet/)
    expect(SELLER_MANDATE_ASKS_UNTAKEN).toMatch(/nothing was asked/)
  })

  it('refuses terms for another signing key than its own before it asks', async () => {
    const { services, asks, mandate } = await asking({})
    const other = { ...termsOf(mandate), signingKey: `0x${'5e'.repeat(20)}` as Address }
    await expect(services.askToSell(other)).rejects.toThrow(/another signing key/)
    expect(asks).toEqual([])
  })

  it('refuses terms that aren’t well formed before it asks', async () => {
    const { services, asks, mandate } = await asking({})
    await expect(services.askToSell({ ...termsOf(mandate), limits: [] })).rejects.toThrow(
      RangeError,
    )
    expect(asks).toEqual([])
  })

  it('reads where the request stands until the mandate is in force', async () => {
    const { services, mandate, reads } = await asking({})
    const outcome = await services.askToSell(termsOf(mandate))
    if (!outcome.ok) throw new Error('the ask was taken')
    const states: string[] = []
    const settled = await services.awaitSellRequest(ID, {
      every: 1,
      onRead: (a) => states.push(a.request.status.state),
    })
    expect(settled.request.status.state).toBe('active')
    expect(states).toEqual(['waiting', 'waiting', 'active'])
    expect(reads).toHaveLength(3)
  })
})
