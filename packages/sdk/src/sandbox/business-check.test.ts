import {
  type AvowDomain,
  type BusinessCheck,
  encodeApiBody,
  SANDBOX_PATHS,
  verifyApiRequest,
} from '@avow-finance/spec'
import { generatePrivateKey } from 'viem/accounts'
import { Account } from 'viem/tempo'
import { describe, expect, it } from 'vitest'
import { AvowApiError, rootRequestKey } from '../http.js'
import { sandboxBusinessChecks } from './business-check.js'

// The key is generated for the run and held only in memory.
const root = Account.fromSecp256k1(generatePrivateKey())
const domain: AvowDomain = {
  chainId: 42431,
  verifyingContract: '0x00000000000000000000000000000000000010c4',
}
const AUDIENCE = 'https://api.testnet.avow.finance'
const started: BusinessCheck = {
  state: 'started',
  by: 'didit',
  simulated: true,
  url: 'https://verify.example/session/1',
}
const passed: BusinessCheck = {
  state: 'passed',
  by: 'didit',
  simulated: true,
  decidedAt: '1763420400',
}

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
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const checks = (fetcher: typeof fetch) =>
  sandboxBusinessChecks({
    baseUrl: AUDIENCE,
    key: rootRequestKey(root),
    domain,
    fetch: fetcher,
    now: () => 1_800_000_000n,
    retryWait: 0,
  })

const signerOf = (s: Seen, path: string) => {
  const v = verifyApiRequest({
    audience: AUDIENCE,
    chainId: domain.chainId,
    method: 'POST',
    path,
    body: s.body,
    authorization: s.authorization,
  })
  return v.ok ? { signer: v.value.credentials.signer, lock: v.value.credentials.lock } : null
}

describe('sandboxBusinessChecks', () => {
  it("starts a check and reads it, each signed by the business's root key under its lock", async () => {
    const { seen, fetcher } = fakeApi([json(201, started), json(200, passed)])
    const c = checks(fetcher)
    expect(await c.start()).toEqual(started)
    expect(await c.read()).toEqual(passed)
    const paths = [SANDBOX_PATHS.businessChecks, SANDBOX_PATHS.businessCheck]
    expect(seen.map((s) => s.url)).toEqual(paths.map((p) => `${AUDIENCE}${p}`))
    for (const [i, s] of seen.entries()) {
      expect(s.body).toEqual(encodeApiBody({}))
      expect(signerOf(s, paths[i] as string)).toEqual({
        signer: root.address.toLowerCase(),
        lock: domain.verifyingContract,
      })
    }
  })

  it("throws Avow's refusal with its reason, and an answer that isn't a check", async () => {
    const refusal = json(401, { error: { reason: 'request.signer_unknown', message: 'no' } })
    const { fetcher } = fakeApi([refusal, json(200, { state: 'verified' })])
    const c = checks(fetcher)
    await expect(c.start()).rejects.toMatchObject({ reason: 'request.signer_unknown' })
    await expect(c.read()).rejects.toBeInstanceOf(AvowApiError)
  })
})
