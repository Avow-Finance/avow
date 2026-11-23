import { type Address, getAddress, isAddressEqual } from 'viem'
import { describe, expect, it } from 'vitest'
import { FACTORY_ABI } from '../lock.js'
import { MODERATO_FACTORIES } from '../moderato.js'
import { accountLocks, currentLock, isAccountLock } from './account-lock.js'
import { madeOn } from './deployment.js'

const ACCOUNT: Address = getAddress('0x00000000000000000000000000000000000000ac')
const OTHER: Address = getAddress('0x00000000000000000000000000000000000000bd')
const [FIRST, SECOND] = MODERATO_FACTORIES.map((f) => f.address) as [Address, Address]
const UNTRUSTED: Address = getAddress('0x00000000000000000000000000000000000000fa')

/** Each factory gives each account a lock address of its own. */
const lockOf = (factory: Address, account: Address = ACCOUNT): Address =>
  getAddress(`0x${factory.slice(2, 22)}${account.slice(22, 42)}`) as Address

/** A chain where the locks of these factories, for ACCOUNT, are on chain. */
function chain(made: Address[]) {
  return {
    readContract: async (call: {
      address: Address
      abi: unknown
      functionName: string
      args: [Address]
    }) => {
      expect(call.functionName).toBe('lockAddress')
      expect(call.abi).toBe(FACTORY_ABI)
      return lockOf(call.address, call.args[0])
    },
    getCode: async ({ address }: { address: Address }) =>
      made.some((f) => isAddressEqual(lockOf(f), address)) ? ('0x6080' as const) : undefined,
  } as never
}

describe("the current factory's lock", () => {
  it('is what a new business takes, whether or not an earlier factory made one for it', async () => {
    // Anyone can create an account's lock at any factory, so a lock at the first factory says
    // nothing about which one the business has.
    expect(
      await currentLock({ client: chain([FIRST]), factory: SECOND, account: ACCOUNT }),
    ).toEqual({ lock: lockOf(SECOND), made: false })
    expect(
      await currentLock({ client: chain([SECOND]), factory: SECOND, account: ACCOUNT }),
    ).toEqual({ lock: lockOf(SECOND), made: true })
  })
})

describe("an account's locks", () => {
  it('lists every one the given factories made, oldest factory first', async () => {
    expect(
      await accountLocks({
        client: chain([SECOND, FIRST]),
        factories: [FIRST, SECOND],
        account: ACCOUNT,
      }),
    ).toEqual([
      { factory: FIRST, lock: lockOf(FIRST) },
      { factory: SECOND, lock: lockOf(SECOND) },
    ])
    expect(
      await accountLocks({ client: chain([]), factories: [FIRST, SECOND], account: ACCOUNT }),
    ).toEqual([])
  })

  it('asks only the factories it is given', async () => {
    expect(
      await accountLocks({ client: chain([FIRST]), factories: [SECOND], account: ACCOUNT }),
    ).toEqual([])
  })
})

describe('a recorded lock', () => {
  const at = (factory: Address, lock = lockOf(factory)) => ({ factory, lock })
  const holds = (made: Address[], recorded: { factory: Address; lock: Address }) =>
    isAccountLock({ client: chain(made), chainId: 42431, account: ACCOUNT, recorded })

  it('counts when a trusted factory made it for the account, so a business keeps its lock', async () => {
    expect(await holds([FIRST], at(FIRST))).toBe(true)
    expect(await holds([SECOND], at(SECOND))).toBe(true)
  })

  it("keeps counting when someone else creates the account's lock at another factory", async () => {
    // A business set up under the second factory, and a lock someone created for it at the first.
    expect(await holds([FIRST, SECOND], at(SECOND))).toBe(true)
  })

  it("doesn't count when it isn't on chain, isn't the account's, or isn't from a trusted factory", async () => {
    expect(await holds([], at(FIRST))).toBe(false)
    expect(await holds([FIRST], at(FIRST, lockOf(FIRST, OTHER)))).toBe(false)
    expect(await holds([FIRST], { factory: UNTRUSTED, lock: lockOf(FIRST) })).toBe(false)
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
      lock: lockOf(factory),
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
