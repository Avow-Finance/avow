import { toWire } from '@avow-finance/spec'
import type { Address } from 'viem'
import { describe, expect, it } from 'vitest'
import { MODERATO_FACTORIES, MODERATO_FACTORY, MODERATO_FACTORY_CREATED_IN } from '../moderato.js'
import { deployment } from '../test/sandbox-business.js'
import { loadSandboxDeployment, trustedFactories, trustedFactory } from './deployment.js'
import { lockCreatedIn } from './keys.js'

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

describe('finding the block a lock was created in', () => {
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
