import { SANDBOX_PATHS, toWire } from '@avow-finance/spec'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import { D, id } from '../test/fixture.js'
import { sliceApi } from './client.js'

const key = privateKeyToAccount(generatePrivateKey())
const signer = { address: key.address, signDigest: (hash: `0x${string}`) => key.sign({ hash }) }

/** A fetch that records what each request asked and answers with `body`. */
function recorder(status: number, body: unknown) {
  const seen: { path: string; json: unknown; authorization: string }[] = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    seen.push({
      path: url.pathname,
      json: JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)),
      authorization: new Headers(init?.headers).get('authorization') ?? '',
    })
    return new Response(JSON.stringify(body), { status })
  }
  return { seen, fetch }
}

describe("the slice routes' client", () => {
  it('reads a worker with what to leave out, signed by the reader, on the read route', async () => {
    const r = recorder(404, { error: { reason: 'slice.key_mismatch', message: 'none' } })
    const api = sliceApi({
      baseUrl: 'https://api.example.test',
      domain: D,
      fetch: r.fetch,
      retryFor: 0n,
    })
    const error = await api.read(signer, key.address, id('funding')).catch((e: unknown) => e)
    expect(error).toMatchObject({ status: 404, reason: 'slice.key_mismatch' })
    expect(r.seen[0]?.path).toBe(SANDBOX_PATHS.workerSlices)
    expect(r.seen[0]?.json).toEqual({ subKey: key.address, excluding: id('funding') })
    expect(r.seen[0]?.authorization).toContain(`signer=${key.address.toLowerCase()}`)
  })

  it("reads a revocation's answer, and refuses one that names no key", async () => {
    const good = recorder(200, { revoked: key.address })
    const api = sliceApi({
      baseUrl: 'https://api.example.test',
      domain: D,
      fetch: good.fetch,
      retryFor: 0n,
    })
    const revocation = toWire({ type: 'SliceRevocation' }) as never
    expect(await api.revoke(signer, revocation)).toEqual({ revoked: key.address })
    expect(good.seen[0]?.path).toBe(SANDBOX_PATHS.sliceRevocations)
    const bad = recorder(200, { revoked: 'nobody' })
    const other = sliceApi({
      baseUrl: 'https://api.example.test',
      domain: D,
      fetch: bad.fetch,
      retryFor: 0n,
    })
    await expect(other.revoke(signer, revocation)).rejects.toMatchObject({
      reason: 'message.invalid',
    })
  })
})
