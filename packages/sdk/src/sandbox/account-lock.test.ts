import { type Address, getAddress, isAddressEqual } from 'viem'
import { describe, expect, it } from 'vitest'
import { FACTORY_ABI } from '../lock.js'
import { MODERATO_FACTORIES } from '../moderato.js'
import { accountLock } from './account-lock.js'
import { madeOn } from './deployment.js'

const ACCOUNT: Address = getAddress('0x00000000000000000000000000000000000000ac')
const [FIRST, SECOND] = MODERATO_FACTORIES.map((f) => f.address) as [Address, Address]
const UNTRUSTED: Address = getAddress('0x00000000000000000000000000000000000000fa')

/** Each factory's lock for the account is an address of its own, and only the listed ones exist. */
const lockFrom = (factory: Address): Address =>
  getAddress(`0x${factory.slice(2, 22)}${'0'.repeat(20)}`) as Address

function chain(made: Address[]) {
  const asked: Address[] = []
  return {
    asked,
    client: {
      readContract: async (call: {
        address: Address
        abi: unknown
        functionName: string
        args: unknown[]
      }) => {
        expect(call.functionName).toBe('lockAddress')
        expect(call.abi).toBe(FACTORY_ABI)
        expect(call.args).toEqual([ACCOUNT])
        asked.push(call.address)
        return lockFrom(call.address)
      },
      getCode: async ({ address }: { address: Address }) =>
        made.some((f) => isAddressEqual(lockFrom(f), address)) ? ('0x6080' as const) : undefined,
    } as never,
  }
}

describe("an account's lock", () => {
  it('is the one an earlier trusted factory made, when the sandbox has moved to a newer one', async () => {
    const c = chain([FIRST])
    expect(
      await accountLock({ client: c.client, chainId: 42431, current: SECOND, account: ACCOUNT }),
    ).toEqual({ factory: FIRST, lock: lockFrom(FIRST), made: true })
  })

  it('is the oldest one when more than one trusted factory made a lock, as Avow registered it first', async () => {
    const c = chain([FIRST, SECOND])
    const found = await accountLock({
      client: c.client,
      chainId: 42431,
      current: SECOND,
      account: ACCOUNT,
    })
    expect(found.factory).toBe(FIRST)
  })

  it("is the current factory's lock, not yet made, when no trusted factory made one", async () => {
    const c = chain([])
    expect(
      await accountLock({ client: c.client, chainId: 42431, current: SECOND, account: ACCOUNT }),
    ).toEqual({ factory: SECOND, lock: lockFrom(SECOND), made: false })
    expect(c.asked).toEqual([FIRST, SECOND])
  })

  it('asks only the current factory on a chain where the SDK trusts none', async () => {
    const c = chain([])
    const found = await accountLock({
      client: c.client,
      chainId: 1,
      current: UNTRUSTED,
      account: ACCOUNT,
    })
    expect(found).toEqual({ factory: UNTRUSTED, lock: lockFrom(UNTRUSTED), made: false })
    expect(c.asked).toEqual([UNTRUSTED])
  })
})

describe('a business made on a deployment', () => {
  const deployment = {
    chainId: 42431,
    apiUrl: 'https://api.testnet.avow.finance',
    factory: SECOND,
    token: '0x20c00000000000000000000058fbF8a39A171185',
  } as never
  const business = (factory: Address) =>
    ({
      chainId: 42431,
      apiUrl: 'https://api.testnet.avow.finance',
      factory,
      token: '0x20c00000000000000000000058fbF8a39A171185',
      account: ACCOUNT,
      lock: lockFrom(factory),
      businessId: 'sandbox-x',
    }) as never

  it('still counts when its lock is from an earlier trusted factory', () => {
    expect(madeOn(business(FIRST), deployment)).toBe(true)
    expect(madeOn(business(SECOND), deployment)).toBe(true)
  })

  it("doesn't count when its lock is from a factory the SDK doesn't trust", () => {
    expect(madeOn(business(UNTRUSTED), deployment)).toBe(false)
  })
})
