import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { enforceableTerms, toWire } from '@avow-finance/spec'
import type { Address, Hex } from 'viem'
import { z } from 'zod'
import { writeAtomically } from './files.js'
import { dollars, iso, TERMS_DECIMALS } from './format.js'
import { signWebhook } from './signature.js'
import { type Booking, type BookingStatus, isOpen } from './store.js'

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

const hex = <T extends Hex>(pattern: RegExp) =>
  z
    .string()
    .regex(pattern)
    .transform((v) => v as T)
const BYTES32 = /^0x[0-9a-fA-F]{64}$/

/** What every event says about its booking. Money is in dollars and times are ISO 8601 in UTC. */
const dataJson = z.strictObject({
  commitmentId: hex<Hex>(BYTES32),
  chainId: z.number().int().positive(),
  lock: hex<Address>(/^0x[0-9a-fA-F]{40}$/),
  buyerBusinessId: z.string(),
  supplierBusinessId: z.string(),
  /** The most the supplier can charge on this booking, the reserve the business funds. */
  reserveDollars: z.string().regex(/^[0-9]+(\.[0-9]+)?$/),
  /**
   * When the signed agreement offer stops being valid. A booking lapses at its terms' acceptance
   * deadline, `terms.remedies.acceptBy`, a separate time.
   */
  agreementExpiresAt: z.iso.datetime(),
  /** The acceptance's transaction on the lock, once `reserve.accepted` has it. */
  acceptanceTransaction: hex<Hex>(BYTES32).nullable(),
  /** The terms both sides signed, as the spec writes them. */
  terms: z.unknown(),
})
const EVENT_ID = /^msg_([0-9a-f]{64})_[a-z]+$/
const eventJson = z.strictObject({
  /** The same for every delivery of one event, so a receiver handles each id once. */
  id: z.string().regex(EVENT_ID),
  type: z.enum(Object.values(WEBHOOK_EVENTS) as [WebhookEventType, ...WebhookEventType[]]),
  createdAt: z.iso.datetime(),
  data: dataJson,
})

export type BookingEventData = z.output<typeof dataJson>
export type WebhookEvent = z.output<typeof eventJson>

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
      reserveDollars: dollars(enforceableTerms(booking.terms).reserve, TERMS_DECIMALS),
      agreementExpiresAt: iso(booking.agreement.expiry),
      acceptanceTransaction: booking.status === 'accepted' ? (booking.sent?.hash ?? null) : null,
      terms: toWire(booking.terms),
    },
  }
}

/** How long after the last failed delivery each retry waits, then the last wait over again. */
const RETRY_AFTER_MS = [5_000, 30_000, 120_000, 600_000, 1_800_000, 3_600_000, 10_800_000]
/** How long after its first attempt the adapter keeps trying an event before it gives it up. */
const GIVE_UP_AFTER_MS = 3 * 24 * 3_600_000

const pendingJson = z.strictObject({
  event: eventJson,
  attempts: z.number().int().min(0),
  /** Milliseconds since the epoch, for this and the next two fields. */
  nextAttemptAt: z.number().int().min(0),
  firstAttemptAt: z.number().int().min(0).optional(),
  lastError: z.string().optional(),
})
type Pending = z.output<typeof pendingJson>
const sinceJson = z.strictObject({ since: z.number().int().min(0) })

/**
 * The events waiting to reach the supplier's system, one file each in the state directory, so a
 * restart loses none. An event moves to `delivered` once the system answers with a 2xx status, and
 * to `failed` once the adapter gives up on it. The outbox remembers when it was first made, which
 * is when the supplier first turned the webhook on.
 */
export class Outbox {
  readonly #pending: string
  readonly #delivered: string
  readonly #failed: string
  readonly #since: bigint
  /** The text of each pending file it couldn't read, as it was when it said so. */
  readonly #unreadable = new Map<string, string>()

  constructor(stateDir: string, nowMs: number) {
    const root = join(stateDir, 'outbox')
    this.#pending = join(root, 'pending')
    this.#delivered = join(root, 'delivered')
    this.#failed = join(root, 'failed')
    for (const dir of [this.#pending, this.#delivered, this.#failed]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
    }
    const sinceFile = join(root, 'since.json')
    if (!existsSync(sinceFile)) {
      writeAtomically(sinceFile, `${JSON.stringify({ since: Math.floor(nowMs / 1000) })}\n`)
    }
    const since = sinceJson.safeParse(JSON.parse(readFileSync(sinceFile, 'utf8')))
    if (!since.success) throw new Error(`${sinceFile} doesn't say when the webhook was turned on`)
    this.#since = BigInt(since.data.since)
  }

  /** When the webhook was first turned on, in seconds since the epoch. */
  get since(): bigint {
    return this.#since
  }

  #file = (dir: string, id: string) => join(dir, `${id}.json`)
  #write = (dir: string, record: unknown, id: string) =>
    writeAtomically(this.#file(dir, id), `${JSON.stringify(record, null, 2)}\n`)

  /** Adds an event once. An event with the same id, pending, delivered or given up, is left alone. */
  add(event: WebhookEvent, nowMs: number): boolean {
    const dirs = [this.#pending, this.#delivered, this.#failed]
    if (dirs.some((d) => existsSync(this.#file(d, event.id)))) return false
    this.#write(
      this.#pending,
      { event, attempts: 0, nextAttemptAt: nowMs } satisfies Pending,
      event.id,
    )
    return true
  }

  /**
   * Every pending event, oldest first, and the commitments of pending files it couldn't read, so
   * the sender holds those bookings back rather than send a later event first. It logs a file it
   * can't read once, and again only once the file changes.
   */
  pending(log: (line: string) => void): { events: Pending[]; unreadable: Set<string> } {
    const events: Pending[] = []
    const unreadable = new Set<string>()
    for (const name of readdirSync(this.#pending).filter((n) => n.endsWith('.json'))) {
      const path = join(this.#pending, name)
      const text = readFileSync(path, 'utf8')
      let parsed: ReturnType<typeof pendingJson.safeParse> | null = null
      try {
        parsed = pendingJson.safeParse(JSON.parse(text))
      } catch {
        parsed = null
      }
      if (parsed?.success) {
        events.push(parsed.data)
        this.#unreadable.delete(path)
        continue
      }
      const commitment = EVENT_ID.exec(name.slice(0, -'.json'.length))?.[1]
      if (commitment) unreadable.add(`0x${commitment}`)
      if (this.#unreadable.get(path) !== text) {
        this.#unreadable.set(path, text)
        log(`webhook: ${path} doesn't hold a pending event, so its booking waits until it's mended`)
      }
    }
    events.sort(
      (a, b) =>
        a.event.createdAt.localeCompare(b.event.createdAt) || a.event.id.localeCompare(b.event.id),
    )
    return { events, unreadable }
  }

  delivered(p: Pending, nowMs: number) {
    this.#move(p, this.#delivered, { deliveredAt: new Date(nowMs).toISOString() })
  }

  failed(p: Pending, nowMs: number, lastError: string) {
    this.#move(p, this.#failed, { failedAt: new Date(nowMs).toISOString(), lastError })
  }

  retryLater(p: Pending, nowMs: number, lastError: string) {
    const attempts = p.attempts + 1
    const wait = RETRY_AFTER_MS[Math.min(attempts - 1, RETRY_AFTER_MS.length - 1)] as number
    const next: Pending = {
      ...p,
      attempts,
      nextAttemptAt: nowMs + wait,
      firstAttemptAt: p.firstAttemptAt ?? nowMs,
      lastError,
    }
    this.#write(this.#pending, next, p.event.id)
  }

  /** Puts every event it gave up on back to be sent now, as new, and says how many. */
  redeliverFailed(nowMs: number): number {
    const names = readdirSync(this.#failed).filter((n) => n.endsWith('.json'))
    for (const name of names) {
      const path = join(this.#failed, name)
      const { event } = z.object({ event: eventJson }).parse(JSON.parse(readFileSync(path, 'utf8')))
      this.#write(
        this.#pending,
        { event, attempts: 0, nextAttemptAt: nowMs } satisfies Pending,
        event.id,
      )
      unlinkSync(path)
    }
    return names.length
  }

  /**
   * Records where an event ended up, then drops it from pending. A stop between the two leaves it
   * in both, and the next run delivers it again, which a receiver handling each id once allows.
   */
  #move(p: Pending, dir: string, extra: Record<string, string>) {
    this.#write(dir, { ...p, ...extra }, p.event.id)
    unlinkSync(this.#file(this.#pending, p.event.id))
  }
}

/**
 * Adds the event for each booking's current status, so a stop between saving a booking and adding
 * its event loses nothing. It covers every open booking, and a finished one only when its agreement
 * came after the webhook was first turned on, so turning the webhook on for an adapter with a
 * history doesn't replay bookings that ended long ago.
 */
export function reconcile(outbox: Outbox, bookings: Iterable<Booking>, now: Date): number {
  let added = 0
  for (const b of bookings) {
    if (!isOpen(b.status) && b.agreement.expiry <= outbox.since) continue
    const event = bookingEvent(b, now)
    if (event && outbox.add(event, now.getTime())) added++
  }
  return added
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

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * The webhook's sender, which delivers every event that's due each time it runs. Events for one
 * booking go in order, so a failed delivery holds back that booking's later events until it lands
 * or is given up, and holds back no other booking's. A post that never reaches the receiver ends
 * the pass, since the rest would wait out the same timeout. Delivery is at least once, so a
 * receiver may see an event again and handles each id once. A receiver acts on the latest status
 * it has seen for a commitment, since an event can be skipped when the adapter stopped between two
 * transitions. An error reading or writing the outbox is logged and holds back only its booking.
 */
export function webhookSender(deps: SenderDeps): () => Promise<void> {
  return async () => {
    const { events, unreadable } = deps.outbox.pending(deps.log)
    const blocked = new Set(unreadable)
    for (const p of events) {
      const commitment = p.event.data.commitmentId.toLowerCase()
      if (blocked.has(commitment)) continue
      blocked.add(commitment)
      try {
        const now = deps.nowMs()
        if (p.nextAttemptAt > now) continue
        const body = JSON.stringify(p.event)
        const timestamp = String(Math.floor(now / 1000))
        let status: number
        try {
          status = await deps.post(deps.target.url, {
            headers: {
              'content-type': 'application/json',
              'webhook-id': p.event.id,
              'webhook-timestamp': timestamp,
              'webhook-signature': signWebhook(deps.target.secret, p.event.id, timestamp, body),
            },
            body,
          })
        } catch (e) {
          settleFailure(deps, p, `the post didn't reach the webhook (${message(e)})`)
          return
        }
        if (status >= 200 && status < 300) {
          deps.outbox.delivered(p, deps.nowMs())
          blocked.delete(commitment)
          deps.log(`webhook: delivered ${p.event.type} for ${commitment}`)
        } else {
          settleFailure(deps, p, `the webhook answered ${status}`)
        }
      } catch (e) {
        deps.log(`webhook: the outbox failed for ${commitment} (${message(e)})`)
      }
    }
  }
}

/** Gives an event up once three days have passed since its first attempt, or tries it later. */
function settleFailure(deps: SenderDeps, p: Pending, problem: string) {
  const now = deps.nowMs()
  const commitment = p.event.data.commitmentId.toLowerCase()
  if (p.firstAttemptAt !== undefined && now - p.firstAttemptAt >= GIVE_UP_AFTER_MS) {
    deps.outbox.failed(p, now, problem)
    deps.log(
      `webhook: gave up on ${p.event.type} for ${commitment} after three days (${problem}). Run redeliver to send it again`,
    )
  } else {
    deps.outbox.retryLater(p, now, problem)
    deps.log(`webhook: ${p.event.type} for ${commitment} failed (${problem}), trying again later`)
  }
}
