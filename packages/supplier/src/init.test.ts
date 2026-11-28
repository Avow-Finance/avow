import { readApiBody, supplierRegistrationBody, toWire } from '@avow-finance/spec'
import type { Address } from 'viem'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initSupplier } from './init.js'
import type { SupplierStore } from './store.js'
import { tempStore } from './test/fixtures.js'

let store: SupplierStore
let remove: () => void
beforeEach(() => {
  ;({ store, remove } = tempStore())
})
afterEach(() => remove())

const deployment = {
  chainId: 42431,
  apiUrl: 'https://api.sandbox.example',
  factory: '0x0000000000000000000000000000000000000fac' as Address,
}

/**
 * A stand-in for Avow's supplier registration. It holds one supplier for each account and answers
 * a repeat of the same addresses with it, or refuses every registration with the reason it's given.
 */
function sandboxApi(refuse?: string) {
  const held = new Map<string, { payee: Address; signingKey: Address }>()
  const seen: { account: Address; payee: Address; signingKey: Address }[] = []
  const fetcher = (async (_url: string | URL | Request, init: RequestInit = {}) => {
    const read = readApiBody(init.body as Uint8Array)
    if (!read.ok) throw new Error(`unreadable: ${read.reason}`)
    const { registration: r } = supplierRegistrationBody.parse(read.value)
    seen.push({ account: r.account, payee: r.payee, signingKey: r.signingKey })
    if (refuse) {
      return new Response(JSON.stringify({ error: { reason: refuse, message: 'Refused.' } }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      })
    }
    const account = r.account.toLowerCase()
    if (!held.has(account)) held.set(account, { payee: r.payee, signingKey: r.signingKey })
    const supplier = held.get(account) as { payee: Address; signingKey: Address }
    const profile = {
      businessId: `sandbox-${account.slice(2)}`,
      account,
      ...supplier,
      standing: 'sandbox',
      testData: true,
    }
    return new Response(JSON.stringify(toWire(profile)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  return { seen, fetcher }
}

const run = (fetcher: typeof fetch, fund: (address: Address) => Promise<unknown>) =>
  initSupplier({ store, deployment: async () => deployment, fund, fetch: fetcher, log: () => {} })

describe("the supplier's init", () => {
  it('registers its keys with its account as the payout address, and funds the signing key', async () => {
    const api = sandboxApi()
    const funded: Address[] = []
    const profile = await run(api.fetcher, async (a) => funded.push(a))
    const keys = store.keys()
    expect(keys).not.toBeNull()
    expect(profile.account).toBe(api.seen[0]?.account.toLowerCase())
    expect(profile.payee).toBe(profile.account)
    expect(funded).toEqual([api.seen[0]?.signingKey])
  })

  it('keeps its keys when run again, and gets the same supplier back', async () => {
    const api = sandboxApi()
    const first = await run(api.fetcher, async () => {})
    const keys = store.keys()
    const again = await run(api.fetcher, async () => {})
    expect(again).toEqual(first)
    expect(store.keys()).toEqual(keys)
    expect(api.seen).toHaveLength(2)
    expect(api.seen[1]).toEqual(api.seen[0])
  })

  it('says in its own sentence when Avow refuses the keys as taken', async () => {
    const api = sandboxApi('sandbox.taken')
    await expect(run(api.fetcher, async () => {})).rejects.toThrow(
      /^Avow refused these keys as taken \(sandbox\.taken\)\. .* Make new keys by running init with a new STATE_DIR\.$/,
    )
  })

  it('names any other refusal and says to run init again, keeping the keys', async () => {
    const api = sandboxApi('sandbox.closed')
    await expect(run(api.fetcher, async () => {})).rejects.toThrow(
      /\(sandbox\.closed\).* so run init again to register them\.$/,
    )
    expect(store.keys()).not.toBeNull()
  })

  it('says plainly when the faucet fails, after Avow registered the supplier', async () => {
    const api = sandboxApi()
    const failing = async () => {
      throw new Error('HTTP request failed.')
    }
    await expect(run(api.fetcher, failing)).rejects.toThrow(
      /^Moderato's faucet didn't fund the signing key 0x[0-9a-fA-F]{40} \(HTTP request failed\.\)\. Avow registered you as sandbox-[0-9a-f]{40}, and your keys are kept in .*keys\.json, so run init again to ask the faucet again\.$/,
    )
  })
})
