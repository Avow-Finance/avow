import { toWire } from '@avow-finance/spec'
import { type Address, getAddress } from 'viem'
import { describe, expect, it } from 'vitest'
import {
  MODERATO_FACTORIES,
  MODERATO_FACTORY,
  MODERATO_FACTORY_CREATED_IN,
  type TrustedFactory,
} from '../moderato.js'
import { fakeChain } from '../test/fake-chain.js'
import { deployment, LOCK, LOCK_BLOCK } from '../test/sandbox-business.js'
import {
  factoriesToRead,
  loadSandboxDeployment,
  oldestTrustedBlock,
  trustedFactories,
  trustedFactory,
} from './deployment.js'
import { liveKeys, lockCreatedIn } from './keys.js'
import { trustedChainReader, trustedLockReaders } from './trusted-readers.js'

const STRANGER: Address = '0x00000000000000000000000000000000000000ff'

/** A sandbox screen that publishes these settings. */
const publishing =
  (settings: unknown): typeof fetch =>
  async () =>
    new Response(JSON.stringify(toWire(settings)), { status: 200 })

describe('the factories the SDK trusts', () => {
  it('are listed oldest first on Moderato, and there are none on any other chain', () => {
    expect(trustedFactories(42431)).toBe(MODERATO_FACTORIES)
    expect(trustedFactories(1)).toEqual([])
    expect(MODERATO_FACTORIES[0]).toEqual({
      address: MODERATO_FACTORY,
      createdIn: MODERATO_FACTORY_CREATED_IN,
    })
  })

  it('include the factory with the supplier registry, created after the first', () => {
    const registryFactory = trustedFactory(42431, '0xeec6e0c0a212868d4bb7c5857338de57e4ca8b91')
    expect(registryFactory).toEqual({
      address: '0xEeC6E0C0a212868D4BB7C5857338DE57E4Ca8b91',
      createdIn: 45_516_423n,
    })
    // Oldest first, so the scan for live keys still starts at the first factory.
    for (let i = 1; i < MODERATO_FACTORIES.length; i++) {
      expect(MODERATO_FACTORIES[i]?.createdIn).toBeGreaterThan(
        MODERATO_FACTORIES[i - 1]?.createdIn ?? 0n,
      )
    }
    expect(oldestTrustedBlock(42431)).toBe(MODERATO_FACTORY_CREATED_IN)
  })

  it('are what a service on a trusted factory reads, and a service on its own factory reads that one', () => {
    expect(factoriesToRead(42431, MODERATO_FACTORY)).toEqual(
      MODERATO_FACTORIES.map((f) => f.address),
    )
    expect(factoriesToRead(42431, STRANGER)).toEqual([STRANGER])
    expect(factoriesToRead(1, MODERATO_FACTORY)).toEqual([MODERATO_FACTORY])
  })

  it("can't be changed by anything else running in the process", () => {
    expect(() =>
      (MODERATO_FACTORIES as TrustedFactory[]).push(MODERATO_FACTORIES[0] as never),
    ).toThrow(TypeError)
    expect(() => {
      ;(MODERATO_FACTORIES[0] as { address: Address }).address = STRANGER
    }).toThrow(TypeError)
    expect(trustedFactory(42431, STRANGER)).toBeNull()
  })

  it('give a reader over all of them, and one lock reader each, on a chain the SDK trusts', () => {
    const client = fakeChain({
      factory: MODERATO_FACTORY,
      account: STRANGER,
      lock: LOCK,
      lockBlock: LOCK_BLOCK,
      latest: LOCK_BLOCK,
    }).client
    expect(trustedChainReader(client, 42431)).not.toBeNull()
    expect(trustedChainReader(client, 1)).toBeNull()
    expect(trustedLockReaders(client, 42431).map((r) => r.factory)).toEqual(
      MODERATO_FACTORIES.map((f) => f.address),
    )
    expect(trustedLockReaders(client, 1)).toEqual([])
  })

  it('find a factory by address in any case, and only on its own chain', () => {
    expect(trustedFactory(42431, MODERATO_FACTORY.toLowerCase() as Address)).toEqual(
      MODERATO_FACTORIES[0],
    )
    expect(trustedFactory(42431, STRANGER)).toBeNull()
    expect(trustedFactory(1, MODERATO_FACTORY)).toBeNull()
  })
})

describe('loading the sandbox deployment', () => {
  it('takes settings that name a trusted factory', async () => {
    const loaded = await loadSandboxDeployment(
      'https://try.testnet.avow.finance',
      publishing(deployment),
    )
    expect(loaded.factory.toLowerCase()).toBe(MODERATO_FACTORY.toLowerCase())
  })

  it('refuses settings that name any other factory, and says which it trusts', async () => {
    await expect(
      loadSandboxDeployment(
        'https://try.testnet.avow.finance',
        publishing({ ...deployment, factory: STRANGER }),
      ),
    ).rejects.toThrow(`the SDK trusts only ${MODERATO_FACTORY}`)
  })
})

describe('where the scan for live keys starts', () => {
  it('is the oldest trusted factory, so a key authorized for a lock from an earlier factory is found', async () => {
    const oldKey: Address = getAddress('0x00000000000000000000000000000000000000a1')
    const chain = fakeChain({
      factory: MODERATO_FACTORY,
      account: STRANGER,
      lock: LOCK,
      lockBlock: LOCK_BLOCK,
      latest: LOCK_BLOCK + 10n,
      // A key from the account's earlier lock, authorized before this lock was created.
      keys: [{ key: oldKey, block: MODERATO_FACTORY_CREATED_IN + 5n }],
    })
    expect(oldestTrustedBlock(42431)).toBe(MODERATO_FACTORY_CREATED_IN)
    expect(await liveKeys(chain.client, STRANGER, oldestTrustedBlock(42431))).toContain(oldKey)
    // Starting at this lock's block would have missed it.
    expect(await liveKeys(chain.client, STRANGER, LOCK_BLOCK)).not.toContain(oldKey)
    expect(() => oldestTrustedBlock(1)).toThrow('trusts no factory on chain 1')
  })
})

describe('finding the block a lock was created in', () => {
  it("starts from the creation block of the lock's own factory", async () => {
    const chain = fakeChain({
      factory: MODERATO_FACTORY,
      account: STRANGER,
      lock: LOCK,
      lockBlock: MODERATO_FACTORY_CREATED_IN,
      latest: MODERATO_FACTORY_CREATED_IN + 10n,
    })
    expect(
      await lockCreatedIn({
        client: chain.client,
        factory: MODERATO_FACTORY,
        account: STRANGER,
        lock: LOCK,
      }),
    ).toBe(MODERATO_FACTORY_CREATED_IN)
    expect(chain.ranges.at(-1)?.[0]).toBe(MODERATO_FACTORY_CREATED_IN)
  })

  it("refuses a factory whose creation block the SDK doesn't know", async () => {
    await expect(
      lockCreatedIn({
        client: { getBlockNumber: async () => 0n } as never,
        factory: STRANGER,
        account: STRANGER,
        lock: STRANGER,
      }),
    ).rejects.toThrow("isn't one the SDK knows the creation block of")
  })
})
