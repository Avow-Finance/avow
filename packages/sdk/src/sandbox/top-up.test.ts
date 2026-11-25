import {
  type AvowDomain,
  encodeApiBody,
  SANDBOX_PATHS,
  type TopUp,
  verifyApiRequest,
} from '@avow-finance/spec'
import { generatePrivateKey } from 'viem/accounts'
import { Account } from 'viem/tempo'
import { describe, expect, it } from 'vitest'
import { AvowApiError, rootRequestKey } from '../http.js'
import { sandboxTopUp } from './top-up.js'

// The key is generated for the run and held only in memory.
const root = Account.fromSecp256k1(generatePrivateKey())
const domain: AvowDomain = {
  chainId: 42431,
  verifyingContract: '0x00000000000000000000000000000000000010c4',
}
const AUDIENCE = 'https://api.testnet.avow.finance'
const sent: TopUp = {
  state: 'sent',
  amount: '1500000000',
  transactionHash: `0x${'ab'.repeat(32)}`,
  outcome: 'pending',
  nextAt: '1800086400',
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

const topUp = (fetcher: typeof fetch) =>
  sandboxTopUp({
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

describe('sandboxTopUp', () => {
  it("asks once with an empty body, signed by the key it's given under the business's lock", async () => {
    const { seen, fetcher } = fakeApi([json(201, sent)])
    expect(await topUp(fetcher)).toEqual(sent)
    expect(seen.map((s) => s.url)).toEqual([`${AUDIENCE}${SANDBOX_PATHS.topUps}`])
    const [s] = seen
    expect(s?.body).toEqual(encodeApiBody({}))
    expect(s && signerOf(s, SANDBOX_PATHS.topUps)).toEqual({
      signer: root.address.toLowerCase(),
      lock: domain.verifyingContract,
    })
  })

  it('gives a business that had its top-up today when it can ask again', async () => {
    const { fetcher } = fakeApi([json(200, { state: 'not_yet', nextAt: '1800086400' })])
    expect(await topUp(fetcher)).toEqual({ state: 'not_yet', nextAt: '1800086400' })
  })

  it("throws Avow's refusal with its reason, and an answer that isn't a top-up", async () => {
    const refusal = json(409, { error: { reason: 'sandbox.pool_empty', message: 'empty' } })
    await expect(topUp(fakeApi([refusal]).fetcher)).rejects.toMatchObject({
      reason: 'sandbox.pool_empty',
    })
    const wrong = json(201, { ...sent, outcome: 'reverted' })
    await expect(topUp(fakeApi([wrong]).fetcher)).rejects.toBeInstanceOf(AvowApiError)
  })
})
