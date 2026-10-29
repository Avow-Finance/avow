import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { httpSupplier } from './supplier.js'

const profile = {
  businessId: 'biz_supplier',
  account: '0x00000000000000000000000000000000000000C1',
  payee: '0x00000000000000000000000000000000000000C1',
  signingKey: '0x00000000000000000000000000000000000000C3',
}
const SIGNATURE = `0x${'ab'.repeat(65)}`

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

describe("the agent's channel to a supplier", () => {
  it("reads the supplier's profile and sends an offer as JSON, returning the signature", async () => {
    const { url, bodies } = await supplierAt({ agreement: [200, { signature: SIGNATURE }] })
    const supplier = await httpSupplier(url)
    expect(supplier.profile).toEqual(profile)
    expect(await supplier.signAgreement(offer)).toBe(SIGNATURE)
    expect(bodies).toEqual([
      {
        agreement: { commitmentId: `0x${'11'.repeat(32)}`, nonce: '9', expiry: '1800000600' },
        terms: { template: 'gpu-reservation/1' },
        salt: `0x${'55'.repeat(32)}`,
        domain: { chainId: 42431, verifyingContract: '0x00000000000000000000000000000000000010c4' },
      },
    ])
  })

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
