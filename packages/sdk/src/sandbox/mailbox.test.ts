import {
  dollars,
  encodeApiBody,
  GPU_RESERVATION,
  JOB_CATEGORY,
  mandateHash,
  SANDBOX_PATHS,
  testnetDemoJobTerms,
} from '@avow-finance/spec'
import type { Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { Account } from 'viem/tempo'
import { describe, expect, it, vi } from 'vitest'
import { accountSigner, signMandate } from '../sign.js'
import { deployment, domain, LOCK, supplier, TOKEN } from '../test/sandbox-business.js'
import { sandboxMandate } from './mandate.js'
import { memoryStore, saveAgentItem, write } from './store.js'

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
vi.mock('../job/quote.js', () => ({ quoteJob: quotes }))

const { sandboxMailbox } = await import('./mailbox.js')
const { readOrderArgs } = await import('../node/mailbox.js')

const BUYER = 'sandbox-buyer'
const SELLER = 'sandbox-seller'
const wire = (value: unknown) => JSON.parse(new TextDecoder().decode(encodeApiBody(value)))
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** A folder holding an enrolled agent, and for a seller its registered signing key too. */
async function agentFolder(businessId: string, sells = false) {
  const store = memoryStore()
  const root = Account.fromSecp256k1(generatePrivateKey())
  const agentKey = generatePrivateKey()
  const message = sandboxMandate({
    businessId,
    agentId: 'agt_test',
    account: root.address,
    agentKey: Account.fromSecp256k1(agentKey, { access: root.address }).accessKeyAddress,
    suppliers: [SELLER, supplier.id],
    categories: [JOB_CATEGORY, 'compute'],
    token: TOKEN,
    capPerCommitment: dollars(500),
    capOpenReserves: dollars(1000),
    expiry: 1_900_000_000n,
  })
  const business = { ...deployment, account: root.address, lock: LOCK, businessId }
  await saveAgentItem(store, {
    agentKey,
    business,
    mandate: await signMandate(message, domain, accountSigner(root.address, root)),
    mandateHash: mandateHash(message, domain),
    keyAuthorizedIn: `0x${'ab'.repeat(32)}`,
    suppliers: [supplier],
  })
  if (sells) {
    const signingKey = generatePrivateKey()
    await write(store, 'supplier', {
      signingKey,
      profile: {
        businessId,
        account: root.address,
        payee: root.address,
        signingKey: privateKeyToAccount(signingKey).address,
      },
      business,
    })
  }
  return { store, root }
}

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
    // The order named the seller and the job, and lapses a minute after it was sent.
    expect(sent).toMatchObject({ supplierBusinessId: SELLER })
    expect(Number(sent.expiry) - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(60)
    // Nothing went to Avow's approvals, the relay or the reserve route.
    expect(paths.filter((p) => p !== '/config.json')).toEqual([
      SANDBOX_PATHS.mailboxOrders,
      SANDBOX_PATHS.mailboxOrder(String(sent.orderId)),
    ])
  })

  it('quotes with the booking it kept after a restart, and books nothing new', async () => {
    bookings.mockReset()
    quotes.mockReset().mockResolvedValue({ quoted: true })
    const { store } = await agentFolder(SELLER, true)
    const order = anOrder(1_800_000_600n)
    const compute = {
      lock: LOCK,
      commitmentId: `0x${'34'.repeat(32)}`,
      terms: { kept: true },
      salt: `0x${'56'.repeat(32)}`,
      termsHash: `0x${'78'.repeat(32)}`,
    }
    await write(store, 'mailbox', { [order.orderId]: { compute } })
    const posted: { path: string; body: unknown }[] = []
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname
      if (path === '/config.json') return json(wire(deployment))
      const body = init?.body ? JSON.parse(new TextDecoder().decode(init.body as Uint8Array)) : {}
      posted.push({ path, body })
      const held = answered(wire(order), 'requested')
      return json(path === SANDBOX_PATHS.mailboxInbox ? { orders: [held] } : held)
    }) as typeof globalThis.fetch

    const mailbox = await sandboxMailbox({ store, fetch })
    const [held] = (await mailbox.inbox()) ?? []
    if (!held) throw new Error('The inbox read no order')
    await mailbox.sell(held)
    expect(bookings).not.toHaveBeenCalled()
    expect(quotes).toHaveBeenCalledOnce()
    expect(quotes.mock.calls[0]?.[0]).toMatchObject({
      compute: { reference: { commitmentId: compute.commitmentId, lock: LOCK } },
    })
    expect(posted.map((p) => p.path)).toEqual([
      SANDBOX_PATHS.mailboxInbox,
      SANDBOX_PATHS.mailboxQuote(order.orderId),
    ])
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
