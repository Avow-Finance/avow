import {
  CHALLENGE_TYPE,
  type CommitmentEvent,
  EVENT_DELIVERY_HEADERS,
  EVENT_DELIVERY_TOLERANCE,
  EVENT_KEYS_CACHE,
  EVENT_KEYS_PATH,
  parseCommitmentEvent,
  RETIRED_KEY_OVERLAP,
} from '@avow-finance/spec'

/** One of the keys Avow signs deliveries with, as `EVENT_KEYS_PATH` lists it. */
export interface EventDeliveryKey {
  keyId: string
  algorithm: 'ed25519'
  /** Standard Webhooks' form for a public key: `whpk_` and the key's 32 bytes in base64. */
  publicKey: string
  /** Unix seconds, once a newer key replaced it. */
  retiredAt: string | null
}

/** Why a delivery is refused. Each is final for the delivery as it came. */
export type DeliveryRefusal =
  /** A header is missing or isn't in Standard Webhooks' form. */
  | 'delivery.malformed'
  /** The timestamp is more than `EVENT_DELIVERY_TOLERANCE` from this machine's clock. */
  | 'delivery.outside_window'
  /** The key id names no key Avow lists, even after reading the keys again. */
  | 'delivery.key_unknown'
  /** The key was retired more than `RETIRED_KEY_OVERLAP` before the delivery's timestamp. */
  | 'delivery.key_retired'
  /** No `v1a` signature in the header verifies under the key. */
  | 'delivery.signature_invalid'
  /** A delivery with this id already verified inside the window. */
  | 'delivery.repeat'
  /** The body is signed but isn't a commitment event or a challenge. */
  | 'delivery.body_invalid'

/** What a delivery is, once it verifies. */
export type VerifiedDelivery =
  | {
      ok: true
      kind: 'event'
      id: string
      /**
       * The event as Avow sent it. It's a notice: it grants nothing and proves nothing about the
       * lock. Read the lock with the verifier before acting on it.
       */
      event: CommitmentEvent
    }
  | {
      ok: true
      kind: 'challenge'
      id: string
      /** What to answer the delivery with, as JSON with a 2xx status, to prove the address. */
      answer: { challenge: string }
    }

/** A record of the delivery ids already taken, kept at least `EVENT_DELIVERY_TOLERANCE`. */
export interface SeenDeliveries {
  /** Records the id, and says whether it was already there. */
  seen(id: string, now: bigint): boolean | Promise<boolean>
}

/**
 * A record kept in this process's memory, which forgets an id once the window has passed. A
 * receiver that runs more than one process gives them one shared record of its own.
 */
export function memorySeenDeliveries(): SeenDeliveries {
  const ids = new Map<string, bigint>()
  return {
    seen(id, now) {
      for (const [k, at] of ids) if (now - at > EVENT_DELIVERY_TOLERANCE * 2n) ids.delete(k)
      if (ids.has(id)) return true
      ids.set(id, now)
      return false
    },
  }
}

export interface EventDeliveryVerifierOptions {
  /** Avow's API, such as `https://api.testnet.avow.finance`, whose keys every delivery is checked against. */
  apiUrl: string
  fetch?: typeof fetch
  /** Unix seconds. */
  now?: () => bigint
  seen?: SeenDeliveries
}

const decode64 = (text: string): Uint8Array | null => {
  try {
    return Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
  } catch {
    return null
  }
}

/** A header's value, whichever way the receiver's server hands headers over. */
type Headers_ = Headers | Record<string, string | string[] | undefined>
const headerOf = (headers: Headers_, name: string): string | null => {
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name)
  const value = Object.entries(headers as Record<string, unknown>).find(
    ([k]) => k.toLowerCase() === name,
  )?.[1]
  return typeof value === 'string' ? value : Array.isArray(value) ? (value[0] ?? null) : null
}

/**
 * Checks deliveries of commitment events from Avow. Each delivery has to carry Standard Webhooks'
 * headers, a timestamp inside `EVENT_DELIVERY_TOLERANCE` of this machine's clock, an id not seen
 * inside the window, and a `v1a` Ed25519 signature over `id.timestamp.body` under the key its
 * `avow-key-id` names. The keys are read from Avow's API and cached for at most five minutes. An
 * id that isn't among them has the keys read once more, and a delivery whose key still isn't there
 * is refused. A retired key verifies a delivery only within `RETIRED_KEY_OVERLAP` of retiring.
 *
 * Pass the body exactly as it arrived, before any JSON parsing, since the signature covers its
 * bytes. A delivery that verifies is a notice from Avow: it grants nothing, and before acting on
 * an event, read the lock it names with the verifier.
 */
export function eventDeliveryVerifier(options: EventDeliveryVerifierOptions) {
  const get = options.fetch ?? fetch
  const now = options.now ?? (() => BigInt(Math.floor(Date.now() / 1000)))
  const seen = options.seen ?? memorySeenDeliveries()
  let cached: { keys: EventDeliveryKey[]; at: bigint } | null = null

  async function readKeys(): Promise<EventDeliveryKey[]> {
    const response = await get(`${options.apiUrl}${EVENT_KEYS_PATH}`, {
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`Avow's keys answered ${response.status}`)
    const json = (await response.json()) as { keys?: unknown }
    const keys = Array.isArray(json.keys) ? json.keys.filter(isKey) : []
    cached = { keys, at: now() }
    return keys
  }

  async function keyFor(keyId: string): Promise<EventDeliveryKey | null> {
    const fresh = cached !== null && now() - cached.at < EVENT_KEYS_CACHE
    const held = fresh ? cached?.keys.find((k) => k.keyId === keyId) : undefined
    if (held) return held
    // One read again, for a key Avow started using since. Never more, and never a fallback.
    return (await readKeys()).find((k) => k.keyId === keyId) ?? null
  }

  return async function verify(
    headers: Headers_,
    body: string,
  ): Promise<VerifiedDelivery | { ok: false; reason: DeliveryRefusal }> {
    const no = (reason: DeliveryRefusal) => ({ ok: false, reason }) as const
    const id = headerOf(headers, EVENT_DELIVERY_HEADERS.id)
    const stamp = headerOf(headers, EVENT_DELIVERY_HEADERS.timestamp)
    const signatures = headerOf(headers, EVENT_DELIVERY_HEADERS.signature)
    const keyId = headerOf(headers, EVENT_DELIVERY_HEADERS.keyId)
    if (!id || !stamp || !signatures || !keyId || !/^[0-9]{1,12}$/.test(stamp)) {
      return no('delivery.malformed')
    }
    const timestamp = BigInt(stamp)
    const clock = now()
    const off = timestamp > clock ? timestamp - clock : clock - timestamp
    if (off > EVENT_DELIVERY_TOLERANCE) return no('delivery.outside_window')
    const key = await keyFor(keyId)
    if (!key) return no('delivery.key_unknown')
    if (key.retiredAt !== null && timestamp > BigInt(key.retiredAt) + RETIRED_KEY_OVERLAP) {
      return no('delivery.key_retired')
    }
    const raw = decode64(key.publicKey.slice('whpk_'.length))
    if (raw?.length !== 32) return no('delivery.key_unknown')
    const publicKey = await crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, false, [
      'verify',
    ])
    const content = new TextEncoder().encode(`${id}.${stamp}.${body}`)
    let verified = false
    for (const part of signatures.split(' ')) {
      const [version, value] = part.split(',')
      if (version !== 'v1a' || !value) continue
      const signature = decode64(value)
      if (signature && (await crypto.subtle.verify('Ed25519', publicKey, signature, content))) {
        verified = true
        break
      }
    }
    if (!verified) return no('delivery.signature_invalid')
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      return no('delivery.body_invalid')
    }
    const envelope = parsed as { type?: unknown; data?: unknown }
    let delivery: VerifiedDelivery
    if (envelope.type === CHALLENGE_TYPE) {
      const challenge = (envelope.data as { challenge?: unknown } | null)?.challenge
      if (typeof challenge !== 'string' || !/^0x[0-9a-f]{64}$/.test(challenge)) {
        return no('delivery.body_invalid')
      }
      delivery = { ok: true, kind: 'challenge', id, answer: { challenge } }
    } else {
      const event = parseCommitmentEvent(envelope.data)
      if (!event.ok || event.value.code !== envelope.type) return no('delivery.body_invalid')
      delivery = { ok: true, kind: 'event', id, event: event.value }
    }
    // Recorded last, so a delivery that fails a check can come again once it's fixed.
    if (await seen.seen(id, clock)) return no('delivery.repeat')
    return delivery
  }
}

const isKey = (k: unknown): k is EventDeliveryKey => {
  const key = k as Partial<EventDeliveryKey> | null
  return (
    typeof key?.keyId === 'string' &&
    key.algorithm === 'ed25519' &&
    typeof key.publicKey === 'string' &&
    key.publicKey.startsWith('whpk_') &&
    (key.retiredAt === null ||
      (typeof key.retiredAt === 'string' && /^[0-9]+$/.test(key.retiredAt)))
  )
}
