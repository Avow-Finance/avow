import {
  digestOf,
  dollars,
  parseServiceQuote,
  SANDBOX_PATHS,
  SERVICE_CATEGORY,
  type SellerMandate,
  type ServiceOfferVersion,
  type Signed,
  sellerKeyRevocationTypedData,
  sellerMandateHash,
  sellerMandateTypedData,
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
const { NO_SELLER_MANDATE, SellerMandateRefusal } = await import('./seller-mandate.js')
const { readSellerStanding, SELLER_STANDING_RETRY_FOR } = await import('./seller-mandate-read.js')

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
) {
  const posted: { path: string; body: Record<string, unknown> }[] = []
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    if (path === '/config.json') return json(JSON.parse(JSON.stringify(toWire(deployment))))
    const body = init?.body ? JSON.parse(new TextDecoder().decode(init.body as Uint8Array)) : {}
    posted.push({ path, body })
    if (path === SANDBOX_PATHS.sellerMandates) {
      if (respond) return respond(init)
      return mandates
        ? json(await mandates())
        : json({ error: { reason: 'request.invalid', message: 'No such route' } }, 404)
    }
    return json({ error: { reason: 'request.invalid', message: 'No such route' } }, 404)
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
    expect(quoted(posted, order.orderId)).not.toBeNull()
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
    expect(posted.some((p) => p.path === SANDBOX_PATHS.sellerMandates)).toBe(false)
  })
})

describe('a selling agent under a seller’s mandate', () => {
  async function under(change: Partial<SellerMandate> = {}) {
    const s = await seller()
    const mandate = mandateFor(s.root.address, s.signingKey, change)
    let current = mandate
    const served = async () =>
      toWire({ current: await signed(current, s.root), earlier: [], revocation: null })
    const api = avow(served)
    const services = await sandboxServices({ store: s.store, fetch: api.fetch })
    /** Serves a mandate with these changes in place of the first, as an administrator's new one. */
    const changeTo = (next: Partial<SellerMandate>) => {
      current = mandateFor(s.root.address, s.signingKey, { ...change, ...next })
    }
    return { ...s, mandate, services, changeTo, ...api }
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
