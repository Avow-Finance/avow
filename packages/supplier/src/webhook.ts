import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import {
  type CommitmentEvent,
  commitmentEvent,
  enforceableTerms,
  parseCommitmentEvent,
  toWire,
} from '@avow-finance/spec'
import type { Address, Hex } from 'viem'
import { z } from 'zod'
import { writeAtomically } from './files.js'
import { signWebhook } from './signature.js'
import { type Booking, type BookingStatus, isOpen } from './store.js'

/**
 * What the webhook tells the supplier's own system, one event for each status a booking reaches
 * that the system acts on, each a commitment event from `@avow-finance/spec` stated by the
 * supplier. `booking.agreed` once the supplier signed the agent's agreement, so the capacity is
 * spoken for while the agent funds its reserve. `reserve.held` once Avow authorized the funded
 * reserve and the verifier passed it, so the system holds the capacity. `reserve.accepted` once the
 * lock took the supplier's acceptance, which is when the system grants the capacity.
 * `booking.lapsed` when the acceptance deadline passed before the lock took the acceptance, so the
 * capacity is free. A reserve that did reach the lock goes back to the business then.
 */
export const WEBHOOK_EVENTS = {
  agreed: 'booking.agreed',
  held: 'reserve.held',
  accepted: 'reserve.accepted',
  lapsed: 'booking.lapsed',
} as const satisfies Partial<Record<BookingStatus, CommitmentEvent['code']>>

export type WebhookEventCode = (typeof WEBHOOK_EVENTS)[keyof typeof WEBHOOK_EVENTS]

/** An event the adapter posts: a commitment event of one of its four codes, by the supplier. */
export type WebhookEvent = Extract<CommitmentEvent<WebhookEventCode>, { source: 'supplier' }>

/** One event on its way to the supplier's system, with the id every delivery of it carries. */
export interface WebhookDelivery {
  /** The same for every delivery of one booking's status, so a receiver handles each id once. */
  id: string
  event: WebhookEvent
}

const CODES = Object.values(WEBHOOK_EVENTS) as readonly string[]
/** An event read back from JSON, held to the four codes the adapter posts. */
const webhookEventJson: z.ZodType<WebhookEvent, unknown> = z
  .unknown()
  .transform((v, ctx): WebhookEvent => {
    const read = parseCommitmentEvent(v)
    if (read.ok && read.value.source === 'supplier' && CODES.includes(read.value.code)) {
      return read.value as WebhookEvent
    }
    ctx.addIssue({ code: 'custom', message: read.ok ? 'not an adapter event' : read.reason })
    return z.NEVER
  })
const EVENT_ID = /^msg_([0-9a-f]{64})_[a-z]+$/

/**
 * The event a booking's status calls for, or null for a status that calls for none. Its id comes
 * from the commitment and the status alone, so recording the same transition twice, after a
 * restart for one, gives one delivery. The event names the commitment, the terms by their hash,
 * the reserve in micros of the terms' currency and when the agreement lapses, and no business, so
 * the supplier's system reads the terms and who booked from `GET /commitments/<id>`.
 */
export function bookingEvent(booking: Booking, now: Date): WebhookDelivery | null {
  const code = (WEBHOOK_EVENTS as Partial<Record<BookingStatus, WebhookEventCode>>)[booking.status]
  if (!code) return null
  const stated = {
    commitment: {
      chainId: booking.chainId,
      lock: booking.lock.toLowerCase() as Address,
      commitmentId: booking.commitmentId.toLowerCase() as Hex,
    },
    termsHash: booking.agreement.termsHash.toLowerCase() as Hex,
    reserve: enforceableTerms(booking.terms).reserve,
    agreementExpiry: booking.agreement.expiry,
    source: 'supplier',
    at: BigInt(Math.floor(now.getTime() / 1000)),
  } as const
  const event =
    code === 'reserve.accepted'
      ? commitmentEvent({
          ...stated,
          code,
          acceptedIn:
            booking.status === 'accepted' && booking.sent
              ? (booking.sent.hash.toLowerCase() as Hex)
              : null,
        })
      : commitmentEvent({ ...stated, code })
  return {
    id: `msg_${booking.commitmentId.slice(2).toLowerCase()}_${booking.status}`,
    event: event as WebhookEvent,
  }
}

/** How long after the last failed delivery each retry waits, then the last wait over again. */
const RETRY_AFTER_MS = [5_000, 30_000, 120_000, 600_000, 1_800_000, 3_600_000, 10_800_000]
/** How long after its first attempt the adapter keeps trying an event before it gives it up. */
const GIVE_UP_AFTER_MS = 3 * 24 * 3_600_000

const pendingJson = z.strictObject({
  id: z.string().regex(EVENT_ID),
  event: webhookEventJson,
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
  readonly #replaced = new Set<Hex>()
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
    this.#setAsideOlderFormat(root)
  }

  /**
   * Moves each pending or given-up file an older adapter wrote, which held an event of its own
   * format, to `outbox/older` and remembers its commitment, so `reconcile` adds that booking's
   * current event again as a commitment event and nothing waits on a file it can't read.
   */
  #setAsideOlderFormat(root: string) {
    const older = join(root, 'older')
    for (const dir of [this.#pending, this.#failed]) {
      for (const name of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
        let record: unknown
        try {
          record = JSON.parse(readFileSync(join(dir, name), 'utf8'))
        } catch {
          continue
        }
        const commitment = olderFormatCommitment(record)
        if (!commitment) continue
        mkdirSync(older, { recursive: true, mode: 0o700 })
        renameSync(join(dir, name), join(older, name))
        this.#replaced.add(commitment)
      }
    }
  }

  /** The commitments whose events an older adapter left in its own format, set aside at start. */
  get replaced(): ReadonlySet<Hex> {
    return this.#replaced
  }

  /** When the webhook was first turned on, in seconds since the epoch. */
  get since(): bigint {
    return this.#since
  }

  #file = (dir: string, id: string) => join(dir, `${id}.json`)
  #write = (dir: string, record: Pending & Record<string, unknown>) =>
    writeAtomically(
      this.#file(dir, record.id),
      `${JSON.stringify({ ...record, event: toWire(record.event) }, null, 2)}\n`,
    )

  /**
   * Adds an event once. An event with the same id, pending, delivered or given up, is left alone,
   * and so is one an older adapter delivered in its own format.
   */
  add(delivery: WebhookDelivery, nowMs: number): boolean {
    const dirs = [this.#pending, this.#delivered, this.#failed]
    if (dirs.some((d) => existsSync(this.#file(d, delivery.id)))) return false
    this.#write(this.#pending, { ...delivery, attempts: 0, nextAttemptAt: nowMs })
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
    events.sort((a, b) =>
      a.event.at !== b.event.at ? (a.event.at < b.event.at ? -1 : 1) : a.id.localeCompare(b.id),
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
    this.#write(this.#pending, next)
  }

  /** Puts every event it gave up on back to be sent now, as new, and says how many. */
  redeliverFailed(nowMs: number): number {
    const names = readdirSync(this.#failed).filter((n) => n.endsWith('.json'))
    for (const name of names) {
      const path = join(this.#failed, name)
      const { id, event } = z
        .object({ id: z.string().regex(EVENT_ID), event: webhookEventJson })
        .parse(JSON.parse(readFileSync(path, 'utf8')))
      this.#write(this.#pending, { id, event, attempts: 0, nextAttemptAt: nowMs })
      unlinkSync(path)
    }
    return names.length
  }

  /**
   * Records where an event ended up, then drops it from pending. A stop between the two leaves it
   * in both, and the next run delivers it again, which a receiver handling each id once allows.
   */
  #move(p: Pending, dir: string, extra: Record<string, string>) {
    this.#write(dir, { ...p, ...extra })
    unlinkSync(this.#file(this.#pending, p.id))
  }
}

/**
 * The commitment of a pending file an older adapter wrote, whose event was the adapter's own
 * format with a `type` and a `data` section, or null for any other record.
 */
function olderFormatCommitment(record: unknown): Hex | null {
  const read = z
    .object({
      event: z.object({
        id: z.string().regex(EVENT_ID),
        type: z.string(),
        data: z.object({ commitmentId: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }),
      }),
    })
    .safeParse(record)
  return read.success ? (read.data.event.data.commitmentId.toLowerCase() as Hex) : null
}

/**
 * Adds the event for each booking's current status, so a stop between saving a booking and adding
 * its event loses nothing. It covers every open booking, a finished one whose events an older
 * adapter left in its own format, and any other finished one only when its agreement came after the
 * webhook was first turned on, so turning the webhook on for an adapter with a history doesn't
 * replay bookings that ended long ago.
 */
export function reconcile(outbox: Outbox, bookings: Iterable<Booking>, now: Date): number {
  let added = 0
  for (const b of bookings) {
    const replaced = outbox.replaced.has(b.commitmentId.toLowerCase() as Hex)
    if (!isOpen(b.status) && !replaced && b.agreement.expiry <= outbox.since) continue
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
      const commitment = p.event.commitment.commitmentId
      if (blocked.has(commitment)) continue
      blocked.add(commitment)
      try {
        const now = deps.nowMs()
        if (p.nextAttemptAt > now) continue
        const body = JSON.stringify(toWire(p.event))
        const timestamp = String(Math.floor(now / 1000))
        let status: number
        try {
          status = await deps.post(deps.target.url, {
            headers: {
              'content-type': 'application/json',
              'webhook-id': p.id,
              'webhook-timestamp': timestamp,
              'webhook-signature': signWebhook(deps.target.secret, p.id, timestamp, body),
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
          deps.log(`webhook: delivered ${p.event.code} for ${commitment}`)
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
  const commitment = p.event.commitment.commitmentId
  if (p.firstAttemptAt !== undefined && now - p.firstAttemptAt >= GIVE_UP_AFTER_MS) {
    deps.outbox.failed(p, now, problem)
    deps.log(
      `webhook: gave up on ${p.event.code} for ${commitment} after three days (${problem}). Run redeliver to send it again`,
    )
  } else {
    deps.outbox.retryLater(p, now, problem)
    deps.log(`webhook: ${p.event.code} for ${commitment} failed (${problem}), trying again later`)
  }
}
