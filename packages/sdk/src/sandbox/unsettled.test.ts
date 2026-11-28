import { dollars, mandateHash } from '@avow-finance/spec'
import type { Hex } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { Account } from 'viem/tempo'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { accountSigner, signMandate } from '../sign.js'
import { deployment, domain, LOCK, supplier, TOKEN } from '../test/sandbox-business.js'
import { sandboxMandate } from './mandate.js'
import { memoryStore, type SandboxStore, saveAgentItem } from './store.js'

// What the agent's booking does once every check has passed, set by each test.
const booking = vi.hoisted(() => ({ outcome: 'funded' as 'funded' | 'unknown' }))
const ID = `0x${'c1'.repeat(32)}` as Hex
const TERMS_HASH = `0x${'7e'.repeat(32)}` as Hex

vi.mock('../agent.js', async (original) => {
  const real = await original<typeof import('../agent.js')>()
  return {
    ...real,
    createAgent: () => ({
      book: async () => {
        const commitment = { commitmentId: ID, termsHash: TERMS_HASH }
        if (booking.outcome === 'unknown') {
          throw new real.BookingError(
            'The reserve was sent and the chain did not show it',
            'unknown',
            commitment as never,
            [`0x${'ab'.repeat(32)}`],
          )
        }
        return { ok: true, commitment: { ...commitment, reservedIn: null } }
      },
    }),
  }
})
vi.mock('./suppliers.js', async (original) => ({
  ...(await original<typeof import('./suppliers.js')>()),
  connectSupplier: async () => ({}),
}))
vi.mock('../lock.js', async (original) => ({
  ...(await original<typeof import('../lock.js')>()),
  readOpenReserves: async () => 0n,
}))
vi.mock('../moderato.js', async (original) => ({
  ...(await original<typeof import('../moderato.js')>()),
  moderatoClient: () => ({
    readContract: async () => [dollars(1000), 0n],
  }),
}))

const { sandboxAgent, UnsettledCommitment } = await import('./agent.js')

/** An agent enrolled for the demo supplier, over a store whose commitments can fail to save. */
async function enrolled(store: SandboxStore) {
  const root = Account.fromSecp256k1(generatePrivateKey())
  const agentKey = generatePrivateKey()
  const agent = Account.fromSecp256k1(agentKey, { access: root.address })
  const message = sandboxMandate({
    businessId: 'sandbox-business',
    agentId: 'agt_test',
    account: root.address,
    agentKey: agent.accessKeyAddress,
    suppliers: [supplier.id],
    token: TOKEN,
    capPerCommitment: dollars(500),
    capOpenReserves: dollars(1000),
    dailyLimit: dollars(1000),
    expiry: BigInt(Math.floor(Date.now() / 1000)) + 300n * 86_400n,
  })
  await saveAgentItem(store, {
    agentKey,
    business: {
      chainId: deployment.chainId,
      apiUrl: deployment.apiUrl,
      factory: deployment.factory,
      token: TOKEN,
      account: root.address,
      lock: LOCK,
      businessId: 'sandbox-business',
    },
    mandate: await signMandate(message, domain, accountSigner(root.address, root)),
    mandateHash: mandateHash(message, domain),
    keyAuthorizedIn: `0x${'ab'.repeat(32)}`,
    suppliers: [supplier],
  })
  // The agent asks Avow for its mandates once, which this API has no route for.
  const fetch = (async () =>
    Response.json(
      { error: { code: 'request.invalid' } },
      { status: 404 },
    )) as typeof globalThis.fetch
  return sandboxAgent({ store, deployment, session: null, fetch, log: () => {} })
}

const tenDollars = {
  supplier: supplier.id,
  resource: { gpu: 'H100', count: 1, hours: 1 },
  reserve: 10,
}

beforeEach(() => {
  booking.outcome = 'funded'
})

describe('a booking the agent could not see through', () => {
  it('names the commitment whose reserve may have landed when the chain did not show it', async () => {
    booking.outcome = 'unknown'
    const agent = await enrolled(memoryStore())
    const error = await agent.book(tenDollars).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(UnsettledCommitment)
    const u = error as InstanceType<typeof UnsettledCommitment>
    expect(u.landed).toBe('unknown')
    expect(u.reference).toMatchObject({ commitmentId: ID, termsHash: TERMS_HASH, lock: LOCK })
    expect(u.amount).toBe(dollars(10))
    expect(u.link).toContain('#verify=')
    expect(u.releaseDate).toBeGreaterThan(0n)
  })

  it('names the funded commitment when the folder fails to save it', async () => {
    const inner = memoryStore()
    let failing = false
    const store: SandboxStore = {
      read: (item) => inner.read(item),
      write: async (item, text) => {
        if (failing && item === 'state') throw new Error('disk full')
        return inner.write(item, text)
      },
    }
    const agent = await enrolled(store)
    failing = true
    const error = await agent.book(tenDollars).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(UnsettledCommitment)
    const u = error as InstanceType<typeof UnsettledCommitment>
    expect(u.landed).toBe('yes')
    expect(u.message).toContain('disk full')
    expect(u.reference.commitmentId).toBe(ID)
  })
})
