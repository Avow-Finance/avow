import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { enforceableTerms, toWire } from '@avow-finance/spec'
import { type Address, formatUnits, type Hex } from 'viem'
import { z } from 'zod'
import type { Booking, BookingStatus } from './store.js'

/**
 * What the webhook tells the supplier's own system, one event for each status a booking reaches
 * that the system acts on. `booking.agreed` once the supplier signed the agent's agreement, so the
 * capacity is spoken for while the agent funds its reserve. `reserve.held` once Avow authorized the
 * funded reserve and the verifier passed it, so the system holds the capacity. `reserve.accepted`
 * once the lock took the supplier's acceptance, which is when the system grants the capacity.
 * `booking.lapsed` when no reserve came before the acceptance deadline, so the capacity is free.
 */
export const WEBHOOK_EVENTS = {
  agreed: 'booking.agreed',
  held: 'reserve.held',
  accepted: 'reserve.accepted',
  lapsed: 'booking.lapsed',
} as const satisfies Partial<Record<BookingStatus, string>>

export type WebhookEventType = (typeof WEBHOOK_EVENTS)[keyof typeof WEBHOOK_EVENTS]

/** What every event says about its booking. Money is in dollars and times are ISO 8601 in UTC. */
export interface BookingEventData {
  commitmentId: Hex
  chainId: number
  lock: Address
  buyerBusinessId: string
  supplierBusinessId: string
  /** The most the supplier can charge on this booking, the reserve the business funds. */
  reserveDollars: string
  /** When the agreement the supplier signed lapses if no reserve arrives. */
  agreementExpiresAt: string
  /** The acceptance's transaction on the lock, once `reserve.accepted` has it. */
  acceptanceTransaction: Hex | null
  /** The terms both sides signed, as the spec writes them. */
  terms: unknown
}

export interface WebhookEvent {
  /** The same for every delivery of one event, so a receiver handles each id once. */
  id: string
  type: WebhookEventType
  createdAt: string
  data: BookingEventData
}

const MICROS = 6
const iso = (seconds: bigint) => new Date(Number(seconds) * 1000).toISOString()

/**
 * The event a booking's status calls for, or null for a status that calls for none. Its id comes
 * from the commitment and the status alone, so recording the same transition twice, after a
 * restart for one, gives one event.
 */
export function bookingEvent(booking: Booking, now: Date): WebhookEvent | null {
  const type = (WEBHOOK_EVENTS as Partial<Record<BookingStatus, WebhookEventType>>)[booking.status]
  if (!type) return null
  return {
    id: `msg_${booking.commitmentId.slice(2).toLowerCase()}_${booking.status}`,
    type,
    createdAt: now.toISOString(),
    data: {
      commitmentId: booking.commitmentId,
      chainId: booking.chainId,
      lock: booking.lock,
      buyerBusinessId: booking.agreement.buyerBusinessId,
      supplierBusinessId: booking.agreement.supplierBusinessId,
      reserveDollars: formatUnits(enforceableTerms(booking.terms).reserve, MICROS),
      agreementExpiresAt: iso(booking.agreement.expiry),
      acceptanceTransaction: booking.status === 'accepted' ? (booking.sent?.hash ?? null) : null,
      terms: toWire(booking.terms),
    },
  }
}

// Signing follows the Standard Webhooks specification, so a receiver in any language can check a
// delivery with that project's libraries. The secret is `whsec_` and base64, and the signature is
// HMAC-SHA256 over `${id}.${timestamp}.${body}`, sent as `v1,` and base64.

const SECRET = /^whsec_([A-Za-z0-9+/]{32,}={0,2})$/

/** Whether a string is a webhook secret this adapter can sign with. */
export const isWebhookSecret = (secret: string) => SECRET.test(secret)

/** A new webhook secret, 32 random bytes. */
export const makeWebhookSecret = () => `whsec_${randomBytes(32).toString('base64')}`

function keyOf(secret: string): Buffer {
  const match = SECRET.exec(secret)
  if (!match?.[1]) throw new Error('A webhook secret is whsec_ followed by base64')
  return Buffer.from(match[1], 'base64')
}

/** The `webhook-signature` header value for a delivery. */
export function signWebhook(secret: string, id: string, timestamp: number, body: string): string {
  const mac = createHmac('sha256', keyOf(secret)).update(`${id}.${timestamp}.${body}`).digest()
  return `v1,${mac.toString('base64')}`
}

/**
 * Whether a delivery came from this adapter: its signature matches the body under the secret and
 * its timestamp is within five minutes of now, so an old delivery can't be replayed. A receiver
 * written in TypeScript can use it, and any Standard Webhooks library does the same.
 */
export function verifyWebhook(
  secret: string,
  headers: { id: string; timestamp: string; signature: string },
  body: string,
  nowSeconds: number,
  toleranceSeconds = 300,
): boolean {
  const timestamp = Number(headers.timestamp)
  if (!Number.isSafeInteger(timestamp)) return false
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false
  const expected = Buffer.from(signWebhook(secret, headers.id, timestamp, body))
  return headers.signature.split(' ').some((given) => {
    const g = Buffer.from(given)
    return g.length === expected.length && timingSafeEqual(g, expected)
  })
}

/** How long after the last failed delivery each retry waits, then the last wait over again. */
const RETRY_AFTER_MS = [5_000, 30_000, 120_000, 600_000, 1_800_000, 3_600_000, 10_800_000]
/** How long the adapter keeps trying before it gives an event up. */
const GIVE_UP_AFTER_MS = 3 * 24 * 3_600_000

const hex = <T extends Hex>(pattern: RegExp) =>
  z
    .string()
    .regex(pattern)
    .transform((v) => v as T)
const dataJson = z.strictObject({
  commitmentId: hex<Hex>(/^0x[0-9a-fA-F]{64}$/),
  chainId: z.number().int().positive(),
  lock: hex<Address>(/^0x[0-9a-fA-F]{40}$/),
  buyerBusinessId: z.string(),
  supplierBusinessId: z.string(),
  reserveDollars: z.string().regex(/^[0-9]+(\.[0-9]+)?$/),
  agreementExpiresAt: z.iso.datetime(),
  acceptanceTransaction: hex<Hex>(/^0x[0-9a-fA-F]{64}$/).nullable(),
  terms: z.unknown(),
})
const eventJson = z.strictObject({
  id: z.string().regex(/^msg_[0-9a-f]{64}_[a-z]+$/),
  type: z.enum(Object.values(WEBHOOK_EVENTS) as [WebhookEventType, ...WebhookEventType[]]),
  createdAt: z.iso.datetime(),
  data: dataJson,
})
const pendingJson = z.strictObject({
  event: eventJson,
  attempts: z.number().int().min(0),
  nextAttemptAt: z.number().int().min(0),
  lastError: z.string().optional(),
})

/** An event waiting to go out, with when to try next in milliseconds since the epoch. */
type Pending = z.output<typeof pendingJson>

function writeAtomically(path: string, text: string) {
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, text, { mode: 0o600 })
  renameSync(temporary, path)
}

/**
 * The events waiting to reach the supplier's system, one file each in the state directory, so a
 * restart loses none. An event moves to `delivered` once the system answers with a 2xx status, and
 * to `failed` once the adapter gives up on it.
 */
export class Outbox {
  readonly #pending: string
  readonly #delivered: string
  readonly #failed: string

  constructor(stateDir: string) {
    const root = join(stateDir, 'outbox')
    this.#pending = join(root, 'pending')
    this.#delivered = join(root, 'delivered')
    this.#failed = join(root, 'failed')
    for (const dir of [this.#pending, this.#delivered, this.#failed]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
    }
  }

  #file = (dir: string, id: string) => join(dir, `${id}.json`)

  /** Adds an event once. An event with the same id, pending, delivered or given up, is left alone. */
  add(event: WebhookEvent, nowMs: number): boolean {
    if (
      [this.#pending, this.#delivered, this.#failed].some((d) =>
        existsSync(this.#file(d, event.id)),
      )
    )
      return false
    const pending: Pending = { event, attempts: 0, nextAttemptAt: nowMs }
    writeAtomically(this.#file(this.#pending, event.id), `${JSON.stringify(pending, null, 2)}\n`)
    return true
  }

  /** Every pending event, oldest first. A file that doesn't parse is skipped and named in the log. */
  pending(log: (line: string) => void): Pending[] {
    const found: Pending[] = []
    for (const name of readdirSync(this.#pending).filter((n) => n.endsWith('.json'))) {
      const path = join(this.#pending, name)
      try {
        const parsed = pendingJson.safeParse(JSON.parse(readFileSync(path, 'utf8')))
        if (parsed.success) found.push(parsed.data)
        else log(`webhook: ${path} doesn't hold a pending event, so it's skipped`)
      } catch {
        log(`webhook: ${path} isn't JSON, so it's skipped`)
      }
    }
    return found.sort(
      (a, b) =>
        a.event.createdAt.localeCompare(b.event.createdAt) || a.event.id.localeCompare(b.event.id),
    )
  }

  delivered(id: string, nowMs: number) {
    this.#move(id, this.#delivered, { deliveredAt: new Date(nowMs).toISOString() })
  }

  failed(id: string, nowMs: number, lastError: string) {
    this.#move(id, this.#failed, { failedAt: new Date(nowMs).toISOString(), lastError })
  }

  retryLater(p: Pending, nowMs: number, lastError: string) {
    const attempts = p.attempts + 1
    const wait = RETRY_AFTER_MS[Math.min(attempts - 1, RETRY_AFTER_MS.length - 1)] as number
    const next: Pending = { ...p, attempts, nextAttemptAt: nowMs + wait, lastError }
    writeAtomically(this.#file(this.#pending, p.event.id), `${JSON.stringify(next, null, 2)}\n`)
  }

  /**
   * Records where an event ended up, then drops it from pending. A stop between the two leaves it
   * in both, and the next run delivers it again, which a receiver handling each id once allows.
   */
  #move(id: string, dir: string, extra: Record<string, string>) {
    const from = this.#file(this.#pending, id)
    const record = { ...JSON.parse(readFileSync(from, 'utf8')), ...extra }
    writeAtomically(this.#file(dir, id), `${JSON.stringify(record, null, 2)}\n`)
    unlinkSync(from)
  }
}

export interface WebhookTarget {
  url: string
  secret: string
}

export interface SenderDeps {
  target: WebhookTarget
  outbox: Outbox
  post: (url: string, init: { headers: Record<string, string>; body: string }) => Promise<number>
  nowMs: () => number
  log: (line: string) => void
}

/** Posts with `fetch`, giving up after ten seconds, and answers with the response's status. */
export const fetchPost: SenderDeps['post'] = async (url, init) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: init.headers,
    body: init.body,
    signal: AbortSignal.timeout(10_000),
    redirect: 'error',
  })
  return response.status
}

/**
 * The webhook's sender, which delivers every event that's due each time it runs. Events for one
 * booking go in order, so a failed delivery holds back that booking's later events until it lands
 * or is given up, and holds back no other booking's. Delivery is at least once, so a receiver may
 * see an event again and handles each id once. A receiver acts on the latest status it has seen for
 * a commitment, since an event can be skipped when the adapter stopped between two transitions.
 */
export function webhookSender(deps: SenderDeps): () => Promise<void> {
  return async () => {
    const blocked = new Set<string>()
    for (const p of deps.outbox.pending(deps.log)) {
      const commitment = p.event.data.commitmentId.toLowerCase()
      if (blocked.has(commitment)) continue
      const now = deps.nowMs()
      if (p.nextAttemptAt > now) {
        blocked.add(commitment)
        continue
      }
      const body = JSON.stringify(p.event)
      const timestamp = Math.floor(now / 1000)
      let problem: string
      try {
        const status = await deps.post(deps.target.url, {
          headers: {
            'content-type': 'application/json',
            'webhook-id': p.event.id,
            'webhook-timestamp': String(timestamp),
            'webhook-signature': signWebhook(deps.target.secret, p.event.id, timestamp, body),
          },
          body,
        })
        if (status >= 200 && status < 300) {
          deps.outbox.delivered(p.event.id, deps.nowMs())
          deps.log(`webhook: delivered ${p.event.type} for ${commitment}`)
          continue
        }
        problem = `the webhook answered ${status}`
      } catch (e) {
        problem = e instanceof Error ? e.message : String(e)
      }
      blocked.add(commitment)
      if (deps.nowMs() - Date.parse(p.event.createdAt) >= GIVE_UP_AFTER_MS) {
        deps.outbox.failed(p.event.id, deps.nowMs(), problem)
        deps.log(
          `webhook: gave up on ${p.event.type} for ${commitment} after three days (${problem})`,
        )
      } else {
        deps.outbox.retryLater(p, deps.nowMs(), problem)
        deps.log(
          `webhook: ${p.event.type} for ${commitment} failed (${problem}), trying again later`,
        )
      }
    }
  }
}
