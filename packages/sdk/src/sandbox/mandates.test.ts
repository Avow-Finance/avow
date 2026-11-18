import {
  dollars,
  keychainSignatureCheck,
  type Mandate,
  mandateHash,
  SANDBOX_PATHS,
  type Signed,
  toWire,
} from '@avow-finance/spec'
import type { Hex } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { Account } from 'viem/tempo'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { accountSigner, signMandate } from '../sign.js'
import { deployment, domain, LOCK, supplier, TOKEN } from '../test/sandbox-business.js'
import { sandboxMandate } from './mandate.js'
import { memoryStore, saveAgentItem } from './store.js'

// What the lock holds under each mandate hash, the key's witness on the chain, and what Avow
// serves as the agent's mandates.
const chain = vi.hoisted(() => ({
  open: new Map<string, bigint>(),
  witness: null as Hex | null,
  served: null as unknown,
  supplierAsked: 0,
}))
vi.mock('../lock.js', async (original) => ({
  ...(await original<typeof import('../lock.js')>()),
  readOpenReserves: async (_client: unknown, _lock: unknown, hash: Hex) =>
    chain.open.get(hash.toLowerCase()) ?? 0n,
}))
// The account's signature as the chain checks it, with no admin keys, so only the root key signs.
vi.mock('@avow-finance/spec', async (original) => ({
  ...(await original<typeof import('@avow-finance/spec')>()),
  tempoKeychainCheck: () => keychainSignatureCheck(() => false),
}))
vi.mock('@avow-finance/verifier', async (original) => ({
  ...(await original<typeof import('@avow-finance/verifier')>()),
  readAgentKey: async () => ({ active: true, expiry: null, witness: chain.witness }),
}))
vi.mock('../moderato.js', async (original) => ({
  ...(await original<typeof import('../moderato.js')>()),
  moderatoClient: () => ({
    readContract: async (call: { functionName: string }) => {
      if (call.functionName === 'getRemainingLimitWithPeriod') return [dollars(5000), 0n]
      throw new Error(`unexpected read ${call.functionName}`)
    },
  }),
}))

const { sandboxAgent } = await import('./agent.js')

const root = Account.fromSecp256k1(generatePrivateKey())
const agentHex = generatePrivateKey()
const agent = Account.fromSecp256k1(agentHex, { access: root.address })
const signer = accountSigner(root.address, root)

/** The mandate the agent enrolled with: $500 a commitment and $1,000 held at once. */
const first = sandboxMandate({
  businessId: 'sandbox-business',
  agentId: 'agt_test',
  account: root.address,
  agentKey: agent.accessKeyAddress,
  suppliers: [supplier.id],
  token: TOKEN,
  capPerCommitment: dollars(500),
  capOpenReserves: dollars(1000),
  dailyLimit: dollars(5000),
  expiry: BigInt(Math.floor(Date.now() / 1000)) + 30n * 86_400n,
})
const firstHash = mandateHash(first, domain)
/** The administrator's replacement, which raises the open-reserves limit to $2,000. */
const replacement: Mandate = {
  ...first,
  capOpenReserves: dollars(2000),
  nonce: first.nonce + 1n,
  replaces: firstHash,
}
const replacementHash = mandateHash(replacement, domain)
const served = async (...mandates: Mandate[]) => servedBy(signer, ...mandates)
const servedBy = async (by: typeof signer, ...mandates: Mandate[]) => {
  const [current, ...earlier] = await Promise.all(
    mandates.map((m): Promise<Signed<Mandate>> => signMandate(m, domain, by)),
  )
  return JSON.parse(JSON.stringify(toWire({ current, earlier })))
}

async function started() {
  const store = memoryStore()
  await saveAgentItem(store, {
    agentKey: agentHex,
    business: {
      chainId: deployment.chainId,
      apiUrl: deployment.apiUrl,
      factory: deployment.factory,
      token: TOKEN,
      account: root.address,
      lock: LOCK,
      businessId: 'sandbox-business',
    },
    mandate: await signMandate(first, domain, signer),
    mandateHash: firstHash,
    keyAuthorizedIn: `0x${'ab'.repeat(32)}`,
    suppliers: [supplier],
  })
  // An API with no mandates route answers 404, as one from before replacements does, and a
  // supplier counts as reached when anything asks it.
  const fetch = (async (input: string | URL | Request) => {
    if (!String(input).endsWith(SANDBOX_PATHS.agentMandates)) {
      chain.supplierAsked++
      return new Response('{}', { status: 500 })
    }
    if (chain.served === 'refused') {
      return Response.json({ error: { code: 'request.invalid' } }, { status: 400 })
    }
    return chain.served
      ? Response.json(chain.served)
      : Response.json({ error: { code: 'request.invalid' } }, { status: 404 })
  }) as typeof globalThis.fetch
  return sandboxAgent({ store, deployment, session: null, fetch, log: () => {} })
}

const booking = (reserve: number) => ({
  supplier: supplier.id,
  resource: { gpu: 'H100', count: 8, hours: 1 },
  reserve,
})

beforeEach(async () => {
  chain.open = new Map([
    [firstHash.toLowerCase(), dollars(300)],
    [replacementHash.toLowerCase(), dollars(500)],
  ])
  chain.witness = firstHash
  chain.served = await served(replacement, first)
  chain.supplierAsked = 0
  vi.restoreAllMocks()
})

/** Whether the agent refuses to check or book, as it does while it can't trust its mandates. */
const stopped = async (a: Awaited<ReturnType<typeof started>>) =>
  expect(await a.check(booking(100))).toMatchObject({
    passes: false,
    code: 'service.unavailable',
    layer: 'avow',
  })

describe('an agent whose administrator replaced its mandate', () => {
  it('acts under the replacement Avow serves, and counts what the first mandate still holds', async () => {
    const a = await started()
    expect(a.mandateHash).toBe(replacementHash)
    expect(a.authority).toBe(2000)
    expect(await a.left()).toBe(1200)
    // $900 open under the first mandate and $700 under the replacement leaves $400 of $2,000.
    chain.open.set(firstHash.toLowerCase(), dollars(900))
    chain.open.set(replacementHash.toLowerCase(), dollars(700))
    expect(await a.check(booking(400))).toMatchObject({ passes: true })
    expect(await a.check(booking(450))).toMatchObject({
      passes: false,
      code: 'mandate.over_open_reserves_cap',
      layer: 'avow',
      amounts: { left: dollars(400), authority: dollars(2000) },
    })
  })

  it("stops when the chain doesn't start at its key's witness, or skips a link", async () => {
    chain.witness = replacementHash
    const a = await started()
    expect(a.mandateHash).toBe(firstHash)
    await stopped(a)
    chain.witness = firstHash
    const middle = { ...replacement, capOpenReserves: dollars(1500) }
    chain.served = await served(
      { ...replacement, nonce: 9n, replaces: mandateHash(middle, domain) },
      first,
    )
    await stopped(await started())
  })

  it("stops when the current mandate isn't the business account's", async () => {
    const stranger = Account.fromSecp256k1(generatePrivateKey())
    chain.served = await servedBy(accountSigner(root.address, stranger), replacement, first)
    const a = await started()
    expect(a.mandateHash).toBe(firstHash)
    await stopped(a)
  })

  it('stops when Avow refuses the read, and carries on once a later read succeeds', async () => {
    chain.served = 'refused'
    const a = await started()
    await stopped(a)
    chain.served = await served(replacement, first)
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000)
    expect(await a.check(booking(100))).toMatchObject({ passes: true })
    expect(a.mandateHash).toBe(replacementHash)
  })

  it('keeps the mandate it enrolled with when Avow has no mandates route yet', async () => {
    chain.served = null
    const a = await started()
    expect(a.mandateHash).toBe(firstHash)
    expect(await a.left()).toBe(700)
    expect(await a.check(booking(100))).toMatchObject({ passes: true })
  })

  it('never goes back to a mandate the administrator replaced, within one run', async () => {
    const third: Mandate = {
      ...replacement,
      nonce: replacement.nonce + 1n,
      replaces: replacementHash,
    }
    chain.served = await served(third, replacement, first)
    const a = await started()
    expect(a.mandateHash).toBe(mandateHash(third, domain))
    chain.served = await served(replacement, first)
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000)
    await stopped(a)
    expect(a.mandateHash).toBe(mandateHash(third, domain))
  })

  it('refuses a booking over the total across its mandates before it asks the supplier', async () => {
    chain.open.set(firstHash.toLowerCase(), dollars(900))
    chain.open.set(replacementHash.toLowerCase(), dollars(700))
    const a = await started()
    await expect(a.book(booking(450))).rejects.toMatchObject({
      code: 'mandate.over_open_reserves_cap',
      layer: 'avow',
    })
    expect(chain.supplierAsked).toBe(0)
  })
})
