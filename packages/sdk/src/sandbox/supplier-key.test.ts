import {
  readApiBody,
  registrationDigest,
  registrationDomain,
  supplierRegistrationBody,
  toWire,
  verifyApiRequest,
} from '@avow-finance/spec'
import { type Address, isAddressEqual, recoverAddress } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { Account } from 'viem/tempo'
import { describe, expect, it } from 'vitest'
import { deployment, enrolledBusiness, PASSPHRASE } from '../test/sandbox-business.js'
import type { SandboxClient } from './business.js'
import { memoryStore, type StoredBusiness } from './store.js'
import { ensureSandboxSupplier, loadSupplierItem, registerSandboxSupplier } from './supplier-key.js'
import { openKey } from './vault.js'

const NOW = BigInt(Math.floor(Date.now() / 1000))

/** A node whose every balance is ample, so no fees are asked of the faucet. */
const funded = { readContract: async () => 10n ** 12n } as unknown as SandboxClient

/** A stand-in for Avow's supplier registration, which answers as the API does and records each. */
function sandboxApi(
  answer?: (registered: { payee: Address; signingKey: Address }) => object,
  audience: string = deployment.apiUrl,
) {
  const seen: { path: string; signer: Address; lock: Address; body: unknown }[] = []
  const fetcher = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const path = new URL(String(url)).pathname
    const bytes = init.body as Uint8Array
    const verified = verifyApiRequest({
      audience,
      chainId: deployment.chainId,
      method: 'POST',
      path,
      body: bytes,
      authorization: new Headers(init.headers).get('authorization'),
    })
    if (!verified.ok) throw new Error(`unsigned: ${verified.reason}`)
    const read = readApiBody(bytes)
    if (!read.ok) throw new Error(`unreadable: ${read.reason}`)
    const body = read.value
    seen.push({
      path,
      signer: verified.value.credentials.signer,
      lock: verified.value.credentials.lock,
      body,
    })
    const parsed = supplierRegistrationBody.parse(body)
    const r = parsed.registration
    const profile = answer?.(r) ?? {
      businessId: 'sandbox-business',
      account: r.account,
      payee: r.payee,
      signingKey: r.signingKey,
      standing: 'sandbox',
      acceptsTestData: true,
      testData: true,
    }
    return new Response(JSON.stringify(toWire(profile)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  return { seen, fetcher }
}

describe('registering the business as a sandbox supplier', () => {
  it('has the root key and the signing key sign the one registration, under the factory', async () => {
    const root = Account.fromSecp256k1(generatePrivateKey())
    const signingKey = privateKeyToAccount(generatePrivateKey())
    const api = sandboxApi()
    const profile = await registerSandboxSupplier({
      deployment,
      root,
      signingKey,
      payee: root.address,
      now: () => NOW,
      fetch: api.fetcher,
    })
    expect(profile).toEqual({
      businessId: 'sandbox-business',
      account: root.address.toLowerCase(),
      payee: root.address.toLowerCase(),
      signingKey: signingKey.address.toLowerCase(),
    })
    const [sent] = api.seen
    expect(sent?.path).toBe('/v1/sandbox/suppliers')
    // The account signs the request, and a supplier has no lock, so it names the factory.
    expect(isAddressEqual(sent?.signer as Address, root.address)).toBe(true)
    expect(isAddressEqual(sent?.lock as Address, deployment.factory)).toBe(true)
    const body = supplierRegistrationBody.parse(sent?.body)
    const hash = registrationDigest(registrationDomain(deployment.chainId, deployment.factory), {
      kind: 'supplier',
      registration: body.registration,
    })
    const byAccount = await recoverAddress({ hash, signature: body.accountSignature })
    const byKey = await recoverAddress({ hash, signature: body.signingKeySignature })
    expect(isAddressEqual(byAccount, root.address)).toBe(true)
    expect(isAddressEqual(byKey, signingKey.address)).toBe(true)
    expect(body.registration).toMatchObject({ environment: 'sandbox', expiry: NOW + 120n })
  })

  it('refuses an answer that names another signing key than the one registered', async () => {
    const root = Account.fromSecp256k1(generatePrivateKey())
    const api = sandboxApi((r) => ({
      businessId: 'sandbox-business',
      account: root.address,
      payee: r.payee,
      signingKey: privateKeyToAccount(generatePrivateKey()).address,
    }))
    await expect(
      registerSandboxSupplier({
        deployment,
        root,
        signingKey: privateKeyToAccount(generatePrivateKey()),
        payee: root.address,
        fetch: api.fetcher,
      }),
    ).rejects.toThrow("didn't register your business as a supplier (message.invalid)")
  })
})

describe("the business's supplier item", () => {
  async function business(): Promise<{
    store: ReturnType<typeof memoryStore>
    stored: StoredBusiness
    openRoot: () => Promise<Account.RootAccount>
    opened: () => number
  }> {
    const b = await enrolledBusiness()
    const stored = JSON.parse((await b.store.read('business')) as string).business
    const sealed = JSON.parse((await b.store.read('business')) as string).key
    let opened = 0
    const openRoot = async () => {
      opened++
      return Account.fromSecp256k1(await openKey(sealed, PASSPHRASE, b.root.address))
    }
    // A business set up before it took jobs has no supplier item yet.
    await b.store.write('supplier', '{}')
    return {
      store: b.store,
      stored: { ...stored, account: stored.account as Address },
      openRoot,
      opened: () => opened,
    }
  }

  it('registers once, opening the root key only then, and is left alone after', async () => {
    const b = await business()
    const api = sandboxApi()
    const first = await ensureSandboxSupplier({
      store: b.store,
      business: b.stored,
      deployment,
      client: funded,
      openRoot: b.openRoot,
      log: () => {},
      fetch: api.fetcher,
    })
    expect(b.opened()).toBe(1)
    expect(await loadSupplierItem(b.store)).toEqual(first)
    const again = await ensureSandboxSupplier({
      store: b.store,
      business: b.stored,
      deployment,
      client: funded,
      openRoot: b.openRoot,
      log: () => {},
      fetch: api.fetcher,
    })
    expect(again).toEqual(first)
    expect(b.opened()).toBe(1)
    expect(api.seen).toHaveLength(1)
  })

  it('never takes a signing key whose address the file doesn’t register', async () => {
    const b = await business()
    const api = sandboxApi()
    const item = await ensureSandboxSupplier({
      store: b.store,
      business: b.stored,
      deployment,
      client: funded,
      openRoot: b.openRoot,
      log: () => {},
      fetch: api.fetcher,
    })
    const edited = JSON.parse((await b.store.read('supplier')) as string)
    edited.signingKey = generatePrivateKey()
    await b.store.write('supplier', JSON.stringify(edited))
    expect(await loadSupplierItem(b.store)).toBeNull()
    expect(item.profile.signingKey).not.toBe(privateKeyToAccount(edited.signingKey).address)
  })

  it('registers the same key again for the same account on a new deployment', async () => {
    const b = await business()
    const api = sandboxApi()
    const first = await ensureSandboxSupplier({
      store: b.store,
      business: b.stored,
      deployment,
      client: funded,
      openRoot: b.openRoot,
      log: () => {},
      fetch: api.fetcher,
    })
    const moved = { ...b.stored, apiUrl: 'https://api.next.testnet.avow.finance' }
    const next = await ensureSandboxSupplier({
      store: b.store,
      business: moved,
      deployment: { ...deployment, apiUrl: moved.apiUrl },
      client: funded,
      openRoot: b.openRoot,
      log: () => {},
      fetch: sandboxApi(undefined, moved.apiUrl).fetcher,
    })
    expect(next.signingKey).toBe(first.signingKey)
    expect(next.business.apiUrl).toBe(moved.apiUrl)
  })
})

describe('a store with no supplier item', () => {
  it('reads as none', async () => {
    expect(await loadSupplierItem(memoryStore())).toBeNull()
  })
})
