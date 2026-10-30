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
  type AvowResend,
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

type Answer = (seen: Seen) => Response | Promise<Response>

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
    return next(seen.at(-1) as Seen)
  }) as typeof fetch
  return { seen, fetcher }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(toWire(body)), {
    status,
    headers: { 'content-type': 'application/json' },
  })
/** An answer whose bytes aren't JSON, such as a proxy's page or a body cut off on its way. */
const notJson = (status: number, text: string) => () =>
  new Response(text, { status, headers: { 'content-type': 'text/html' } })
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
      notJson(502, '<html>Bad Gateway</html>'),
      error(503, 'service.unavailable'),
      error(409, 'request.in_progress', { retryAfter: 1 }),
      notJson(200, '<html>maintenance</html>'),
      notJson(200, '{"transaction":"0xab'),
      ok,
    ])
    expect(await client(fetcher).sponsor('0x1234')).toBe('0xabcd')
    expect(seen).toHaveLength(9)
    for (const s of seen) {
      expect(s.authorization).toBe(seen[0]?.authorization)
      expect(s.body).toEqual(seen[0]?.body)
    }
  })

  it("sends a 4xx whose body isn't JSON again, since Avow's own refusals are JSON", async () => {
    const { seen, fetcher } = fakeApi([
      notJson(429, '<html><body><h1>429 Too Many Requests</h1></body></html>'),
      notJson(408, '<html><body><h1>408 Request Timeout</h1></body></html>'),
      notJson(404, ''),
      ok,
    ])
    expect(await client(fetcher).sponsor('0x1234')).toBe('0xabcd')
    expect(seen).toHaveLength(4)
    for (const s of seen) {
      expect(s.authorization).toBe(seen[0]?.authorization)
      expect(s.body).toEqual(seen[0]?.body)
    }
  })

  it('stops at once at a 4xx whose body is JSON, whoever sent it', async () => {
    const { seen, fetcher } = fakeApi([() => json(429, { message: 'Too Many Requests' }), ok])
    const e = await client(fetcher)
      .sponsor('0x1234')
      .catch((x: unknown) => x)
    expect(e).toBeInstanceOf(AvowApiError)
    expect(e).toMatchObject({
      status: 429,
      reason: null,
      definite: true,
      message: "Avow's API answered 429",
    })
    expect(seen).toHaveLength(1)
  })

  it('gives up on unreadable answers once retryFor runs out, naming the last one and its status', async () => {
    let clock = NOW
    const plainText = () => {
      clock += 200n
      return new Response('upstream request timeout', {
        status: 408,
        headers: { 'content-type': 'text/plain' },
      })
    }
    const { seen, fetcher } = fakeApi([plainText, plainText, plainText, plainText])
    const resends: AvowResend[] = []
    const e = await client(fetcher, {
      now: () => clock,
      onResend: (r: AvowResend) => resends.push(r),
    })
      .sponsor('0x1234')
      .catch((x: unknown) => x)
    expect(e).toBeInstanceOf(AvowApiError)
    // No reason and not definite, so it can't be read as Avow's own refusal of the request.
    expect(e).toMatchObject({
      status: 408,
      reason: null,
      definite: false,
      message:
        "No definite answer from Avow. The last answer was unreadable, a 408 whose body isn't JSON.",
    })
    // Ten minutes by default, and each answer came 200 seconds after the one before.
    expect(seen).toHaveLength(3)
    // Each resend was heard before it went, with what the attempt before it saw.
    expect(resends.map((r) => [r.status, r.reason, r.message])).toEqual([
      [408, null, "The last answer was unreadable, a 408 whose body isn't JSON."],
      [408, null, "The last answer was unreadable, a 408 whose body isn't JSON."],
    ])
    expect(resends.every((r) => r.requestId === (e as AvowApiError).requestId)).toBe(true)
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
      expect(e).toMatchObject({ status, reason, definite: true, message: `refused: ${reason}` })
      expect((e as AvowApiError).sponsorship).toBeNull()
      const v = verified(seen[0] as Seen)
      expect(v.ok && v.value.credentials.requestId).toBe((e as AvowApiError).requestId)
      expect(seen).toHaveLength(1)
    }
  })

  it("stops at the relay's refusal with what it adds, such as when the key can ask again", async () => {
    const cases = [
      [429, 'sponsorship.rate_limited', { retryAt: 1_800_000_060n }],
      [429, 'sponsorship.budget_spent', { budget: 'agent_key', retryAt: 1_800_086_400n }],
      [422, 'sponsorship.over_cap', { cap: 'fee_per_gas', limit: 1_200_000_000n }],
      [422, 'sponsorship.simulation_failed', { revert: '0x832f98b5' }],
    ] as const
    for (const [status, reason, details] of cases) {
      const { seen, fetcher } = fakeApi([error(status, reason, details)])
      const e = await client(fetcher)
        .sponsor('0x1234')
        .catch((x: unknown) => x)
      expect(e).toMatchObject({ status, reason, definite: true })
      expect((e as AvowApiError).sponsorship).toEqual({ reason, ...details })
      expect(seen).toHaveLength(1)
    }
  })

  it("throws an answer that is JSON but not the call's answer at once, with the parser's reason", async () => {
    const approval = (change: object) => ({
      ok: true,
      decisionId: 'dec_1',
      approval: {
        type: 'Approval',
        schemaVersion: '1',
        chainId: domain.chainId,
        lock: domain.verifyingContract,
        message: {},
        signature: '0x00',
        ...change,
      },
    })
    const cases: [(api: ReturnType<typeof client>) => Promise<unknown>, unknown, string][] = [
      [
        (api) => api.approveReserve({} as never),
        approval({ lock: '0x00000000000000000000000000000000000010c5' }),
        'message.wrong_contract',
      ],
      [(api) => api.approveReserve({} as never), approval({ chainId: 1 }), 'message.wrong_chain'],
      [
        (api) => api.approveReserve({} as never),
        approval({ schemaVersion: '9' }),
        'message.schema_unknown',
      ],
      [(api) => api.approveReserve({} as never), approval({}), 'message.invalid'],
      [(api) => api.sponsor('0x1234'), { surprise: true }, 'message.invalid'],
    ]
    for (const [call, answer, reason] of cases) {
      // Were the answer sent again, the refusal that follows would end the call instead.
      const { seen, fetcher } = fakeApi([() => json(200, answer), error(400, 'request.invalid')])
      const e = await call(client(fetcher)).catch((x: unknown) => x)
      expect(e, reason).toBeInstanceOf(AvowApiError)
      expect(e, reason).toMatchObject({ status: 200, reason })
      const v = verified(seen[0] as Seen, (seen[0]?.url ?? '').slice(AUDIENCE.length))
      expect(v.ok && v.value.credentials.requestId).toBe((e as AvowApiError).requestId)
      // A repeat would get the same recorded answer, so nothing went again.
      expect(seen, reason).toHaveLength(1)
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

  it("serves the reserve check, the relay and all three of Avow's records", () => {
    const api = client(fakeApi([]).fetcher)
    expect(Object.keys(api).sort()).toEqual(['approveReserve', 'records', 'sponsor'])
    expect(Object.keys(api.records).sort()).toEqual(['cancel', 'recordStart', 'requestStart'])
  })

  it('hands each signed request to the caller to keep', async () => {
    const kept: unknown[] = []
    const { fetcher } = fakeApi([ok])
    await client(fetcher, { onSigned: (r: unknown) => kept.push(r) }).sponsor('0x1234')
    expect(kept).toHaveLength(1)
    expect(kept[0]).toMatchObject({ type: 'ApiRequest', lock: domain.verifyingContract })
  })
})

describe("Avow's records over the hosted API", () => {
  const commitmentId: Hex = `0x${'c0'.repeat(32)}`
  const stamp = (requestHash: Hex, receivedAt: bigint) => ({
    type: 'Timestamp',
    schemaVersion: '1',
    chainId: domain.chainId,
    lock: domain.verifyingContract,
    message: { requestHash, receivedAt },
    signature: `0x${'ab'.repeat(65)}`,
  })
  /** The digest of the request Avow's stand-in received, as the API reads it. */
  const digestOf = (s: Seen, path: string) => {
    const v = verified(s, path)
    if (!v.ok) throw new Error(`the request doesn't verify: ${v.reason}`)
    return v.value.digest
  }

  it("cancels with an empty body on the commitment's path, and reads the time Avow stamped", async () => {
    const path = `/v1/commitments/${commitmentId}/cancellations`
    const { seen, fetcher } = fakeApi([
      (s) => json(200, { cancelledAt: NOW, timestamp: stamp(digestOf(s, path), NOW) }),
    ])
    expect(await client(fetcher).records.cancel({ commitmentId })).toEqual({ cancelledAt: NOW })
    expect((seen[0] as Seen).url).toBe(`${AUDIENCE}${path}`)
    expect(new TextDecoder().decode((seen[0] as Seen).body)).toBe('{}')
  })

  it('throws an answer whose timestamp names another request, without sending again', async () => {
    const other: Hex = `0x${'0e'.repeat(32)}`
    const { seen, fetcher } = fakeApi([
      () => json(200, { cancelledAt: NOW, timestamp: stamp(other, NOW) }),
    ])
    const thrown = await client(fetcher)
      .records.cancel({ commitmentId })
      .catch((e: unknown) => e)
    expect(thrown).toBeInstanceOf(AvowApiError)
    expect(thrown).toMatchObject({ reason: 'message.invalid', definite: true })
    expect(seen).toHaveLength(1)
  })

  it('passes on a refusal to cancel before free cancellation ends', async () => {
    const { fetcher } = fakeApi([error(409, 'commitment.cancel_on_lock')])
    await expect(client(fetcher).records.cancel({ commitmentId })).rejects.toMatchObject({
      status: 409,
      reason: 'commitment.cancel_on_lock',
    })
  })

  it('passes on a refusal to cancel once the no-show charge can be reported', async () => {
    const { fetcher } = fakeApi([error(409, 'commitment.cancel_closed')])
    await expect(client(fetcher).records.cancel({ commitmentId })).rejects.toMatchObject({
      status: 409,
      reason: 'commitment.cancel_closed',
      definite: true,
    })
  })

  describe('a commitment cancelled by an earlier request', () => {
    const path = `/v1/commitments/${commitmentId}/cancellations`
    /** What Avow keeps of a request it recorded, and answers a later cancellation with. */
    const recorded = (s: Seen) => {
      const v = verified(s, path)
      if (!v.ok) throw new Error(`the request doesn't verify: ${v.reason}`)
      const { signer, requestId, expiry, bodyHash } = v.value.request.message
      return { digest: v.value.digest, cancelledBy: { signer, requestId, expiry, bodyHash } }
    }

    it('gives a later cancel the first time, after the first call got no definite answer', async () => {
      let first: ReturnType<typeof recorded> | undefined
      const { seen, fetcher } = fakeApi([
        (s) => {
          // Avow records the cancellation, and its answer is lost on the way back.
          first = recorded(s)
          throw new TypeError('socket hang up')
        },
        () => {
          if (!first) throw new Error('the first request never arrived')
          return json(200, {
            cancelledAt: NOW,
            timestamp: stamp(first.digest, NOW),
            cancelledBy: first.cancelledBy,
          })
        },
      ])
      const api = client(fetcher, { retryFor: 0n })
      await expect(api.records.cancel({ commitmentId })).rejects.toMatchObject({
        definite: false,
      })
      expect(await api.records.cancel({ commitmentId })).toEqual({ cancelledAt: NOW })
      expect(recorded(seen[1] as Seen).digest).not.toBe(first?.digest)
    })

    it("throws a cancelledBy that doesn't rebuild the digest the timestamp names, without sending again", async () => {
      const { seen, fetcher } = fakeApi([
        (s) => {
          const first = recorded(s)
          return json(200, {
            cancelledAt: NOW,
            timestamp: stamp(`0x${'0e'.repeat(32)}`, NOW),
            cancelledBy: first.cancelledBy,
          })
        },
      ])
      const thrown = await client(fetcher)
        .records.cancel({ commitmentId })
        .catch((e: unknown) => e)
      expect(thrown).toBeInstanceOf(AvowApiError)
      expect(thrown).toMatchObject({ reason: 'message.invalid', definite: true })
      expect(seen).toHaveLength(1)
    })
  })

  it('asks for a start and gets the hash of the very request it signed, stamped', async () => {
    const path = `/v1/commitments/${commitmentId}/start-requests`
    let expected: Hex = '0x'
    const { fetcher } = fakeApi([
      (s) => {
        expected = digestOf(s, path)
        return json(200, {
          startRequestHash: expected,
          requestedAt: NOW,
          timestamp: stamp(expected, NOW),
        })
      },
    ])
    expect(await client(fetcher).records.requestStart({ commitmentId })).toEqual({
      startRequestHash: expected,
      requestedAt: NOW,
    })
  })

  it("passes the supplier's start receipt on, and reads Avow recording or refusing it", async () => {
    const receipt = {
      type: 'StartReceipt',
      schemaVersion: '1',
      chainId: domain.chainId,
      lock: domain.verifyingContract,
      message: {
        commitmentId,
        side: 'buyer',
        startRequestHash: `0x${'0d'.repeat(32)}`,
        startedAt: NOW,
        nonce: 1n,
        expiry: NOW + 600n,
      },
      signature: `0x${'ab'.repeat(65)}`,
    } as const
    const { seen, fetcher } = fakeApi([
      () => json(200, { ok: true }),
      () => json(200, { ok: false, reason: 'commitment.ended' }),
    ])
    const api = client(fetcher)
    expect(await api.records.recordStart({ commitmentId, receipt })).toEqual({ ok: true })
    expect(await api.records.recordStart({ commitmentId, receipt })).toEqual({
      ok: false,
      reason: 'commitment.ended',
    })
    expect(new TextDecoder().decode((seen[0] as Seen).body)).toBe(
      new TextDecoder().decode(encodeApiBody({ receipt })),
    )
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
      notJson(200, '{"businessId":"biz_'),
      () => json(200, enrolled),
    ])
    const answer = await enrollAgent(settings(fetcher), {
      mandate: mandate as never,
      keyAuthorizedIn: keyTx,
    })
    expect(answer).toEqual(enrolled)
    // An answer whose bytes aren't JSON counts as none, so the same bytes went again.
    expect(seen).toHaveLength(2)
    expect(seen[1]?.body).toEqual(seen[0]?.body)
    expect(seen[1]?.authorization).toBe(seen[0]?.authorization)
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
