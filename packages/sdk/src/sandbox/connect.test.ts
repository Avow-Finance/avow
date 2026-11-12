import { dollars, encodeApiBody, mandateHash, pairingCode, SANDBOX_PATHS } from '@avow-finance/spec'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { Account } from 'viem/tempo'
import { describe, expect, it, vi } from 'vitest'
import { accountSigner, signMandate } from '../sign.js'
import { deployment, domain, LOCK, supplier, TOKEN } from '../test/sandbox-business.js'
import { sandboxMandate } from './mandate.js'
import { loadAgentItem, memoryStore, saveAgentItem } from './store.js'

vi.mock('../moderato.js', async (original) => ({
  ...(await original<typeof import('../moderato.js')>()),
  moderatoClient: () => ({ readContract: async () => LOCK }),
}))

const { connectToBusiness } = await import('./connect.js')

const BUSINESS = 'sandbox-business'
const wire = (value: unknown) => JSON.parse(new TextDecoder().decode(encodeApiBody(value)))
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/**
 * The sandbox as an agent connecting to it sees it: the screen's config, Avow's API and the demo
 * supplier. The administrator approves on the ask after `approveAfter` asks, signing the mandate
 * for whatever key the agent asked with, as the console does.
 */
function sandbox(store: ReturnType<typeof memoryStore>, approveAfter = 1) {
  const root = Account.fromSecp256k1(generatePrivateKey())
  const asks: { body: unknown; signer: string | null }[] = []
  const enrollments: unknown[] = []
  const status = (state: 'pending' | 'approved', agentKey: `0x${string}`, extra = {}) => ({
    businessId: BUSINESS,
    agentKey: agentKey.toLowerCase(),
    lock: LOCK.toLowerCase(),
    label: 'Research agent',
    pairingCode: pairingCode(agentKey),
    requestedAt: '1800000000',
    expiresAt: '1800003600',
    signingKey: null,
    state,
    ...extra,
  })
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const path = url.pathname
    if (path === '/config.json') return json(wire(deployment))
    if (path === SANDBOX_PATHS.supplier(BUSINESS)) {
      return json({
        businessId: BUSINESS,
        account: root.address,
        payee: root.address,
        signingKey: privateKeyToAccount(generatePrivateKey()).address,
      })
    }
    if (url.origin === new URL(supplier.url).origin && path === '/profile') {
      return json({
        businessId: supplier.id,
        account: privateKeyToAccount(generatePrivateKey()).address,
        payee: privateKeyToAccount(generatePrivateKey()).address,
        signingKey: privateKeyToAccount(generatePrivateKey()).address,
      })
    }
    if (!init?.body) return json({ error: { reason: 'supplier.unknown' } }, 404)
    const body = JSON.parse(new TextDecoder().decode(init.body as Uint8Array))
    if (path === SANDBOX_PATHS.agentRequests) {
      asks.push({ body, signer: new Headers(init?.headers).get('authorization') })
      const held = JSON.parse((await store.read('request')) ?? '{}') as { agentKey: `0x${string}` }
      const agentKey = Account.fromSecp256k1(held.agentKey, {
        access: root.address,
      }).accessKeyAddress
      if (asks.length <= approveAfter) return json(status('pending', agentKey))
      const message = sandboxMandate({
        businessId: BUSINESS,
        agentId: 'agt_research',
        account: root.address,
        agentKey,
        suppliers: [supplier.id],
        token: TOKEN,
        capPerCommitment: dollars(500),
        capOpenReserves: dollars(500),
        dailyLimit: dollars(1000),
        expiry: BigInt(Math.floor(Date.now() / 1000)) + 86_400n,
      })
      const mandate = await signMandate(message, domain, accountSigner(root.address, root))
      return json(
        status('approved', agentKey, {
          approval: wire({ mandate, keyAuthorizedIn: `0x${'ab'.repeat(32)}` }),
          supplierRegistration: null,
        }),
      )
    }
    if (path === '/v1/enrollments') {
      enrollments.push(body)
      const m = body.mandate.message
      return json({
        businessId: m.businessId,
        agentId: m.agentId,
        agentKey: m.agentKey,
        mandateHash: `0x${'cd'.repeat(32)}`,
      })
    }
    return json({ error: { reason: 'request.invalid' } }, 404)
  }) as typeof globalThis.fetch
  return { fetch, root, asks, enrollments }
}

describe('connecting an agent to a business', () => {
  it('asks with a key of its own, waits for the approval, enrolls, and keeps what every call reads', async () => {
    const store = memoryStore()
    const world = sandbox(store, 2)
    const events: string[] = []
    const item = await connectToBusiness({
      businessId: BUSINESS,
      label: 'Research agent',
      store,
      fetch: world.fetch,
      pollEvery: 1,
      onEvent: (e) => events.push(e.type),
    })
    expect(events).toEqual(['asked', 'waiting', 'waiting', 'approved', 'enrolled'])
    // Every ask names the business and the label, and is signed.
    expect(world.asks).toHaveLength(3)
    for (const ask of world.asks) {
      expect(ask.body).toEqual({ businessId: BUSINESS, label: 'Research agent' })
      expect(ask.signer).toMatch(/^Avow /)
    }
    expect(world.enrollments).toHaveLength(1)
    // The agent item is the one sandboxAgent and the MCP server read, with the agent's own key.
    const kept = await loadAgentItem(store)
    expect(kept?.business).toMatchObject({
      businessId: BUSINESS,
      account: world.root.address,
      lock: LOCK,
    })
    expect(kept?.mandate.message.agentId).toBe('agt_research')
    expect(kept?.mandateHash).toBe(`0x${'cd'.repeat(32)}`)
    expect(kept?.suppliers).toEqual([supplier])
    const agentAddress = Account.fromSecp256k1(item.agentKey, {
      access: world.root.address,
    }).accessKeyAddress
    expect(kept?.mandate.message.agentKey.toLowerCase()).toBe(agentAddress.toLowerCase())
    // No business key was ever on this machine.
    expect(await store.read('business')).toBeNull()
  })

  it('asks with the same key after a restart, so the pairing code stays the same', async () => {
    const store = memoryStore()
    const world = sandbox(store, 99)
    const codes: string[] = []
    const run = () => {
      const stop = new AbortController()
      return connectToBusiness({
        businessId: BUSINESS,
        label: 'Research agent',
        store,
        fetch: world.fetch,
        pollEvery: 1,
        signal: stop.signal,
        onEvent: (e) => {
          if (e.type === 'asked') codes.push(e.pairingCode)
          if (e.type === 'waiting') stop.abort(new Error('stopped'))
        },
      }).catch(() => null)
    }
    await run()
    await run()
    expect(codes).toHaveLength(2)
    expect(codes[0]).toBe(codes[1])
  })

  it('refuses an approval for another agent', async () => {
    const store = memoryStore()
    const world = sandbox(store, 0)
    const realFetch = world.fetch
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      // The request item swapped for another key after asking, as a mixed-up approval would be.
      if (new URL(String(input)).pathname === SANDBOX_PATHS.agentRequests) {
        await store.write(
          'request',
          JSON.stringify({ agentKey: generatePrivateKey(), businessId: BUSINESS }),
        )
      }
      return realFetch(input, init)
    }) as typeof globalThis.fetch
    await expect(
      connectToBusiness({
        businessId: BUSINESS,
        label: 'Research agent',
        store,
        fetch,
        pollEvery: 1,
      }),
    ).rejects.toThrow(/another agent/)
    expect(await loadAgentItem(store)).toBeNull()
  })

  it('refuses to run in a folder that already has an agent', async () => {
    const store = memoryStore()
    const world = sandbox(store)
    const message = sandboxMandate({
      businessId: BUSINESS,
      agentId: 'agt_old',
      account: world.root.address,
      agentKey: privateKeyToAccount(generatePrivateKey()).address,
      suppliers: [supplier.id],
      token: TOKEN,
      capPerCommitment: dollars(1),
      capOpenReserves: dollars(1),
      dailyLimit: dollars(1),
      expiry: 1_900_000_000n,
    })
    await saveAgentItem(store, {
      agentKey: generatePrivateKey(),
      business: { ...deployment, account: world.root.address, lock: LOCK, businessId: BUSINESS },
      mandate: await signMandate(message, domain, accountSigner(world.root.address, world.root)),
      mandateHash: mandateHash(message, domain),
      keyAuthorizedIn: `0x${'ab'.repeat(32)}`,
      suppliers: [supplier],
    })
    await expect(
      connectToBusiness({ businessId: BUSINESS, label: 'x', store, fetch: world.fetch }),
    ).rejects.toThrow(/already has an agent/)
  })

  it('names the console when the business ID is unknown', async () => {
    const store = memoryStore()
    const world = sandbox(store)
    await expect(
      connectToBusiness({ businessId: 'sandbox-nobody', label: 'x', store, fetch: world.fetch }),
    ).rejects.toThrow(/no sandbox business sandbox-nobody/)
  })
})
