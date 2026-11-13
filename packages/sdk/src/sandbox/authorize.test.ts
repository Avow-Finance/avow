import { dollars, mandateHash } from '@avow-finance/spec'
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

  it("puts the key on in the root's own transaction, bound to the mandate, before the suppliers", async () => {
    const authorized = await authorize([
      { account: '0x00000000000000000000000000000000000000c1', businessId: 'avow-demo-gpu' },
    ])
    const calls = sent[0]?.calls ?? []
    expect(calls.map((c) => c.to.toLowerCase())).toEqual([
      Addresses.accountKeychain.toLowerCase(),
      LOCK,
    ])
    const put = decodeFunctionData({
      abi: Abis.accountKeychain,
      data: calls[0]?.data as `0x${string}`,
    })
    expect(put.functionName).toBe('authorizeKey')
    const [keyId, signatureType, config, witness] = put.args as unknown as [
      string,
      number,
      {
        expiry: bigint
        enforceLimits: boolean
        limits: readonly { token: string; amount: bigint; period: bigint }[]
        allowAnyCalls: boolean
        allowedCalls: readonly {
          target: string
          selectorRules: readonly { selector: string; recipients: readonly string[] }[]
        }[]
      },
      string,
    ]
    expect(keyId.toLowerCase()).toBe(agent.accessKeyAddress.toLowerCase())
    // The agent's key is a P256 key here, which Tempo numbers 1.
    expect(signatureType).toBe(1)
    expect(config.expiry).toBe(1_900_000_000n)
    expect(config.enforceLimits).toBe(true)
    expect(config.allowAnyCalls).toBe(false)
    expect(config.limits.map((l) => [l.token.toLowerCase(), l.period])).toEqual([[TOKEN, 86_400n]])
    // The key approves the token only to the lock, and calls only the lock's reserve.
    expect(config.allowedCalls.map((c) => c.target.toLowerCase())).toEqual([TOKEN, LOCK])
    expect(
      config.allowedCalls[0]?.selectorRules[0]?.recipients.map((r) => r.toLowerCase()),
    ).toEqual([LOCK])
    // The witness is the mandate's hash, which is what binds the key to exactly this mandate.
    expect(witness).toBe(authorized.mandateHash)
    expect(authorized.mandateHash).toBe(
      mandateHash(authorized.mandate.message, { chainId: 42431, verifyingContract: LOCK }),
    )
  })

  it("names the transaction as the account's word on the mandate, which carries no signature", async () => {
    const authorized = await authorize([])
    expect(sent[0]?.calls).toHaveLength(1)
    expect(authorized.mandate).not.toHaveProperty('signature')
    expect(authorized.mandate).toMatchObject({
      type: 'Mandate',
      chainId: 42431,
      lock: LOCK,
      authorizedIn: `0x${'ab'.repeat(32)}`,
    })
  })

  it('refuses a mandate for another account than the root key', async () => {
    await expect(
      authorizeSandboxKey({
        deployment: { chainId: 42431 },
        client: {} as never,
        root,
        agent,
        lock: LOCK,
        mandate: {
          ...sandboxMandate({
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
          account: '0x00000000000000000000000000000000000000d1',
        },
        suppliers: [],
      }),
    ).rejects.toThrow('another account')
    expect(sent).toHaveLength(0)
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
