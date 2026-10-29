import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { isKeySignature } from '@avow-finance/spec'
import { type Address, type Hex, keccak256, stringToHex } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { Account, P256 } from 'viem/tempo'
import { afterEach, describe, expect, it } from 'vitest'
import { httpSupplier } from './supplier.js'

// Every key is generated for the run and held only in memory.
const profile = {
  businessId: 'biz_supplier',
  account: '0x00000000000000000000000000000000000000C1',
  payee: '0x00000000000000000000000000000000000000C1',
  signingKey: '0x00000000000000000000000000000000000000C3',
}
const DIGEST = keccak256(stringToHex('an agreement'))

let server: Server | null = null
afterEach(async () => {
  const s = server
  server = null
  if (s) await new Promise((resolve) => s.close(resolve))
})

/** A supplier adapter that answers from a script and keeps the bodies it got. */
async function supplierAt(answers: { profile?: unknown; agreement?: [number, unknown] }) {
  const bodies: unknown[] = []
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const [status, body] =
      req.url === '/profile' ? [200, answers.profile ?? profile] : (answers.agreement ?? [404, {}])
    if (req.url === '/agreements') bodies.push(JSON.parse(Buffer.concat(chunks).toString()))
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }).listen(0)
  await new Promise((resolve) => server?.once('listening', resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, bodies }
}

const offer = {
  agreement: { commitmentId: `0x${'11'.repeat(32)}`, nonce: 9n, expiry: 1_800_000_600n },
  terms: { template: 'gpu-reservation/1' },
  salt: `0x${'55'.repeat(32)}`,
  domain: { chainId: 42431, verifyingContract: '0x00000000000000000000000000000000000010c4' },
} as never

/** A supplier's signing key of each kind Tempo reads, as `isKeySignature` checks them. */
const signingKeys = {
  secp256k1: () => Account.fromSecp256k1(generatePrivateKey()),
  'P-256': () => Account.fromP256(P256.randomPrivateKey()),
  WebAuthn: () =>
    Account.fromHeadlessWebAuthn(P256.randomPrivateKey(), {
      rpId: 'supplier.example',
      origin: 'https://supplier.example',
    }),
}

describe("the agent's channel to a supplier", () => {
  it("reads the supplier's profile and sends an offer as JSON, returning the signature", async () => {
    const signature = await signingKeys.secp256k1().sign({ hash: DIGEST })
    const { url, bodies } = await supplierAt({ agreement: [200, { signature }] })
    const supplier = await httpSupplier(url)
    // Addresses read in lower case, as every wire form in the spec reads them.
    expect(supplier.profile).toEqual({
      businessId: 'biz_supplier',
      account: '0x00000000000000000000000000000000000000c1',
      payee: '0x00000000000000000000000000000000000000c1',
      signingKey: '0x00000000000000000000000000000000000000c3',
    })
    expect(await supplier.signAgreement(offer)).toBe(signature)
    expect(bodies).toEqual([
      {
        agreement: { commitmentId: `0x${'11'.repeat(32)}`, nonce: '9', expiry: '1800000600' },
        terms: { template: 'gpu-reservation/1' },
        salt: `0x${'55'.repeat(32)}`,
        domain: { chainId: 42431, verifyingContract: '0x00000000000000000000000000000000000010c4' },
      },
    ])
  })

  for (const [kind, make] of Object.entries(signingKeys)) {
    it(`returns a supplier's ${kind} signature, which the SDK then checks`, async () => {
      const key = make()
      const signature: Hex = await key.sign({ hash: DIGEST })
      expect(isKeySignature(DIGEST, signature, key.address as Address)).toBe(true)
      const { url } = await supplierAt({ agreement: [200, { signature }] })
      expect(await (await httpSupplier(url)).signAgreement(offer)).toBe(signature.toLowerCase())
    })
  }

  it("says why the supplier refused, and refuses an answer that isn't a signature", async () => {
    const refused = await supplierAt({
      agreement: [422, { error: 'the reserve is over its limit' }],
    })
    await expect((await httpSupplier(refused.url)).signAgreement(offer)).rejects.toThrow(
      'the reserve is over its limit',
    )
    await new Promise((resolve) => server?.close(resolve))
    const odd = await supplierAt({ agreement: [200, { signature: '0x1234' }] })
    await expect((await httpSupplier(odd.url)).signAgreement(offer)).rejects.toThrow('no signature')
  })

  it('refuses a supplier without a readable profile', async () => {
    const { url } = await supplierAt({ profile: { businessId: 'biz_supplier' } })
    await expect(httpSupplier(url)).rejects.toThrow('no supplier profile')
  })
})
