import { dollars } from '@avow-finance/spec'
import { decodeFunctionData } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { Abis, Account, Addresses } from 'viem/tempo'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const sent = vi.hoisted(() => [] as { calls: { to: string; data: string }[] }[])
vi.mock('../send.js', () => ({
  sendOwn: async (args: { calls: { to: string; data: string }[] }) => {
    sent.push({ calls: args.calls })
    return { transactionHash: `0x${'ab'.repeat(32)}` }
  },
}))

const { authorizeSandboxKey, sandboxMandate } = await import('./mandate.js')

const root = Account.fromSecp256k1(generatePrivateKey())
const agent = Account.fromP256(generatePrivateKey(), { access: root })
const LOCK = '0x00000000000000000000000000000000000000b1'
const TOKEN = '0x20c00000000000000000000058fbf8a39a171185'

const authorize = (suppliers: { account: `0x${string}`; businessId: string }[]) =>
  authorizeSandboxKey({
    deployment: { chainId: 42431 },
    // The transaction is caught above, so nothing reads the chain.
    client: {} as never,
    root,
    agent,
    lock: LOCK,
    mandate: sandboxMandate({
      businessId: 'sandbox-customer',
      agentId: 'agt_test',
      account: root.address,
      agentKey: agent.accessKeyAddress,
      suppliers: suppliers.map((s) => s.businessId),
      token: TOKEN,
      capPerCommitment: dollars(10),
      capOpenReserves: dollars(30),
      expiry: 1_900_000_000n,
    }),
    suppliers: suppliers as never,
  })

describe('authorizeSandboxKey', () => {
  beforeEach(() => {
    sent.length = 0
  })

  it('gives a mandate that names no supplier one call that only reads the new key', async () => {
    await authorize([])
    const calls = sent[0]?.calls ?? []
    expect(calls).toHaveLength(1)
    expect(calls[0]?.to.toLowerCase()).toBe(Addresses.accountKeychain.toLowerCase())
    const read = decodeFunctionData({
      abi: Abis.accountKeychain,
      data: calls[0]?.data as `0x${string}`,
    })
    expect(read.functionName).toBe('getKey')
    expect((read.args ?? []).map((a) => String(a).toLowerCase())).toEqual([
      root.address.toLowerCase(),
      agent.accessKeyAddress.toLowerCase(),
    ])
  })

  it('adds nothing when the transaction already approves a supplier', async () => {
    await authorize([
      { account: '0x00000000000000000000000000000000000000c1', businessId: 'avow-demo-gpu' },
    ])
    const calls = sent[0]?.calls ?? []
    expect(calls).toHaveLength(1)
    expect(calls[0]?.to.toLowerCase()).toBe(LOCK)
  })

  it("authorizes a key known only by its address and type, as a console does for a developer's agent", async () => {
    const elsewhere = { accessKeyAddress: agent.accessKeyAddress, keyType: agent.keyType }
    const authorized = await authorizeSandboxKey({
      deployment: { chainId: 42431 },
      client: {} as never,
      root,
      agent: elsewhere,
      lock: LOCK,
      mandate: sandboxMandate({
        businessId: 'sandbox-customer',
        agentId: 'agt_test',
        account: root.address,
        agentKey: agent.accessKeyAddress,
        suppliers: [],
        token: TOKEN,
        capPerCommitment: dollars(10),
        capOpenReserves: dollars(30),
        expiry: 1_900_000_000n,
      }),
      suppliers: [],
    })
    expect(authorized.mandate.message.agentKey).toBe(agent.accessKeyAddress)
    expect(authorized.keyAuthorizedIn).toBe(`0x${'ab'.repeat(32)}`)
  })
})
