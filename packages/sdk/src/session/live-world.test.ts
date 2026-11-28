import {
  type ComputeOffer,
  digestOf,
  GPU_RESERVATION,
  JOB_CATEGORY,
  type JobOffer,
  SANDBOX_PATHS,
  type SellerMandate,
  type Signed,
  saleFacts,
  sellerMandateTypedData,
  testnetDemoJobTerms,
  toWire,
} from '@avow-finance/spec'
import { type Address, type Hex, keccak256, recoverAddress, stringToHex } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import { folderWithAgent, json, wire } from '../test/agent-folder.js'
import { deployment, domain, LOCK, supplier } from '../test/sandbox-business.js'

// Tempo's verifier is asked whether the business account signed a digest, which for a secp256k1
// root key is whether the signature recovers to the account.
vi.mock('@avow-finance/spec', async (original) => ({
  ...(await original<typeof import('@avow-finance/spec')>()),
  tempoKeychainCheck:
    () =>
    async ({ signer, digest, signature }: { signer: Address; digest: Hex; signature: Hex }) =>
      (await recoverAddress({ hash: digest, signature })).toLowerCase() === signer.toLowerCase(),
}))
vi.mock('../moderato.js', async (original) => ({
  ...(await original<typeof import('../moderato.js')>()),
  moderatoClient: () => ({ readContract: async () => LOCK }),
}))
// Avow's test customer, which the job demo connects to, as far as booking needs it.
const CUSTOMER = 'avow-test-customer'
vi.mock('../job/customer.js', async (original) => ({
  ...(await original<typeof import('../job/customer.js')>()),
  connectTestCustomer: async () => ({ profile: { businessId: CUSTOMER } }),
}))
// Booking compute goes through the agent, which the test only watches.
const bookings = vi.fn()
const SELLER = 'sandbox-seller'
vi.mock('../sandbox/agent.js', async (original) => ({
  ...(await original<typeof import('../sandbox/agent.js')>()),
  sandboxAgent: async () => ({
    business: { businessId: SELLER, account: owner.account, lock: LOCK },
    bookTerms: bookings,
  }),
}))
const owner = { account: '0x0000000000000000000000000000000000000000' as Address }

const { liveWorld } = await import('./live-world.js')
const { SellerMandateRefusal } = await import('../sandbox/seller-mandate.js')

const id = (word: string): Hex => keccak256(stringToHex(word))
const NOW = BigInt(Math.floor(Date.now() / 1000))

const order = {
  orderId: 'f1'.repeat(16),
  commitmentId: id('commitment-f1'),
  customer: { businessId: CUSTOMER },
  supplierBusinessId: SELLER,
  terms: testnetDemoJobTerms(NOW + 1200n, deployment.arbiter),
  requirement: { template: GPU_RESERVATION, condition: 'accepted', disclosed: 'subject' },
  expiry: NOW + 600n,
} as unknown as JobOffer
const PRICE = saleFacts(order.terms)?.price ?? 0n

describe('the job demo under a seller’s mandate', () => {
  it('refuses a job the mandate doesn’t allow before it books any compute for it', async () => {
    const { store, root } = await folderWithAgent(SELLER, {
      sells: true,
      suppliers: [SELLER, supplier.id],
      categories: [JOB_CATEGORY, 'compute'],
    })
    owner.account = root.address
    const { profile } = JSON.parse((await store.read('supplier')) ?? '{}') as {
      profile: { signingKey: Address }
    }
    // A mandate whose price floor is a micro above the demo job's price.
    const mandate: SellerMandate = {
      mandateId: id('seller-mandate-1'),
      businessId: SELLER,
      account: root.address.toLowerCase() as Address,
      signingKey: profile.signingKey.toLowerCase() as Address,
      currency: 'USD',
      limits: [
        {
          category: JOB_CATEGORY,
          item: 'fine-tuning',
          minUnitPrice: PRICE + 1n,
          maxUnitsPerOrder: 1,
          maxUnitsPerDay: 2,
        },
      ],
      maxOrderValue: PRICE * 10n,
      maxOutstanding: PRICE * 10n,
      maxDeliveryHorizon: 365n * 86_400n,
      minLateCancellationBps: 0,
      minNoShowBps: 0,
      maxFreeCancelWindow: 86_400n,
      buyers: [],
      excludedBuyers: [],
      excludedCountries: [],
      requiresBusinessCheck: false,
      negotiable: [],
      approvalRule: { kind: 'never' },
      expiry: 1_900_000_000n,
      nonce: 1n,
      replaces: null,
    }
    const served = toWire({
      current: {
        type: 'SellerMandate',
        schemaVersion: '1',
        chainId: deployment.chainId,
        lock: LOCK.toLowerCase(),
        message: mandate,
        signature: await root.sign({ hash: digestOf(sellerMandateTypedData(mandate, domain)) }),
      } as Signed<SellerMandate>,
      earlier: [],
      revocation: null,
    })
    const fetch = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname
      if (path === '/config.json') return json(wire(deployment))
      if (path === SANDBOX_PATHS.sellerMandates) return json(JSON.parse(JSON.stringify(served)))
      return json({ error: { reason: 'request.invalid', message: 'No such route' } }, 404)
    }) as typeof globalThis.fetch
    const world = await liveWorld({
      store,
      deployment: { ...deployment, customerUrl: 'https://customer.test' } as never,
      cancelFree: async () => null,
      fetch,
    })
    bookings.mockReset()
    const booked = world.book({} as ComputeOffer, 8, order)
    await expect(booked).rejects.toBeInstanceOf(SellerMandateRefusal)
    await expect(booked).rejects.toMatchObject({ reason: 'seller_mandate.under_price_floor' })
    expect(bookings).not.toHaveBeenCalled()
  })
})
