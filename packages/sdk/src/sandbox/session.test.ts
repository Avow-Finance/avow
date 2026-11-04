import {
  type AvowDomain,
  type CommitmentReference,
  decodeCommitmentReference,
  dollars,
  encodeApiBody,
  newSessionId,
  type SessionEvent,
  toWire,
  verifyApiRequest,
} from '@avow-finance/spec'
import { generatePrivateKey } from 'viem/accounts'
import { Account } from 'viem/tempo'
import { describe, expect, it } from 'vitest'
import { AvowApiError } from '../http.js'
import { SANDBOX_SCREEN_URL, sessionRelay, sessionUrl, verifyUrl } from './session.js'

// Every key is generated for the run and held only in memory.
const root = Account.fromSecp256k1(generatePrivateKey())
const domain: AvowDomain = {
  chainId: 42431,
  verifyingContract: '0x00000000000000000000000000000000000010c4',
}
const AUDIENCE = 'https://api.testnet.avow.finance'
const NOW = 1_800_000_000n
const reference: CommitmentReference = {
  kind: 'commitment',
  chainId: 42431,
  lock: domain.verifyingContract,
  commitmentId: `0x${'ab'.repeat(32)}`,
  side: 'buyer',
  termsHash: `0x${'cd'.repeat(32)}`,
}
const committed: SessionEvent = { type: 'committed', run: 1, reference, amount: dollars(200) }

interface Seen {
  url: string
  authorization: string
  body: Uint8Array
}

/** A stand-in for Avow's API that records each request and answers from a script. */
function fakeApi(answers: Response[]) {
  const seen: Seen[] = []
  const fetcher = (async (url: string | URL | Request, init: RequestInit = {}) => {
    seen.push({
      url: String(url),
      authorization: new Headers(init.headers).get('authorization') ?? '',
      body: init.body as Uint8Array,
    })
    const next = answers.shift()
    if (!next) throw new Error('no more answers')
    return next
  }) as typeof fetch
  return { seen, fetcher }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(toWire(body)), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const relay = (sessionId: string, fetcher: typeof fetch) =>
  sessionRelay({
    baseUrl: AUDIENCE,
    sessionId,
    root,
    domain,
    fetch: fetcher,
    now: () => NOW,
    retryWait: 0,
  })

describe('sessionRelay', () => {
  it("posts the event to the session, signed by the business's root key under its lock", async () => {
    const id = newSessionId()
    const { seen, fetcher } = fakeApi([json(200, { sequence: 4 })])
    expect(await relay(id, fetcher).post(committed)).toEqual({ sequence: 4 })
    const s = seen[0] as Seen
    const path = `/v1/sandbox/sessions/${id}/events`
    expect(s.url).toBe(`${AUDIENCE}${path}`)
    expect(s.body).toEqual(encodeApiBody({ event: committed }))
    const v = verifyApiRequest({
      audience: AUDIENCE,
      chainId: domain.chainId,
      method: 'POST',
      path,
      body: s.body,
      authorization: s.authorization,
    })
    expect(v.ok && v.value.credentials.signer).toBe(root.address.toLowerCase())
    expect(v.ok && v.value.credentials.lock).toBe(domain.verifyingContract)
  })

  it("throws Avow's refusal with its reason, and an answer it can't read", async () => {
    const refusal = json(403, { error: { reason: 'business.unknown', message: 'no business' } })
    const { fetcher } = fakeApi([refusal, json(200, { sequence: 'first' })])
    const r = relay(newSessionId(), fetcher)
    await expect(r.post(committed)).rejects.toMatchObject({ reason: 'business.unknown' })
    await expect(r.post(committed)).rejects.toBeInstanceOf(AvowApiError)
  })

  it('takes only a session id', () => {
    expect(() => relay('../../v1/enrollments', fakeApi([]).fetcher)).toThrow(RangeError)
  })
})

describe('sandbox links', () => {
  it('points the session link at the screen', () => {
    const id = newSessionId()
    expect(sessionUrl(id)).toBe(`${SANDBOX_SCREEN_URL}/#session=${id}`)
    expect(sessionUrl(id, 'http://localhost:5173/')).toBe(`http://localhost:5173/#session=${id}`)
    expect(() => sessionUrl('nope')).toThrow(RangeError)
  })

  it('carries the commitment reference in the share link', () => {
    const link = new URL(verifyUrl(reference))
    expect(link.origin).toBe(SANDBOX_SCREEN_URL)
    const token = link.hash.replace('#verify=', '')
    expect(decodeCommitmentReference(token)).toEqual({ ok: true, value: reference })
  })
})
