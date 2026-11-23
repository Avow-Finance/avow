import { type Address, erc20Abi, getAddress, isAddressEqual } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { Account } from 'viem/tempo'
import { describe, expect, it } from 'vitest'
import { FACTORY_ABI } from '../lock.js'
import { MODERATO_FACTORIES } from '../moderato.js'
import { createSandboxBusiness } from './business.js'

const [FIRST, SECOND] = MODERATO_FACTORIES.map((f) => f.address) as [Address, Address]
const TOKEN: Address = '0x20c00000000000000000000058fbF8a39A171185'
const API = 'https://api.testnet.avow.finance'

/** Each factory gives each account a lock address of its own. */
const lockOf = (factory: Address, account: Address): Address =>
  getAddress(`0x${factory.slice(2, 22)}${account.slice(22, 42).toLowerCase()}`) as Address

/**
 * A chain where the account holds ample fees and test dollars, and the locks of these factories,
 * for the account, are on chain. It records every transaction sent, and Avow's sandbox registers
 * the business.
 */
function world(account: Address, made: Address[]) {
  const sent: unknown[] = []
  const client = {
    readContract: async (call: { address: Address; abi: unknown; args: [Address] }) => {
      if (call.abi === FACTORY_ABI) return lockOf(call.address, call.args[0])
      expect(call.abi).toBe(erc20Abi)
      return 10n ** 12n
    },
    getCode: async ({ address }: { address: Address }) =>
      made.some((f) => isAddressEqual(lockOf(f, account), address))
        ? ('0x6080' as const)
        : undefined,
    sendTransaction: async (tx: unknown) => {
      sent.push(tx)
      throw new Error('No lock should be created here')
    },
  } as never
  const registered: string[] = []
  const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    registered.push(new Headers(init?.headers).get('authorization') ?? '')
    return new Response(
      JSON.stringify({
        businessId: `sandbox-${account.slice(2).toLowerCase()}`,
        testData: true,
        payout: { transactionHash: `0x${'12'.repeat(32)}`, amount: '1500000000' },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as typeof globalThis.fetch
  return { client, fetch, sent, registered }
}

const deployment = { chainId: 42431, apiUrl: API, factory: SECOND, token: TOKEN }

describe('making a sandbox business', () => {
  it('keeps the lock it names from an earlier factory, creating none', async () => {
    const root = Account.fromSecp256k1(generatePrivateKey())
    const w = world(root.address, [FIRST])
    const steps: string[] = []
    const made = await createSandboxBusiness({
      deployment,
      client: w.client,
      root,
      legalName: 'Kept Co',
      country: 'US',
      lock: { factory: FIRST, lock: lockOf(FIRST, root.address) },
      fetch: w.fetch,
      onStep: (s) => steps.push(s.step),
    })
    expect(made).toMatchObject({
      factory: FIRST,
      lock: lockOf(FIRST, root.address),
      lockCreatedIn: null,
    })
    expect(w.sent).toEqual([])
    expect(w.registered).toHaveLength(1)
    expect(steps).toEqual(['fees', 'lock', 'registered', 'funded'])
  })

  it("refuses a named lock that isn't the account's own from a trusted factory, before registering", async () => {
    const root = Account.fromSecp256k1(generatePrivateKey())
    const other = Account.fromSecp256k1(generatePrivateKey()).address
    const w = world(root.address, [FIRST])
    const attempt = (lock: { factory: Address; lock: Address }) =>
      createSandboxBusiness({
        deployment,
        client: w.client,
        root,
        legalName: 'Kept Co',
        country: 'US',
        lock,
        fetch: w.fetch,
      })
    await expect(attempt({ factory: FIRST, lock: lockOf(FIRST, other) })).rejects.toThrow(
      "isn't a lock a trusted factory made",
    )
    // The second factory's lock for the account isn't on chain.
    await expect(attempt({ factory: SECOND, lock: lockOf(SECOND, root.address) })).rejects.toThrow(
      "isn't a lock a trusted factory made",
    )
    expect(w.registered).toEqual([])
  })

  it("takes the current factory's lock for a new business, whatever another factory holds for it", async () => {
    const root = Account.fromSecp256k1(generatePrivateKey())
    // Someone created the account's lock at the first factory, and the current one's is there too.
    const w = world(root.address, [FIRST, SECOND])
    const made = await createSandboxBusiness({
      deployment,
      client: w.client,
      root,
      legalName: 'New Co',
      country: 'US',
      fetch: w.fetch,
    })
    expect(made).toMatchObject({ factory: SECOND, lock: lockOf(SECOND, root.address) })
  })
})
