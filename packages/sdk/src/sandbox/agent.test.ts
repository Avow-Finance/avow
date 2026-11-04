import { type AvowDomain, dollars, mandateHash } from '@avow-finance/spec'
import { generatePrivateKey } from 'viem/accounts'
import { Account } from 'viem/tempo'
import { describe, expect, it } from 'vitest'
import { AvowApiError } from '../http.js'
import { SendError } from '../send.js'
import { accountSigner, signMandate } from '../sign.js'
import {
  checkSuppliers,
  loadKeys,
  loadState,
  memoryStore,
  Refusal,
  relayReason,
  type SandboxStore,
  sandboxAgent,
  saveState,
  setSandboxPlatform,
} from './agent.js'
import { sandboxMandate } from './mandate.js'

// Every key is generated for the run and held only in memory.
const supplier = { id: 'avow-demo-gpu', url: 'https://supplier.testnet.avow.finance' }

describe('Refusal', () => {
  it('reads as the sentence the screen shows, with the code, layer and amounts apart', () => {
    const amounts = { needed: dollars(400), left: dollars(300), authority: dollars(500) }
    const r = new Refusal({ code: 'mandate.over_open_reserves_cap', layer: 'avow', amounts })
    expect(r).toBeInstanceOf(Error)
    expect(r).toMatchObject({ code: 'mandate.over_open_reserves_cap', layer: 'avow', amounts })
    expect(r.message).toBe(
      'This booking needs $400 and your agent has $300 of authority left, so Avow refused the reserve and no money moved.',
    )
  })

  it("finds the relay's reason under the error that carried it", () => {
    const relay = new AvowApiError('refused', {
      status: 422,
      reason: 'sponsorship.simulation_failed',
      requestId: `0x${'00'.repeat(32)}`,
      definite: true,
    })
    const sent = new SendError(
      'send failed',
      'failed',
      { hashes: [], signings: 1 },
      { cause: relay },
    )
    expect(relayReason(new Error('funding failed', { cause: sent }))).toBe(
      'sponsorship.simulation_failed',
    )
    expect(relayReason(new Error('no reason here'))).toBeNull()
  })
})

describe("the sandbox's keys and state", () => {
  it('makes the keys once and keeps them, and never puts a key in an error', async () => {
    const store = memoryStore()
    const keys = await loadKeys(store)
    expect(await loadKeys(store)).toEqual(keys)
    await store.write('keys', '{"root":"0x1234"}')
    const refused = await loadKeys(store).catch((e: Error) => e.message)
    expect(refused).toMatch(/form it writes/)
    await store.write('keys', `{"root":"${keys.root}",`)
    const unreadable = await loadKeys(store).catch((e: Error) => e.message)
    expect(unreadable).toMatch(/isn't readable/)
    expect(unreadable).not.toContain(keys.root.slice(2))
  })

  it('reads back the business and the signed mandate it saved', async () => {
    const root = Account.fromSecp256k1(generatePrivateKey())
    const agent = Account.fromSecp256k1(generatePrivateKey(), { access: root.address })
    const lock = '0x00000000000000000000000000000000000010c4'
    const domain: AvowDomain = { chainId: 42431, verifyingContract: lock }
    const mandate = await signMandate(
      sandboxMandate({
        businessId: 'sandbox-business',
        agentId: 'agt_test',
        account: root.address,
        agentKey: agent.accessKeyAddress,
        suppliers: [supplier.id],
        token: '0x20c00000000000000000000058fbf8a39a171185',
        capPerCommitment: dollars(500),
        capOpenReserves: dollars(500),
        expiry: 1_800_000_000n,
      }),
      domain,
      accountSigner(root.address, root),
    )
    const business = {
      chainId: 42431,
      apiUrl: 'https://api.testnet.avow.finance',
      factory: '0x8fa7177c84be069df2a51f096ed28d5d661b8283',
      token: '0x20c00000000000000000000058fbf8a39a171185',
      account: root.address,
      lock,
      businessId: 'sandbox-business',
    } as const
    const store = memoryStore()
    const agentState = {
      key: agent.accessKeyAddress,
      mandate,
      keyAuthorizedIn: `0x${'ab'.repeat(32)}`,
    } as const
    await saveState(store, { business, agent: agentState })
    const state = await loadState(store)
    expect(state.business).toEqual(business)
    const read = state.agent?.mandate.message
    expect(read && mandateHash(read, domain)).toBe(mandateHash(mandate.message, domain))
    expect(state.agent?.mandate.signature).toBe(mandate.signature.toLowerCase())
    // A mandate signed for another lock doesn't parse as this business's.
    await saveState(store, {
      business: { ...business, lock: `0x${'0'.repeat(39)}1` },
      agent: agentState,
    })
    expect((await loadState(store)).agent).toBeNull()
  })
})

describe('sandboxAgent', () => {
  it('checks the suppliers it names', () => {
    expect(checkSuppliers([supplier])).toEqual([supplier])
    expect(() => checkSuppliers([])).toThrow(RangeError)
    expect(() => checkSuppliers([supplier, supplier])).toThrow(RangeError)
    expect(() => checkSuppliers([{ id: 'a b', url: supplier.url }])).toThrow(RangeError)
    expect(() => checkSuppliers([{ id: 'x', url: 'ftp://example.com' }])).toThrow(RangeError)
  })

  it('needs a store where no platform gives one, and refuses an authority out of form', async () => {
    setSandboxPlatform({})
    await expect(sandboxAgent({ authority: 500, suppliers: [supplier] })).rejects.toThrow(
      /somewhere to keep/,
    )
    const store: SandboxStore = memoryStore()
    await expect(sandboxAgent({ authority: 0, suppliers: [supplier], store })).rejects.toThrow(
      RangeError,
    )
  })
})
