import { createHash, generateKeyPairSync, type KeyObject, sign } from 'node:crypto'
import {
  type BlockEvent,
  CHALLENGE_TYPE,
  commitmentEvent,
  EVENT_DELIVERY_HEADERS,
  EVENT_KEYS_PATH,
  RETIRED_KEY_OVERLAP,
  toWire,
} from '@avow-finance/spec'
import type { Hex } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import { type EventDeliveryKey, eventDeliveryVerifier } from './event-delivery.js'

const NOW = 1_800_000_000n
const API = 'https://api.test'
const h = (byte: string): Hex => `0x${byte.repeat(32)}`

/** A key as Avow's API would list it, and its private half for signing deliveries. */
function key(retiredAt: bigint | null = null): { listed: EventDeliveryKey; privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const raw = Buffer.from(String(publicKey.export({ format: 'jwk' }).x), 'base64url')
  return {
    listed: {
      keyId: createHash('sha256').update(raw).digest('hex').slice(0, 16),
      algorithm: 'ed25519',
      publicKey: `whpk_${raw.toString('base64')}`,
      retiredAt: retiredAt === null ? null : retiredAt.toString(),
    },
    privateKey,
  }
}

const event = commitmentEvent({
  code: 'reserve.locked',
  commitment: {
    chainId: 42431,
    lock: '0x00000000000000000000000000000000000010c4',
    commitmentId: h('c1'),
  },
  source: 'block',
  at: NOW,
  blockNumber: 7n,
  transactionHash: h('ab'),
  logIndex: 0,
  termsHash: h('7e'),
  reserve: 500_000_000n,
  approvalHash: h('a9'),
  mandateHash: h('3a'),
}) as BlockEvent

const eventBody = JSON.stringify({
  type: event.code,
  timestamp: new Date(Number(NOW) * 1000).toISOString(),
  data: toWire(event),
})

/** A delivery as Avow's sender signs it. */
function delivery(
  k: ReturnType<typeof key>,
  body = eventBody,
  opts: { id?: string; at?: bigint; keyId?: string } = {},
) {
  const id = opts.id ?? h('e1')
  const at = String(opts.at ?? NOW)
  const signature = sign(null, Buffer.from(`${id}.${at}.${body}`), k.privateKey).toString('base64')
  return {
    headers: {
      [EVENT_DELIVERY_HEADERS.id]: id,
      [EVENT_DELIVERY_HEADERS.timestamp]: at,
      [EVENT_DELIVERY_HEADERS.signature]: `v1a,${signature}`,
      [EVENT_DELIVERY_HEADERS.keyId]: opts.keyId ?? k.listed.keyId,
    },
    body,
  }
}

/** Avow's keys route, answering with whatever keys the test holds at the moment it's read. */
function keysRoute(keys: () => EventDeliveryKey[]) {
  return vi.fn(async (url: string) => {
    expect(url).toBe(`${API}${EVENT_KEYS_PATH}`)
    return Response.json({ keys: keys() })
  })
}

const verifierWith = (fetch: ReturnType<typeof keysRoute>, now = () => NOW) =>
  eventDeliveryVerifier({ apiUrl: API, fetch: fetch as unknown as typeof globalThis.fetch, now })

describe('eventDeliveryVerifier', () => {
  it('takes a delivery Avow signed with a key it lists, and gives back the event', async () => {
    const k = key()
    const verify = verifierWith(keysRoute(() => [k.listed]))
    const d = delivery(k)
    expect(await verify(d.headers, d.body)).toEqual({
      ok: true,
      kind: 'event',
      id: h('e1'),
      event,
    })
  })

  it('reads headers from a fetch Headers object as well as a plain record', async () => {
    const k = key()
    const verify = verifierWith(keysRoute(() => [k.listed]))
    const d = delivery(k)
    expect((await verify(new Headers(d.headers), d.body)).ok).toBe(true)
  })

  it('refuses a body changed after signing, and a signature from any other key', async () => {
    const k = key()
    const other = key()
    const verify = verifierWith(keysRoute(() => [k.listed]))
    const d = delivery(k)
    expect(await verify(d.headers, d.body.replace('500000000', '600000000'))).toEqual({
      ok: false,
      reason: 'delivery.signature_invalid',
    })
    const forged = delivery(other, eventBody, { keyId: k.listed.keyId, id: h('e2') })
    expect(await verify(forged.headers, forged.body)).toMatchObject({
      reason: 'delivery.signature_invalid',
    })
  })

  it('refuses a delivery outside the window either side of this clock', async () => {
    const k = key()
    const verify = verifierWith(keysRoute(() => [k.listed]))
    for (const at of [NOW - 301n, NOW + 301n]) {
      const d = delivery(k, eventBody, { at })
      expect(await verify(d.headers, d.body)).toMatchObject({ reason: 'delivery.outside_window' })
    }
    const edge = delivery(k, eventBody, { at: NOW - 300n })
    expect((await verify(edge.headers, edge.body)).ok).toBe(true)
  })

  it('drops a repeat of an id it already took, signed again or not', async () => {
    const k = key()
    const verify = verifierWith(keysRoute(() => [k.listed]))
    const d = delivery(k)
    expect((await verify(d.headers, d.body)).ok).toBe(true)
    expect(await verify(d.headers, d.body)).toMatchObject({ reason: 'delivery.repeat' })
    const again = delivery(k, eventBody, { at: NOW + 5n })
    expect(await verify(again.headers, again.body)).toMatchObject({ reason: 'delivery.repeat' })
  })

  it('reads the keys once more for an id it holds none for, and refuses it if it still is not there', async () => {
    const k = key()
    const fetch = keysRoute(() => [k.listed])
    const verify = verifierWith(fetch)
    const unknown = delivery(k, eventBody, { keyId: 'ffffffffffffffff' })
    expect(await verify(unknown.headers, unknown.body)).toEqual({
      ok: false,
      reason: 'delivery.key_unknown',
    })
    expect(fetch).toHaveBeenCalledTimes(1)
    // A known key after that is served from the cache.
    const known = delivery(k)
    expect((await verify(known.headers, known.body)).ok).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('takes a new key once Avow lists it, on the one read again an unknown id gets', async () => {
    const old = key()
    const next = key()
    let listed = [old.listed]
    const fetch = keysRoute(() => listed)
    const verify = verifierWith(fetch)
    const first = delivery(old)
    expect((await verify(first.headers, first.body)).ok).toBe(true)
    listed = [next.listed, { ...old.listed, retiredAt: NOW.toString() }]
    const rotated = delivery(next, eventBody, { id: h('e2') })
    expect((await verify(rotated.headers, rotated.body)).ok).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('takes a retired key within the overlap after it retired, and refuses it after', async () => {
    const retired = key(NOW - RETIRED_KEY_OVERLAP)
    const verify = verifierWith(keysRoute(() => [retired.listed]))
    const inside = delivery(retired)
    expect((await verify(inside.headers, inside.body)).ok).toBe(true)
    const late = key(NOW - RETIRED_KEY_OVERLAP - 1n)
    const verifyLate = verifierWith(keysRoute(() => [late.listed]))
    const after = delivery(late)
    expect(await verifyLate(after.headers, after.body)).toMatchObject({
      reason: 'delivery.key_retired',
    })
  })

  it('gives back the answer a challenge asks for', async () => {
    const k = key()
    const verify = verifierWith(keysRoute(() => [k.listed]))
    const body = JSON.stringify({
      type: CHALLENGE_TYPE,
      timestamp: new Date(Number(NOW) * 1000).toISOString(),
      data: { endpointId: 'ab'.repeat(16), challenge: h('5c') },
    })
    const d = delivery(k, body, { id: h('5c') })
    expect(await verify(d.headers, d.body)).toEqual({
      ok: true,
      kind: 'challenge',
      id: h('5c'),
      answer: { challenge: h('5c') },
    })
  })

  it('refuses a signed body that is no event, or whose type is not its code', async () => {
    const k = key()
    const verify = verifierWith(keysRoute(() => [k.listed]))
    const wrongType = JSON.stringify({ type: 'charge.reported', data: toWire(event) })
    const a = delivery(k, wrongType, { id: h('f1') })
    expect(await verify(a.headers, a.body)).toMatchObject({ reason: 'delivery.body_invalid' })
    const notJson = delivery(k, 'not json', { id: h('f2') })
    expect(await verify(notJson.headers, notJson.body)).toMatchObject({
      reason: 'delivery.body_invalid',
    })
  })

  it('refuses a delivery missing a header', async () => {
    const k = key()
    const verify = verifierWith(keysRoute(() => [k.listed]))
    const d = delivery(k)
    const { [EVENT_DELIVERY_HEADERS.keyId]: _, ...rest } = d.headers
    expect(await verify(rest, d.body)).toEqual({ ok: false, reason: 'delivery.malformed' })
  })
})
