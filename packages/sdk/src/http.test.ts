import {
  type AvowDomain,
  apiRequestOf,
  apiRequestTypedData,
  digestOf,
  isKeySignature,
  parseApiAuthorization,
  type RequestKey,
  toWire,
} from '@avow-finance/spec'
import type { Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import { AvowApiError, httpAvowApi } from './http.js'

// Every key is generated for the run and held only in memory.
const account = privateKeyToAccount(generatePrivateKey())
const key: RequestKey = { address: account.address, signDigest: (hash) => account.sign({ hash }) }
const domain: AvowDomain = {
  chainId: 42431,
  verifyingContract: '0x00000000000000000000000000000000000010c4',
}
const NOW = 1_800_000_000n

interface Seen {
  url: string
  authorization: string
  body: Uint8Array
}

/** A stand-in for Avow's API that checks each signature and answers from a script. */
function fakeApi(answers: (() => Response | Promise<Response>)[]) {
  const seen: Seen[] = []
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    seen.push({
      url: String(url),
      authorization: headers.get('authorization') ?? '',
      body: init?.body as Uint8Array,
    })
    const next = answers.shift()
    if (!next) throw new Error('no more answers')
    return next()
  }) as typeof fetch
  return { seen, fetcher }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(toWire(body)), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const client = (fetcher: typeof fetch, overrides: object = {}) =>
  httpAvowApi({
    baseUrl: 'https://api.testnet.avow.finance/ignored/path',
    key,
    domain,
    fetch: fetcher,
    now: () => NOW,
    retryWait: 0,
    ...overrides,
  })

/** What Avow checks: the request rebuilt from what arrived verifies against the header. */
function signedByKey(s: Seen, path: string): boolean {
  const credentials = parseApiAuthorization(s.authorization)
  if (!credentials) return false
  const request = apiRequestOf({
    audience: 'https://api.testnet.avow.finance',
    method: 'POST',
    path,
    body: s.body,
    credentials,
  })
  const digest = digestOf(
    apiRequestTypedData(request, { ...domain, verifyingContract: credentials.lock }),
  )
  return (
    credentials.expiry === NOW + 120n && isKeySignature(digest, credentials.signature, key.address)
  )
}

describe('httpAvowApi', () => {
  it('signs each request with the key, for the origin, the path and the exact body', async () => {
    const { seen, fetcher } = fakeApi([() => json(200, { transaction: '0xabcd' })])
    expect(await client(fetcher).sponsor('0x1234')).toBe('0xabcd')
    expect(seen[0]?.url).toBe('https://api.testnet.avow.finance/v1/sponsorships')
    expect(new TextDecoder().decode(seen[0]?.body)).toBe('{"transaction":"0x1234"}')
    expect(signedByKey(seen[0] as Seen, '/v1/sponsorships')).toBe(true)
    expect(signedByKey(seen[0] as Seen, '/v1/reserve-approvals')).toBe(false)
  })

  it('sends the same bytes again after no answer, a 5xx or a request still in progress', async () => {
    const { seen, fetcher } = fakeApi([
      () => {
        throw new TypeError('fetch failed')
      },
      () => json(503, { error: { reason: 'request.in_progress', message: 'busy' } }),
      () => json(409, { error: { reason: 'request.in_progress', message: 'still answering' } }),
      () => json(200, { transaction: '0xabcd' }),
    ])
    expect(await client(fetcher).sponsor('0x1234')).toBe('0xabcd')
    expect(seen).toHaveLength(4)
    for (const s of seen) {
      expect(s.authorization).toBe(seen[0]?.authorization)
      expect(s.body).toEqual(seen[0]?.body)
    }
  })

  it('stops after its retries, and never retries a refusal', async () => {
    const down = fakeApi([1, 2, 3].map(() => () => json(502, 'bad gateway')))
    await expect(client(down.fetcher, { retries: 2 }).sponsor('0x1234')).rejects.toMatchObject({
      status: 502,
      reason: null,
    })
    expect(down.seen).toHaveLength(3)
    const refused = fakeApi([
      () => json(401, { error: { reason: 'request.signer_unknown', message: 'Unknown key' } }),
    ])
    const error = await client(refused.fetcher)
      .sponsor('0x1234')
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AvowApiError)
    expect(error).toMatchObject({
      status: 401,
      reason: 'request.signer_unknown',
      message: 'Unknown key',
    })
    expect(refused.seen).toHaveLength(1)
  })

  it("doesn't retry once the request has expired", async () => {
    let clock = NOW
    const { seen, fetcher } = fakeApi([
      () => {
        clock = NOW + 121n
        return json(503, 'unavailable')
      },
      () => json(200, { transaction: '0xabcd' }),
    ])
    await expect(client(fetcher, { now: () => clock }).sponsor('0x1234')).rejects.toMatchObject({
      status: 503,
    })
    expect(seen).toHaveLength(1)
  })

  it('reads a refusal from the reserve check as an answer, and refuses an unreadable one', async () => {
    const refusal = { ok: false, decisionId: 'dec_1', reason: 'mandate.over_commitment_cap' }
    const { fetcher } = fakeApi([() => json(200, refusal), () => json(200, { ok: true })])
    const api = client(fetcher)
    const body = {} as Parameters<typeof api.approveReserve>[0]
    expect(await api.approveReserve(body)).toEqual(refusal)
    await expect(api.approveReserve(body)).rejects.toMatchObject({ reason: 'message.invalid' })
  })

  it('refuses a validity Avow would refuse, and says which calls wait for their records', async () => {
    const { fetcher } = fakeApi([])
    expect(() => client(fetcher, { requestValidity: 301n })).toThrow(RangeError)
    expect(() => client(fetcher, { requestValidity: 0n })).toThrow(RangeError)
    expect(() => client(fetcher, { baseUrl: 'ftp://api.testnet.avow.finance' })).toThrow(RangeError)
    const api = client(fetcher)
    const commitmentId = `0x${'11'.repeat(32)}` as Hex
    await expect(api.cancel({ commitmentId })).rejects.toThrow(/cancellations/)
    await expect(api.requestStart({ commitmentId })).rejects.toThrow(/start requests/)
  })

  it('hands each signed request to the caller to keep', async () => {
    const kept: unknown[] = []
    const { fetcher } = fakeApi([() => json(200, { transaction: '0xabcd' })])
    await client(fetcher, { onSigned: (r: unknown) => kept.push(r) }).sponsor('0x1234')
    expect(kept).toHaveLength(1)
    expect(kept[0]).toMatchObject({ type: 'ApiRequest', lock: domain.verifyingContract })
  })
})
