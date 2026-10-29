import {
  type AvowDomain,
  encodeApiBody,
  type RequestKey,
  toWire,
  verifyApiRequest,
} from '@avow-finance/spec'
import type { Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { Account } from 'viem/tempo'
import { describe, expect, it } from 'vitest'
import {
  AvowApiError,
  agentRequestKey,
  enrollAgent,
  httpAvowApi,
  requestSupplierAuthorization,
} from './http.js'

// Every key is generated for the run and held only in memory.
const account = privateKeyToAccount(generatePrivateKey())
const key: RequestKey = { address: account.address, signDigest: (hash) => account.sign({ hash }) }
const domain: AvowDomain = {
  chainId: 42431,
  verifyingContract: '0x00000000000000000000000000000000000010c4',
}
const AUDIENCE = 'https://api.testnet.avow.finance'
const NOW = 1_800_000_000n

interface Seen {
  url: string
  init: RequestInit
  authorization: string
  body: Uint8Array
}

type Answer = () => Response | Promise<Response>

/** A stand-in for Avow's API that records each request and answers from a script. */
function fakeApi(answers: Answer[]) {
  const seen: Seen[] = []
  const fetcher = (async (url: string | URL | Request, init: RequestInit = {}) => {
    seen.push({
      url: String(url),
      init,
      authorization: new Headers(init.headers).get('authorization') ?? '',
      body: init.body as Uint8Array,
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
const ok = () => json(200, { transaction: '0xabcd' })
const error =
  (status: number, reason: string, extra: object = {}) =>
  () =>
    json(status, { error: { reason, message: `refused: ${reason}`, ...extra } })

const client = (fetcher: typeof fetch, overrides: object = {}) =>
  httpAvowApi({
    baseUrl: `${AUDIENCE}/`,
    key,
    domain,
    fetch: fetcher,
    now: () => NOW,
    retryWait: 0,
    ...overrides,
  })

/** What Avow checks at steps 1 and 2, for the request as it arrived. */
const verified = (s: Seen, path = '/v1/sponsorships') =>
  verifyApiRequest({
    audience: AUDIENCE,
    chainId: domain.chainId,
    method: 'POST',
    path,
    body: s.body,
    authorization: s.authorization,
  })

describe('httpAvowApi', () => {
  it('signs the canonical body it sends, for the deployment, the path and the lock', async () => {
    const { seen, fetcher } = fakeApi([ok])
    expect(await client(fetcher).sponsor('0x1234')).toBe('0xabcd')
    const s = seen[0] as Seen
    expect(s.url).toBe(`${AUDIENCE}/v1/sponsorships`)
    expect(s.body).toEqual(encodeApiBody({ transaction: '0x1234' }))
    const v = verified(s)
    expect(v.ok && v.value.credentials.lock).toBe(domain.verifyingContract)
    expect(v.ok && v.value.credentials.expiry).toBe(NOW + 120n)
    expect(verified(s, '/v1/reserve-approvals').ok).toBe(false)
  })

  it('never follows a redirect, and bounds each attempt', async () => {
    const { seen, fetcher } = fakeApi([ok])
    await client(fetcher).sponsor('0x1234')
    expect(seen[0]?.init.redirect).toBe('error')
    expect(seen[0]?.init.signal).toBeInstanceOf(AbortSignal)
  })

  it('sends the same bytes again until a definite answer, through every kind of lost answer', async () => {
    const broken = () =>
      ({
        ok: true,
        status: 200,
        text: () => Promise.reject(new TypeError('terminated')),
      }) as unknown as Response
    const { seen, fetcher } = fakeApi([
      () => {
        throw new TypeError('fetch failed')
      },
      broken,
      () => json(502, 'bad gateway'),
      error(503, 'service.unavailable'),
      error(409, 'request.in_progress', { retryAfter: 1 }),
      () => json(200, '<html>maintenance</html>'),
      ok,
    ])
    expect(await client(fetcher).sponsor('0x1234')).toBe('0xabcd')
    expect(seen).toHaveLength(7)
    for (const s of seen) {
      expect(s.authorization).toBe(seen[0]?.authorization)
      expect(s.body).toEqual(seen[0]?.body)
    }
  })

  it('stops at a refusal, with the reason and the request id it signed', async () => {
    for (const [status, reason] of [
      [401, 'request.signer_unknown'],
      [401, 'message.expired'],
      [409, 'request.id_reused'],
      [422, 'sponsorship.refused'],
    ] as const) {
      const { seen, fetcher } = fakeApi([error(status, reason)])
      const e = await client(fetcher)
        .sponsor('0x1234')
        .catch((x: unknown) => x)
      expect(e).toBeInstanceOf(AvowApiError)
      expect(e).toMatchObject({ status, reason, message: `refused: ${reason}` })
      const v = verified(seen[0] as Seen)
      expect(v.ok && v.value.credentials.requestId).toBe((e as AvowApiError).requestId)
      expect(seen).toHaveLength(1)
    }
  })

  it('gives up once retryFor runs out, saying what it last saw', async () => {
    let clock = NOW
    const { seen, fetcher } = fakeApi([
      error(503, 'service.unavailable'),
      () => {
        clock = NOW + 601n
        return json(503, 'unavailable')
      },
    ])
    const e = await client(fetcher, { now: () => clock })
      .sponsor('0x1234')
      .catch((x: unknown) => x)
    expect(e).toMatchObject({ status: 503, reason: null })
    expect(seen).toHaveLength(2)
  })

  it('reads a refusal from the reserve check as an answer', async () => {
    const refusal = { ok: false, decisionId: 'dec_1', reason: 'mandate.over_commitment_cap' }
    const { fetcher } = fakeApi([() => json(200, refusal)])
    const api = client(fetcher)
    expect(await api.approveReserve({} as Parameters<typeof api.approveReserve>[0])).toEqual(
      refusal,
    )
  })

  it("signs as the agent's own access key, bare, so Avow verifies it as the agent", async () => {
    const root = Account.fromSecp256k1(generatePrivateKey())
    const agent = Account.fromSecp256k1(generatePrivateKey(), { access: root })
    const requestKey = agentRequestKey(agent)
    expect(requestKey.address).toBe(agent.accessKeyAddress)
    expect(requestKey.address).not.toBe(root.address)
    const { seen, fetcher } = fakeApi([ok])
    await client(fetcher, { key: requestKey }).sponsor('0x1234')
    const v = verified(seen[0] as Seen)
    expect(v.ok && v.value.credentials.signer).toBe(agent.accessKeyAddress.toLowerCase())
  })

  it('takes only an origin and a validity Avow accepts', async () => {
    const { fetcher } = fakeApi([])
    for (const baseUrl of [
      'ftp://api.testnet.avow.finance',
      `${AUDIENCE}/avow`,
      `${AUDIENCE}/?x=1`,
      `${AUDIENCE}/#x`,
      'https://user:pass@api.testnet.avow.finance',
    ]) {
      expect(() => client(fetcher, { baseUrl }), baseUrl).toThrow(RangeError)
    }
    expect(() => client(fetcher, { requestValidity: 301n })).toThrow(RangeError)
    expect(() => client(fetcher, { requestValidity: 0n })).toThrow(RangeError)
  })

  it('serves only the reserve check and the relay, leaving out the calls Avow does not serve yet', () => {
    const api = client(fakeApi([]).fetcher)
    expect(Object.keys(api).sort()).toEqual(['approveReserve', 'sponsor'])
    expect(api.cancel).toBeUndefined()
    expect(api.requestStart).toBeUndefined()
    expect(api.recordStart).toBeUndefined()
  })

  it('hands each signed request to the caller to keep', async () => {
    const kept: unknown[] = []
    const { fetcher } = fakeApi([ok])
    await client(fetcher, { onSigned: (r: unknown) => kept.push(r) }).sponsor('0x1234')
    expect(kept).toHaveLength(1)
    expect(kept[0]).toMatchObject({ type: 'ApiRequest', lock: domain.verifyingContract })
  })
})

describe('enrolling an agent and asking for a supplier authorization', () => {
  const settings = (fetcher: typeof fetch) => ({
    baseUrl: AUDIENCE,
    key,
    fetch: fetcher,
    now: () => NOW,
    retryWait: 0,
  })
  const keyTx: Hex = `0x${'ab'.repeat(32)}`
  const mHash: Hex = `0x${'cd'.repeat(32)}`

  it("enrolls under the mandate's own lock, and reads what Avow recorded", async () => {
    const mandate = {
      type: 'Mandate',
      schemaVersion: '1',
      chainId: domain.chainId,
      lock: domain.verifyingContract,
      message: { agentId: 'agt_1' },
      signature: '0x00',
    }
    const enrolled = {
      businessId: 'biz_buyer',
      agentId: 'agt_1',
      agentKey: account.address.toLowerCase(),
      mandateHash: mHash,
    }
    const { seen, fetcher } = fakeApi([
      () => json(200, { surprise: true }),
      () => json(200, enrolled),
    ])
    const answer = await enrollAgent(settings(fetcher), {
      mandate: mandate as never,
      keyAuthorizedIn: keyTx,
    })
    expect(answer).toEqual(enrolled)
    // An answer it can't read counts as none, so the same bytes went again.
    expect(seen).toHaveLength(2)
    expect(seen[1]?.body).toEqual(seen[0]?.body)
    const v = await verified(seen[0] as Seen, '/v1/enrollments')
    expect(v.ok).toBe(true)
    expect(seen[0]?.body).toEqual(encodeApiBody({ mandate, keyAuthorizedIn: keyTx }))
  })

  it("asks as the supplier under the buyer's lock, and reads a refusal as Avow's answer", async () => {
    const commitmentId: Hex = `0x${'1f'.repeat(32)}`
    const { seen, fetcher } = fakeApi([
      () => json(200, { ok: false, reason: 'chain.reserve_missing' }),
    ])
    const answer = await requestSupplierAuthorization(settings(fetcher), {
      chainId: domain.chainId,
      lock: domain.verifyingContract,
      commitmentId,
    })
    expect(answer).toEqual({ ok: false, reason: 'chain.reserve_missing' })
    const path = `/v1/commitments/${commitmentId}/supplier-authorizations`
    expect(seen[0]?.url).toBe(`${AUDIENCE}${path}`)
    expect(seen[0]?.body).toEqual(encodeApiBody({}))
    expect((await verified(seen[0] as Seen, path)).ok).toBe(true)
  })
})
