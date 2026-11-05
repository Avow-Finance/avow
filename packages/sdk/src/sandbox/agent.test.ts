import { type AvowDomain, dollars, mandateHash } from '@avow-finance/spec'
import { generatePrivateKey } from 'viem/accounts'
import { Account } from 'viem/tempo'
import { describe, expect, it } from 'vitest'
import { AvowApiError } from '../http.js'
import { SendError } from '../send.js'
import { accountSigner, signMandate } from '../sign.js'
import { fundingRefusal, Refusal, relayReason, sandboxAgent, setSandboxPlatform } from './agent.js'
import { loadBusinessItem, saveBusinessItem } from './business-store.js'
import { sandboxMandate } from './mandate.js'
import {
  addCommitment,
  loadAgentItem,
  loadCommitments,
  memoryStore,
  saveAgentItem,
} from './store.js'
import { checkSuppliers } from './suppliers.js'
import { openKey, sealKey } from './vault.js'

// Every key is generated for the run and held only in memory.
const supplier = { id: 'avow-demo-gpu', url: 'https://supplier.testnet.avow.finance' }
const relayError = (reason: 'sponsorship.rate_limited' | 'sponsorship.budget_spent') =>
  new AvowApiError('refused', {
    status: 429,
    reason,
    requestId: `0x${'00'.repeat(32)}`,
    definite: true,
  })

describe('Refusal', () => {
  it('reads as the sentence the screen shows, with the code, layer and amounts apart', () => {
    const amounts = {
      needed: dollars(400),
      left: dollars(300),
      authority: dollars(500),
      capPerCommitment: dollars(500),
      dailyLimit: dollars(500),
      dailyLeft: dollars(300),
    }
    const r = new Refusal({ code: 'mandate.over_open_reserves_cap', layer: 'avow', amounts })
    expect(r).toBeInstanceOf(Error)
    expect(r).toMatchObject({ code: 'mandate.over_open_reserves_cap', layer: 'avow', amounts })
    expect(r.message).toBe(
      "This booking needs $400 and your agent has $300 left of its $500 held at once, so Avow refused the reserve and no money moved. The lock takes no reserve without Avow's approval, and your agent's key moves at most $500 a day, a limit your business set on chain. The same booking can pass once enough of what the agent holds is released, when a booking ends or is cancelled, or once the business raises the authority.",
    )
  })

  it('blames a refused funding on whoever refused it', () => {
    const sent = (cause: unknown) =>
      new Error('funding failed', {
        cause: new SendError('send failed', 'failed', { hashes: [], signings: 1 }, { cause }),
      })
    expect(relayReason(sent(relayError('sponsorship.rate_limited')))).toBe(
      'sponsorship.rate_limited',
    )
    expect(fundingRefusal(sent(relayError('sponsorship.budget_spent')))).toEqual({
      code: 'sponsorship.budget_spent',
      layer: 'relay',
    })
    const keychain = new Error(
      'Execution reverted with reason: Account keychain error: SpendingLimitExceeded(SpendingLimitExceeded).',
    )
    expect(fundingRefusal(sent(keychain))).toEqual({
      code: 'keychain.over_daily_limit',
      layer: 'keychain',
    })
    expect(
      fundingRefusal(sent(new Error(`The transaction 0x${'ab'.repeat(32)} reverted`))),
    ).toEqual({
      code: 'chain.reserve_missing',
      layer: 'lock',
    })
    expect(fundingRefusal(sent(new Error('the node stopped answering')))).toEqual({
      code: 'chain.reserve_missing',
      layer: 'unknown',
    })
  })
})

describe("the sandbox's items", () => {
  it("keeps the business's key sealed, and opens it only with the passphrase", async () => {
    const root = Account.fromSecp256k1(generatePrivateKey())
    const privateKey = generatePrivateKey()
    const sealed = await sealKey(privateKey, 'correct horse battery', root.address)
    const store = memoryStore()
    await saveBusinessItem(store, {
      account: root.address,
      key: sealed,
      business: null,
    })
    const text = (await store.read('business')) as string
    expect(text).not.toContain(privateKey.slice(2))
    const item = await loadBusinessItem(store)
    expect(await openKey(item?.key ?? sealed, 'correct horse battery', root.address)).toBe(
      privateKey,
    )
    await expect(openKey(sealed, 'wrong horse battery', root.address)).rejects.toThrow(
      "doesn't open",
    )
    // A sealed key opens only for the account it was sealed for.
    const other = Account.fromSecp256k1(generatePrivateKey()).address
    await expect(openKey(sealed, 'correct horse battery', other)).rejects.toThrow("doesn't open")
    await expect(sealKey(privateKey, 'short', root.address)).rejects.toThrow(RangeError)
  })

  it("reads back the agent's item and the commitments it made", async () => {
    const root = Account.fromSecp256k1(generatePrivateKey())
    const agentKey = generatePrivateKey()
    const agent = Account.fromSecp256k1(agentKey, { access: root.address })
    const lock = '0x00000000000000000000000000000000000010c4'
    const domain: AvowDomain = { chainId: 42431, verifyingContract: lock }
    const message = sandboxMandate({
      businessId: 'sandbox-business',
      agentId: 'agt_test',
      account: root.address,
      agentKey: agent.accessKeyAddress,
      suppliers: [supplier.id],
      token: '0x20c00000000000000000000058fbf8a39a171185',
      capPerCommitment: dollars(500),
      capOpenReserves: dollars(500),
      expiry: 1_800_000_000n,
    })
    const mandate = await signMandate(message, domain, accountSigner(root.address, root))
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
    const hash = mandateHash(message, domain)
    await saveAgentItem(store, {
      agentKey,
      business,
      mandate,
      mandateHash: hash,
      keyAuthorizedIn: `0x${'ab'.repeat(32)}`,
      suppliers: [supplier],
    })
    const item = await loadAgentItem(store)
    expect(item?.agentKey).toBe(agentKey)
    expect(item && mandateHash(item.mandate.message, domain)).toBe(hash)
    expect(item?.suppliers).toEqual([supplier])
    const reference = {
      kind: 'commitment',
      chainId: 42431,
      lock,
      commitmentId: `0x${'11'.repeat(32)}`,
      side: 'buyer',
      termsHash: `0x${'22'.repeat(32)}`,
    } as const
    await addCommitment(store, {
      reference,
      amount: dollars(200),
      supplier: supplier.id,
      mandateHash: hash,
      madeAt: 1_800_000_000n,
    })
    expect(await loadCommitments(store)).toEqual([
      {
        reference,
        amount: dollars(200),
        supplier: supplier.id,
        mandateHash: hash,
        madeAt: 1_800_000_000n,
      },
    ])
  })
})

describe('sandboxAgent', () => {
  it('checks the suppliers a business names', () => {
    expect(checkSuppliers([supplier])).toEqual([supplier])
    expect(() => checkSuppliers([])).toThrow(RangeError)
    expect(() => checkSuppliers([supplier, supplier])).toThrow(RangeError)
    expect(() => checkSuppliers([{ id: 'a b', url: supplier.url }])).toThrow(RangeError)
    expect(() => checkSuppliers([{ id: 'x', url: 'ftp://example.com' }])).toThrow(RangeError)
  })

  it('needs a store, and an agent its business enrolled', async () => {
    setSandboxPlatform({})
    await expect(sandboxAgent()).rejects.toThrow(/folder its business set up/)
    await expect(sandboxAgent({ store: memoryStore() })).rejects.toThrow(/no agent yet/)
  })
})
