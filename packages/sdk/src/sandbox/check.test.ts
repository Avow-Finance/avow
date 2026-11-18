import { dollars, mandateHash, SANDBOX_PATHS } from '@avow-finance/spec'
import { generatePrivateKey } from 'viem/accounts'
import { Account } from 'viem/tempo'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { accountSigner, signMandate } from '../sign.js'
import { deployment, domain, LOCK, supplier, TOKEN } from '../test/sandbox-business.js'
import { sandboxMandate } from './mandate.js'
import { memoryStore, saveAgentItem } from './store.js'

// What the lock holds under the mandate and what the key can still move today, in base units.
const chain = vi.hoisted(() => ({ open: 0n, leftToday: 0n, sent: 0 }))
vi.mock('../lock.js', async (original) => ({
  ...(await original<typeof import('../lock.js')>()),
  readOpenReserves: async () => chain.open,
}))
vi.mock('../moderato.js', async (original) => ({
  ...(await original<typeof import('../moderato.js')>()),
  moderatoClient: () => ({
    readContract: async (call: { functionName: string }) => {
      if (call.functionName === 'getRemainingLimitWithPeriod') return [chain.leftToday, 0n]
      throw new Error(`unexpected read ${call.functionName}`)
    },
  }),
}))

const { sandboxAgent } = await import('./agent.js')

/** An agent enrolled with $500 a commitment, $1,000 held at once and $1,000 a day. */
async function enrolled() {
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
    expiry: BigInt(Math.floor(Date.now() / 1000)) + 30n * 86_400n,
  })
  const store = memoryStore()
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
  // Anything sent anywhere is counted, since a check sends nothing. The agent reads its mandates
  // from Avow once when it starts, which this API answers it has no route for, so the agent keeps
  // the one it was enrolled with.
  const fetch = (async (input: string | URL | Request) => {
    if (String(input).endsWith(SANDBOX_PATHS.agentMandates)) {
      return Response.json({ error: { code: 'request.invalid' } }, { status: 404 })
    }
    chain.sent++
    return new Response('{}', { status: 500 })
  }) as typeof globalThis.fetch
  return sandboxAgent({ store, deployment, session: null, fetch, log: () => {} })
}

const booking = (reserve: number, s = supplier.id) => ({
  supplier: s,
  resource: { gpu: 'H100', count: 8, hours: 1 },
  reserve,
})

beforeEach(() => {
  chain.open = 0n
  chain.leftToday = dollars(1000)
  chain.sent = 0
})

describe("checking a booking before it's made", () => {
  it('passes a booking inside every limit, with the amounts behind it, and sends nothing', async () => {
    chain.open = dollars(200)
    chain.leftToday = dollars(800)
    const agent = await enrolled()
    expect(await agent.check(booking(300))).toEqual({
      passes: true,
      amounts: {
        needed: dollars(300),
        left: dollars(800),
        authority: dollars(1000),
        capPerCommitment: dollars(500),
        dailyLimit: dollars(1000),
        dailyLeft: dollars(800),
      },
    })
    expect(chain.sent).toBe(0)
  })

  it('names the layer that would refuse each limit', async () => {
    const agent = await enrolled()
    // The SDK refuses a supplier the mandate doesn't name, and a reserve over the per-commitment cap.
    expect(await agent.check(booking(100, 'someone-else'))).toMatchObject({
      passes: false,
      code: 'mandate.supplier_not_allowed',
      layer: 'sdk',
    })
    expect(await agent.check(booking(600))).toMatchObject({
      passes: false,
      code: 'mandate.over_commitment_cap',
      layer: 'sdk',
    })
    // Avow refuses what would take the lock's open reserves past the cap.
    chain.open = dollars(700)
    expect(await agent.check(booking(400))).toMatchObject({
      passes: false,
      code: 'mandate.over_open_reserves_cap',
      layer: 'avow',
      amounts: { left: dollars(300) },
    })
    // The keychain refuses what the key can't move today.
    chain.open = 0n
    chain.leftToday = dollars(250)
    expect(await agent.check(booking(300))).toMatchObject({
      passes: false,
      code: 'keychain.over_daily_limit',
      layer: 'keychain',
      amounts: { dailyLeft: dollars(250) },
    })
    expect(chain.sent).toBe(0)
  })
})
