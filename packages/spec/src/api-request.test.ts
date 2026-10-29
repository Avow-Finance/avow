import { P256 } from 'ox'
import type { Address, Hex } from 'viem'
import { Account } from 'viem/tempo'
import { describe, expect, it } from 'vitest'
import {
  type ApiCredentials,
  apiBodyHash,
  apiRequestOf,
  apiRequestProblem,
  formatApiAuthorization,
  newRequestId,
  parseApiAuthorization,
  type RequestKey,
  signApiRequest,
} from './api-request.js'
import { type AvowDomain, apiRequestTypedData, digestOf } from './eip712.js'
import { isKeySignature } from './keychain.js'
import { CHAIN_ID, DOMAIN, id, NOW, newKey, OTHER_LOCK } from './test-helpers.js'

// Every key is generated for the run and held only in memory.
const AUDIENCE = 'https://api.testnet.avow.finance'
const PATH = '/v1/sponsorships'
const body = new TextEncoder().encode('{"transaction":"0x1234"}')
const REQUEST_ID = id('request-1')

function secpKey(): RequestKey {
  const account = newKey()
  return { address: account.address, signDigest: (hash) => account.sign({ hash }) }
}

function passkey(): RequestKey {
  const root = Account.fromHeadlessWebAuthn(P256.randomPrivateKey(), {
    rpId: 'avow.finance',
    origin: 'https://avow.finance',
  })
  return { address: root.address as Address, signDigest: (hash) => root.sign({ hash }) }
}

const sign = (key: RequestKey, d: AvowDomain = DOMAIN) =>
  signApiRequest({
    key,
    domain: d,
    audience: AUDIENCE,
    method: 'POST',
    path: PATH,
    body,
    requestId: REQUEST_ID,
    expiry: NOW + 120n,
  })

/** What the API checks: the request rebuilt from what it received, under the header's lock. */
function verifies(
  received: { audience?: string; method?: string; path?: string; body?: Uint8Array },
  header: string,
  chainId = CHAIN_ID,
): boolean {
  const credentials = parseApiAuthorization(header)
  if (!credentials) return false
  const request = apiRequestOf({
    audience: received.audience ?? AUDIENCE,
    method: received.method ?? 'POST',
    path: received.path ?? PATH,
    body: received.body ?? body,
    credentials,
  })
  const digest = digestOf(
    apiRequestTypedData(request, { chainId, verifyingContract: credentials.lock }),
  )
  return isKeySignature(digest, credentials.signature, credentials.signer)
}

describe('signed API requests', () => {
  for (const [name, make] of [
    ['a secp256k1 key', secpKey],
    ['a passkey', passkey],
  ] as const) {
    it(`${name}: the request the API rebuilds verifies against the header`, async () => {
      const key = make()
      const { authorization, request } = await sign(key)
      expect(verifies({}, authorization)).toBe(true)
      expect(request.message).toEqual({
        audience: AUDIENCE,
        method: 'POST',
        path: PATH,
        bodyHash: apiBodyHash(body),
        signer: key.address,
        requestId: REQUEST_ID,
        expiry: NOW + 120n,
      })
      expect(request).toMatchObject({
        type: 'ApiRequest',
        chainId: CHAIN_ID,
        lock: DOMAIN.verifyingContract,
      })
    })
  }

  it('fits no other deployment, method, path, body, chain, lock, request id or expiry', async () => {
    const { authorization } = await sign(secpKey())
    const credentials = parseApiAuthorization(authorization) as ApiCredentials
    const changed = (c: Partial<ApiCredentials>) => formatApiAuthorization({ ...credentials, ...c })
    expect(verifies({ audience: 'https://api.staging.avow.finance' }, authorization)).toBe(false)
    expect(verifies({ audience: 'http://api.testnet.avow.finance' }, authorization)).toBe(false)
    expect(verifies({ method: 'GET' }, authorization)).toBe(false)
    expect(verifies({ path: '/v1/reserve-approvals' }, authorization)).toBe(false)
    expect(
      verifies({ body: new TextEncoder().encode('{"transaction":"0x1235"}') }, authorization),
    ).toBe(false)
    expect(
      verifies({ body: new TextEncoder().encode('{"transaction": "0x1234"}') }, authorization),
    ).toBe(false)
    expect(verifies({}, authorization, CHAIN_ID + 1)).toBe(false)
    expect(verifies({}, changed({ lock: OTHER_LOCK }))).toBe(false)
    expect(verifies({}, changed({ requestId: id('request-2') }))).toBe(false)
    expect(verifies({}, changed({ expiry: NOW + 121n }))).toBe(false)
    expect(verifies({}, changed({ signer: newKey().address }))).toBe(false)
  })

  it('refuses to sign a request the API would refuse', async () => {
    const key = secpKey()
    const base = {
      key,
      domain: DOMAIN,
      audience: AUDIENCE,
      method: 'POST',
      path: PATH,
      body,
      requestId: REQUEST_ID,
      expiry: NOW + 120n,
    }
    await expect(signApiRequest({ ...base, path: '/v1/sponsorships?retry=1' })).rejects.toThrow(
      /request.invalid/,
    )
    await expect(signApiRequest({ ...base, requestId: '0x1234' })).rejects.toThrow(/32 bytes/)
  })

  it('hashes an empty body as no bytes', () => {
    expect(apiBodyHash(new Uint8Array())).toBe(
      '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
    )
  })

  it('makes a fresh 32-byte request id each time', () => {
    const a = newRequestId()
    expect(a).toMatch(/^0x[0-9a-f]{64}$/)
    expect(newRequestId()).not.toBe(a)
  })
})

describe('apiRequestProblem', () => {
  const ok = { audience: AUDIENCE, method: 'POST', path: PATH, body }

  it('takes the forms the page sets out', () => {
    expect(apiRequestProblem(ok)).toBeNull()
    expect(apiRequestProblem({ ...ok, audience: 'http://localhost:8787' })).toBeNull()
    expect(
      apiRequestProblem({ ...ok, path: `/v1/commitments/${id('c')}/supplier-authorizations` }),
    ).toBeNull()
    expect(apiRequestProblem({ ...ok, method: 'GET', body: new Uint8Array() })).toBeNull()
  })

  it('refuses every other audience, method, path or body', () => {
    const refused = [
      { ...ok, audience: 'https://api.testnet.avow.finance/' },
      { ...ok, audience: 'https://API.testnet.avow.finance' },
      { ...ok, audience: 'https://api.testnet.avow.finance/v1' },
      { ...ok, audience: 'ftp://api.testnet.avow.finance' },
      { ...ok, method: 'post' },
      { ...ok, method: 'PUT' },
      { ...ok, path: '/v1' },
      { ...ok, path: '/v2/sponsorships' },
      { ...ok, path: '/v1/sponsorships/' },
      { ...ok, path: '/v1/sponsorships?x=1' },
      { ...ok, path: '/v1/../v1/sponsorships' },
      { ...ok, path: '/v1/./sponsorships' },
      { ...ok, path: '/v1/Sponsorships' },
      { ...ok, path: '/v1/spon%73orships' },
      { ...ok, path: `/v1/commitments/${id('c').toUpperCase().replace('0X', '0x')}` },
      { ...ok, method: 'GET' },
      { ...ok, body: new Uint8Array(65_537) },
    ]
    for (const r of refused)
      expect(apiRequestProblem(r), JSON.stringify({ ...r, body: r.body.length })).toBe(
        'request.invalid',
      )
  })
})

describe('parseApiAuthorization', () => {
  const good: ApiCredentials = {
    signer: newKey().address.toLowerCase() as Address,
    lock: DOMAIN.verifyingContract.toLowerCase() as Address,
    requestId: REQUEST_ID,
    expiry: NOW,
    signature: `0x${'ab'.repeat(65)}` as Hex,
  }

  it('reads back what it formats, with hex in lower case', () => {
    const mixed = { ...good, signer: newKey().address }
    expect(parseApiAuthorization(formatApiAuthorization(good))).toEqual(good)
    expect(parseApiAuthorization(formatApiAuthorization(mixed))?.signer).toBe(
      mixed.signer.toLowerCase(),
    )
  })

  it('refuses anything else', () => {
    const header = formatApiAuthorization(good)
    const refused = [
      undefined,
      null,
      '',
      header.replace('Avow ', 'Bearer '),
      header.replace('Avow ', 'Avow  '),
      `${header}, extra=1`,
      `${header}, expiry=6`,
      header.replace(/, expiry=\d+/, ''),
      header.replace('signer=0x', 'signer=0X'),
      header.replace(/signer=0x[0-9a-f]+/, 'signer=0x1234'),
      header.replace(/requestId=0x[0-9a-f]+/, 'requestId=0x1234'),
      header.replace(/requestId=0x[0-9a-f]+/, 'requestId=5'),
      header.replace(/expiry=\d+/, 'expiry=05'),
      header.replace(/expiry=\d+/, 'expiry=-5'),
      header.replace(/expiry=\d+/, `expiry=${2n ** 64n}`),
      header.replace(/signature=0x[0-9a-f]+/, 'signature=0x'),
      header.replace(/signature=0x[0-9a-f]+/, 'signature=0xabc'),
      header.replaceAll(', ', ','),
    ]
    for (const h of refused) expect(parseApiAuthorization(h), String(h)).toBeNull()
  })
})
