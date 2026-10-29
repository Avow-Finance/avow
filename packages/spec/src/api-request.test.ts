import { readFileSync } from 'node:fs'
import { P256 } from 'ox'
import { type Address, type Hex, keccak256, stringToHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { Account } from 'viem/tempo'
import { describe, expect, it } from 'vitest'
import {
  API_BODY_MAX_BYTES,
  type ApiCredentials,
  apiBodyHash,
  apiRequestExpiryProblem,
  apiRequestProblem,
  encodeApiBody,
  formatApiAuthorization,
  isApiAudience,
  newRequestId,
  parseApiAuthorization,
  type RequestKey,
  readApiBody,
  signApiRequest,
  verifyApiRequest,
} from './api-request.js'
import { type AvowDomain, apiRequestTypedData, digestOf } from './eip712.js'
import { CHAIN_ID, DOMAIN, id, NOW, newKey, OTHER_LOCK } from './test-helpers.js'

// Every key is generated for the run or made from a public label, and held only in memory.
const AUDIENCE = 'https://api.testnet.avow.finance'
const PATH = '/v1/sponsorships'
const body = encodeApiBody({ transaction: '0x1234' })
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

/** What the API checks at steps 1 and 2, for the request as it arrived. */
const verify = (
  authorization: string,
  received: {
    audience?: string
    method?: string
    path?: string
    body?: Uint8Array
    chainId?: number
  } = {},
) =>
  verifyApiRequest({
    audience: received.audience ?? AUDIENCE,
    chainId: received.chainId ?? CHAIN_ID,
    method: received.method ?? 'POST',
    path: received.path ?? PATH,
    body: received.body ?? body,
    authorization,
  })

describe('signed API requests', () => {
  for (const [name, make] of [
    ['a secp256k1 key', secpKey],
    ['a passkey', passkey],
  ] as const) {
    it(`${name}: the request the API rebuilds verifies, with the digest the client signed`, async () => {
      const key = make()
      const signed = await sign(key)
      const verified = verify(signed.authorization)
      expect(verified.ok && verified.value.digest).toBe(signed.digest)
      expect(verified.ok && verified.value.request).toEqual(signed.request)
      expect(signed.request.message).toEqual({
        audience: AUDIENCE,
        method: 'POST',
        path: PATH,
        bodyHash: apiBodyHash(body),
        signer: key.address.toLowerCase(),
        requestId: REQUEST_ID,
        expiry: NOW + 120n,
      })
    })

    it(`${name}: fits no other deployment, method, path, body, chain, lock, id, expiry or signer`, async () => {
      const { authorization } = await sign(make())
      const credentials = parseApiAuthorization(authorization) as ApiCredentials
      const changed = (c: Partial<ApiCredentials>) =>
        formatApiAuthorization({ ...credentials, ...c })
      const refused = [
        verify(authorization, { audience: 'https://api.staging.avow.finance' }),
        verify(authorization, { audience: 'http://api.testnet.avow.finance' }),
        verify(authorization, { method: 'GET', body: new Uint8Array() }),
        verify(authorization, { path: '/v1/reserve-approvals' }),
        verify(authorization, { body: encodeApiBody({ transaction: '0x1235' }) }),
        verify(authorization, { chainId: CHAIN_ID + 1 }),
        verify(changed({ lock: OTHER_LOCK })),
        verify(changed({ requestId: id('request-2') })),
        verify(changed({ expiry: NOW + 121n })),
        verify(changed({ signer: newKey().address })),
      ]
      for (const result of refused) {
        expect(result).toEqual({ ok: false, reason: 'message.signature_invalid' })
      }
    })
  }

  it('refuses a request out of form, or unsigned, before checking any signature', async () => {
    const { authorization } = await sign(secpKey())
    expect(verify(authorization, { path: '/v1/sponsorships?retry=1' })).toEqual({
      ok: false,
      reason: 'request.invalid',
    })
    expect(verify('Bearer abc')).toEqual({ ok: false, reason: 'request.unsigned' })
    expect(
      verifyApiRequest({
        audience: AUDIENCE,
        chainId: CHAIN_ID,
        method: 'POST',
        path: PATH,
        body,
        authorization: undefined,
      }),
    ).toEqual({ ok: false, reason: 'request.unsigned' })
  })

  it('refuses to sign a request the API would refuse', async () => {
    const base = {
      key: secpKey(),
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
    await expect(signApiRequest({ ...base, audience: `${AUDIENCE}:443` })).rejects.toThrow(
      /request.invalid/,
    )
    await expect(signApiRequest({ ...base, requestId: '0x1234' })).rejects.toThrow(/32 bytes/)
  })

  it('hashes an empty body as no bytes, and makes a fresh 32-byte id each time', () => {
    expect(apiBodyHash(new Uint8Array())).toBe(
      '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
    )
    const a = newRequestId()
    expect(a).toMatch(/^0x[0-9a-f]{64}$/)
    expect(newRequestId()).not.toBe(a)
  })

  it('starts a request only while its expiry is ahead, and at most five minutes ahead', () => {
    expect(apiRequestExpiryProblem(NOW, NOW)).toBe('message.expired')
    expect(apiRequestExpiryProblem(NOW + 1n, NOW)).toBeNull()
    expect(apiRequestExpiryProblem(NOW + 300n, NOW)).toBeNull()
    expect(apiRequestExpiryProblem(NOW + 301n, NOW)).toBe('message.validity_too_long')
  })
})

describe('request bodies', () => {
  it('writes canonical JSON, with bigints as decimal strings, and reads it back', () => {
    const value = { b: 1, a: { d: 500_000_000n, c: ['x', true, null] }, e: 'São Paulo' }
    const bytes = encodeApiBody(value)
    expect(new TextDecoder().decode(bytes)).toBe(
      '{"a":{"c":["x",true,null],"d":"500000000"},"b":1,"e":"São Paulo"}',
    )
    expect(readApiBody(bytes)).toEqual({
      ok: true,
      value: { a: { c: ['x', true, null], d: '500000000' }, b: 1, e: 'São Paulo' },
    })
    expect(readApiBody(new Uint8Array())).toEqual({ ok: true, value: undefined })
  })

  it('refuses a body two readers could read differently', () => {
    const text = (s: string) => new TextEncoder().encode(s)
    const refused = [
      text('{"transaction":"0x1111","transaction":"0x2222"}'),
      text('{"b":1,"a":2}'),
      text('{"a": 1}'),
      text('{"a":1}\n'),
      text('{"a":1.5}'),
      text('{"a":9007199254740993}'),
      text('﻿{"a":1}'),
      text('not json'),
      new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]),
    ]
    for (const b of refused)
      expect(readApiBody(b)).toEqual({ ok: false, reason: 'request.invalid' })
  })
})

describe('form', () => {
  const ok = { audience: AUDIENCE, method: 'POST', path: PATH, body }

  it('takes the forms the page sets out', () => {
    expect(apiRequestProblem(ok)).toBeNull()
    expect(apiRequestProblem({ ...ok, audience: 'http://localhost:8787' })).toBeNull()
    expect(
      apiRequestProblem({ ...ok, path: `/v1/commitments/${id('c')}/supplier-authorizations` }),
    ).toBeNull()
    expect(apiRequestProblem({ ...ok, method: 'GET', body: new Uint8Array() })).toBeNull()
    expect(apiRequestProblem({ ...ok, body: new Uint8Array(API_BODY_MAX_BYTES) })).toBeNull()
  })

  it('refuses every other method, path or body', () => {
    const refused = [
      { ...ok, method: 'post' },
      { ...ok, method: 'PUT' },
      { ...ok, path: '/v1' },
      { ...ok, path: '/v2/sponsorships' },
      { ...ok, path: '/v1/sponsorships/' },
      { ...ok, path: '/v1/sponsorships?x=1' },
      { ...ok, path: '/v1/sponsorships#x' },
      { ...ok, path: '/v1/../v1/sponsorships' },
      { ...ok, path: '/v1/./sponsorships' },
      { ...ok, path: '/v1/Sponsorships' },
      { ...ok, path: '/v1/spon%73orships' },
      { ...ok, path: '//v1/sponsorships' },
      { ...ok, path: 'https://api.testnet.avow.finance/v1/sponsorships' },
      { ...ok, method: 'GET' },
      { ...ok, body: new Uint8Array(API_BODY_MAX_BYTES + 1) },
    ]
    for (const r of refused)
      expect(apiRequestProblem(r), `${r.method} ${r.path} ${r.body.length}`).toBe('request.invalid')
  })

  it('takes one canonical audience for each deployment', () => {
    for (const a of [
      AUDIENCE,
      'http://localhost',
      'http://localhost:8787',
      'https://api.avow.finance:8443',
      'http://127.0.0.1:3000',
    ]) {
      expect(isApiAudience(a), a).toBe(true)
    }
    for (const a of [
      `${AUDIENCE}/`,
      `${AUDIENCE}/v1`,
      `${AUDIENCE}:443`,
      'http://localhost:80',
      'http://localhost:080',
      'http://localhost:0',
      'http://localhost:65536',
      'https://API.testnet.avow.finance',
      'https://api..avow.finance',
      'https://-api.avow.finance',
      'https://api.avow.finance.',
      'ftp://api.testnet.avow.finance',
      'https://user@api.testnet.avow.finance',
      'api.testnet.avow.finance',
    ]) {
      expect(isApiAudience(a), a).toBe(false)
    }
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
      `${header}, ${header}`,
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

/**
 * The vectors another implementation checks itself against, in `vectors/api-request-v1.json`.
 * `scripts/write-api-request-vectors.mjs` wrote them. This fails when the code and the file disagree.
 */
describe('pinned vectors', () => {
  const file = JSON.parse(
    readFileSync(new URL('../vectors/api-request-v1.json', import.meta.url), 'utf8'),
  ) as { vectors: Record<string, string>[] }
  const key = privateKeyToAccount(keccak256(stringToHex('avow api request vector key')))

  it('holds three vectors', () => expect(file.vectors).toHaveLength(3))

  for (const v of file.vectors) {
    it(`${v.name}: body, hash, digest, signature and header match`, async () => {
      const bytes = new TextEncoder().encode(v.body)
      expect(apiBodyHash(bytes)).toBe(v.bodyHash)
      const domain = { chainId: Number(v.chainId), verifyingContract: v.lock as Address }
      const message = {
        audience: v.audience as string,
        method: v.method as string,
        path: v.path as string,
        bodyHash: v.bodyHash as Hex,
        signer: v.signer as Address,
        requestId: v.requestId as Hex,
        expiry: BigInt(v.expiry as string),
      }
      expect(digestOf(apiRequestTypedData(message, domain))).toBe(v.digest)
      const verified = verifyApiRequest({
        audience: v.audience as string,
        chainId: domain.chainId,
        method: v.method as string,
        path: v.path as string,
        body: bytes,
        authorization: v.authorization,
      })
      expect(verified.ok && verified.value.digest).toBe(v.digest)
      const resigned = await signApiRequest({
        key: { address: key.address, signDigest: (hash) => key.sign({ hash }) },
        domain,
        audience: message.audience,
        method: message.method,
        path: message.path,
        body: bytes,
        requestId: message.requestId,
        expiry: message.expiry,
      })
      expect(resigned.authorization).toBe(v.authorization)
      if (bytes.length > 0) expect(readApiBody(bytes).ok).toBe(true)
    })
  }
})
