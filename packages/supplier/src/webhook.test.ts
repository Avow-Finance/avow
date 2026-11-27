import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  COMMITMENT_EVENT_VERSION,
  commitmentEventProblem,
  enforceableTerms,
  parseCommitmentEvent,
  toWire,
} from '@avow-finance/spec'
import type { Hex } from 'viem'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeWebhookSecret, verifyWebhook } from './signature.js'
import { type Booking, type BookingStatus, SupplierStore } from './store.js'
import { agreedBooking, COMMITMENT, tempStore } from './test/fixtures.js'
import {
  bookingEvent,
  Outbox,
  reconcile,
  type SenderDeps,
  type WebhookDelivery,
  webhookSender,
} from './webhook.js'

let store: SupplierStore
let remove: () => void
beforeEach(() => {
  ;({ store, remove } = tempStore())
})
afterEach(() => remove())

const T0 = Date.parse('2027-01-04T09:00:00Z')
const DAYS_3 = 3 * 24 * 3_600_000
const SECRET = makeWebhookSecret()
const TX: Hex = `0x${'ab'.repeat(32)}`
const OTHER: Hex = `0x${'ee'.repeat(32)}`

/** The fixture's booking at a status that sends no acceptance. */
const withStatus = (
  status: 'agreed' | 'held' | 'accepting' | 'lapsed',
  id = COMMITMENT,
): Booking => {
  const { sent: _sent, status: _status, ...record } = agreedBooking()
  return { ...record, commitmentId: id, status }
}
const accepted = (): Booking => ({
  ...withStatus('agreed'),
  status: 'accepted',
  sent: { hash: TX, validBefore: null },
})
const at = (booking: Booking, ms = T0) => bookingEvent(booking, new Date(ms)) as WebhookDelivery
const pendingOf = (outbox: Outbox) => outbox.pending(() => {}).events

describe('booking events', () => {
  it('gives each status the supplier acts on one event, with an id from the commitment and status', () => {
    const agreed = at(withStatus('agreed'))
    expect(agreed.event.code).toBe('booking.agreed')
    expect(agreed.id).toBe(`msg_${COMMITMENT.slice(2)}_agreed`)
    expect(at(withStatus('agreed'), T0 + 60_000).id).toBe(agreed.id)
    expect(at(withStatus('held')).event.code).toBe('reserve.held')
    expect(at(accepted()).event.code).toBe('reserve.accepted')
    expect(at(withStatus('lapsed')).event.code).toBe('booking.lapsed')
    expect(bookingEvent(withStatus('accepting'), new Date(T0))).toBeNull()
  })

  it("writes each as a well-formed commitment event of the spec's, stated by the supplier", () => {
    for (const b of [withStatus('agreed'), withStatus('held'), accepted(), withStatus('lapsed')]) {
      const { event } = at(b)
      expect(event.schemaVersion).toBe(COMMITMENT_EVENT_VERSION)
      expect(event.source).toBe('supplier')
      expect(commitmentEventProblem(event), event.code).toBeNull()
      expect(parseCommitmentEvent(JSON.parse(JSON.stringify(toWire(event))))).toEqual({
        ok: true,
        value: event,
      })
    }
  })

  it('names the commitment, the terms by their hash, the reserve and the agreement, and no business', () => {
    const b = withStatus('agreed')
    const { event } = at(b)
    expect(event.commitment).toEqual({
      chainId: b.chainId,
      lock: b.lock.toLowerCase(),
      commitmentId: COMMITMENT.toLowerCase(),
    })
    expect(event.termsHash).toBe(b.agreement.termsHash.toLowerCase())
    expect(event.reserve).toBe(enforceableTerms(b.terms).reserve)
    expect(event.agreementExpiry).toBe(b.agreement.expiry)
    expect(event.at).toBe(BigInt(T0 / 1000))
    const wire = JSON.stringify(toWire(event))
    expect(wire).not.toContain(b.agreement.buyerBusinessId)
    expect(wire).not.toContain(b.agreement.supplierBusinessId)
    expect(wire).not.toMatch(/business|terms"|"data"|"type"/i)
  })

  it('names the acceptance transaction once the adapter sent one, and null when it found it on the lock', () => {
    const sent = at(accepted()).event
    if (sent.code !== 'reserve.accepted') throw new Error('an acceptance')
    expect(sent.acceptedIn).toBe(TX)
    const { sent: _sent, ...found } = accepted()
    const seen = at(found as Booking).event
    if (seen.code !== 'reserve.accepted') throw new Error('an acceptance')
    expect(seen.acceptedIn).toBeNull()
  })

  it('says a lapse ended unaccepted, the same whether or not a reserve had come', () => {
    const { event } = at(withStatus('lapsed'))
    expect(Object.keys(event).filter((k) => /reserved|funded|held|returned/i.test(k))).toEqual([])
  })
})

/** A receiver that answers each post with the next status in line, or throws for `'down'`. */
function receiver(answers: (number | 'down')[]) {
  const posts: { headers: Record<string, string>; body: string }[] = []
  const post: SenderDeps['post'] = async (_url, init) => {
    posts.push(init)
    const answer = answers.shift() ?? 200
    if (answer === 'down') throw new Error('connection refused')
    return answer
  }
  return { posts, post, ids: () => posts.map((p) => p.headers['webhook-id'] as string) }
}

function sender(outbox: Outbox, post: SenderDeps['post'], clock: { now: number }) {
  const lines: string[] = []
  const send = webhookSender({
    target: { url: 'https://bookings.example/avow', secret: SECRET },
    outbox,
    post,
    nowMs: () => clock.now,
    log: (line) => lines.push(line),
  })
  return { send, lines }
}

describe('the webhook outbox', () => {
  it('keeps one copy of an event, pending, delivered or given up', () => {
    const outbox = new Outbox(store.dir, T0)
    const event = at(withStatus('agreed'))
    expect(outbox.add(event, T0)).toBe(true)
    expect(outbox.add(event, T0)).toBe(false)
    expect(pendingOf(outbox)).toHaveLength(1)
  })

  it('remembers when the webhook was first turned on', () => {
    expect(new Outbox(store.dir, T0).since).toBe(BigInt(T0 / 1000))
    expect(new Outbox(store.dir, T0 + 60_000).since).toBe(BigInt(T0 / 1000))
  })

  it('posts each due event signed, so the receiver can check it, then keeps it as delivered', async () => {
    const outbox = new Outbox(store.dir, T0)
    const event = at(withStatus('agreed'))
    outbox.add(event, T0)
    const { posts, post } = receiver([200])
    await sender(outbox, post, { now: T0 }).send()
    expect(posts).toHaveLength(1)
    const [{ headers, body }] = posts as [(typeof posts)[number]]
    expect(parseCommitmentEvent(JSON.parse(body))).toEqual({ ok: true, value: event.event })
    const signed = {
      id: headers['webhook-id'] as string,
      timestamp: headers['webhook-timestamp'] as string,
      signature: headers['webhook-signature'] as string,
    }
    expect(signed.id).toBe(event.id)
    expect(verifyWebhook(SECRET, signed, body, Math.floor(T0 / 1000))).toBe(true)
    expect(pendingOf(outbox)).toHaveLength(0)
    expect(readdirSync(join(store.dir, 'outbox', 'delivered'))).toEqual([`${event.id}.json`])
    expect(outbox.add(event, T0)).toBe(false)
  })

  it("retries a refused delivery later, holding back that booking's later events and no other booking's", async () => {
    const outbox = new Outbox(store.dir, T0)
    outbox.add(at(withStatus('agreed')), T0)
    outbox.add(at(withStatus('held'), T0 + 1000), T0 + 1000)
    outbox.add(at(withStatus('agreed', OTHER), T0 + 2000), T0 + 2000)
    const clock = { now: T0 + 3000 }
    const r = receiver([500, 200])
    const { send, lines } = sender(outbox, r.post, clock)
    await send()
    expect(r.ids()).toEqual([`msg_${COMMITMENT.slice(2)}_agreed`, `msg_${OTHER.slice(2)}_agreed`])
    expect(lines.some((l) => l.includes('the webhook answered 500'))).toBe(true)
    await send()
    expect(r.posts).toHaveLength(2)
    clock.now += 5_000
    await send()
    expect(r.posts.slice(2).map((p) => JSON.parse(p.body).code)).toEqual([
      'booking.agreed',
      'reserve.held',
    ])
    expect(pendingOf(outbox)).toHaveLength(0)
  })

  it('ends the pass when a post never reaches the receiver, so one timeout is all a pass waits', async () => {
    const outbox = new Outbox(store.dir, T0)
    outbox.add(at(withStatus('agreed')), T0)
    outbox.add(at(withStatus('agreed', OTHER), T0 + 1000), T0 + 1000)
    const r = receiver(['down'])
    await sender(outbox, r.post, { now: T0 + 2000 }).send()
    expect(r.posts).toHaveLength(1)
  })

  it('waits longer after each failure, and gives an event up three days after its first attempt', async () => {
    const outbox = new Outbox(store.dir, T0)
    outbox.add(at(withStatus('agreed')), T0)
    const clock = { now: T0 }
    const r = receiver(Array(100).fill(503))
    const { send, lines } = sender(outbox, r.post, clock)
    await send()
    const waits: number[] = []
    for (let i = 0; i < 3; i++) {
      const next = (pendingOf(outbox)[0]?.nextAttemptAt ?? 0) - clock.now
      waits.push(next)
      clock.now += next
      await send()
    }
    expect(waits).toEqual([5_000, 30_000, 120_000])
    clock.now = T0 + DAYS_3
    await send()
    expect(pendingOf(outbox)).toHaveLength(0)
    expect(readdirSync(join(store.dir, 'outbox', 'failed'))).toHaveLength(1)
    expect(lines.at(-1)).toContain('gave up on booking.agreed')
  })

  it('counts three days from each event’s own first attempt, so an event held back gets its own three days', async () => {
    const outbox = new Outbox(store.dir, T0)
    outbox.add(at(withStatus('agreed')), T0)
    outbox.add(at(withStatus('held'), T0 + 1000), T0 + 1000)
    const clock = { now: T0 }
    const r = receiver(Array(100).fill(503))
    const { send } = sender(outbox, r.post, clock)
    await send()
    clock.now = T0 + DAYS_3
    await send()
    await send()
    const left = pendingOf(outbox)
    expect(left.map((p) => p.event.code)).toEqual(['reserve.held'])
    expect(left[0]?.attempts).toBe(1)
  })

  it('sends given-up events again on redeliver', async () => {
    const outbox = new Outbox(store.dir, T0)
    outbox.add(at(withStatus('agreed')), T0)
    const clock = { now: T0 }
    const r = receiver([503, 503])
    const { send } = sender(outbox, r.post, clock)
    await send()
    clock.now = T0 + DAYS_3
    await send()
    expect(pendingOf(outbox)).toHaveLength(0)
    expect(outbox.redeliverFailed(clock.now)).toBe(1)
    await send()
    expect(readdirSync(join(store.dir, 'outbox', 'delivered'))).toHaveLength(1)
    expect(readdirSync(join(store.dir, 'outbox', 'failed'))).toHaveLength(0)
  })

  it('holds back the booking of a pending file it can’t read, and says so once until the file changes', async () => {
    const outbox = new Outbox(store.dir, T0)
    const head = at(withStatus('agreed'))
    outbox.add(head, T0)
    outbox.add(at(withStatus('held'), T0 + 1000), T0 + 1000)
    const damaged = join(store.dir, 'outbox', 'pending', `${head.id}.json`)
    writeFileSync(damaged, '{ not json')
    const r = receiver([])
    const { send, lines } = sender(outbox, r.post, { now: T0 + 2000 })
    const said = () => lines.filter((l) => l.includes("doesn't hold a pending event")).length
    await send()
    await send()
    expect(r.posts).toHaveLength(0)
    expect(said()).toBe(1)
    writeFileSync(damaged, '{ still not json')
    await send()
    expect(said()).toBe(2)
  })

  it('learns of every booking the store saves', () => {
    const outbox = new Outbox(store.dir, T0)
    const seen: BookingStatus[] = []
    const hooked = new SupplierStore(join(store.dir, 'hooked'), (b) => {
      seen.push(b.status)
      const e = bookingEvent(b, new Date(T0))
      if (e) outbox.add(e, T0)
    })
    hooked.put(withStatus('agreed'))
    hooked.put(withStatus('held'))
    hooked.put(withStatus('held'))
    expect(seen).toEqual(['agreed', 'held', 'held'])
    expect(pendingOf(outbox).map((p) => p.event.code)).toEqual(['booking.agreed', 'reserve.held'])
  })

  it('counts a booking as no longer open before the hook runs, even when the hook throws', () => {
    const hooked = new SupplierStore(join(store.dir, 'throwing'), () => {
      throw new Error('disk full')
    })
    const lock = withStatus('agreed').lock
    expect(() => hooked.put(withStatus('agreed'))).toThrow('disk full')
    expect(hooked.openBookings(lock).total).toBe(1)
    expect(() => hooked.put(accepted())).toThrow('disk full')
    expect(hooked.openBookings(lock).total).toBe(0)
  })
})

describe('reconciling the outbox with the bookings', () => {
  it('adds every open booking, and a finished one only when it was agreed after the webhook was turned on', () => {
    const expiry = withStatus('agreed').agreement.expiry
    const finished = [accepted(), withStatus('lapsed', OTHER)]
    const open = withStatus('held', `0x${'cc'.repeat(32)}`)

    const later = new Outbox(join(store.dir, 'later'), Number(expiry + 60n) * 1000)
    expect(reconcile(later, [open, ...finished], new Date(T0))).toBe(1)
    expect(pendingOf(later).map((p) => p.event.code)).toEqual(['reserve.held'])

    const earlier = new Outbox(join(store.dir, 'earlier'), Number(expiry - 60n) * 1000)
    expect(reconcile(earlier, finished, new Date(T0))).toBe(2)
    expect(reconcile(earlier, finished, new Date(T0))).toBe(0)
  })
})

describe('an outbox an older adapter left', () => {
  /** A pending file as an adapter before commitment events wrote it, in its own format. */
  const older = (id: Hex, status: string) => ({
    event: {
      id: `msg_${id.slice(2)}_${status}`,
      type: 'booking.agreed',
      createdAt: new Date(T0).toISOString(),
      data: { commitmentId: id, chainId: 42431, lock: withStatus('agreed').lock, terms: {} },
    },
    attempts: 2,
    nextAttemptAt: T0,
  })

  it('sets its pending and given-up events aside, and adds their bookings again as commitment events', async () => {
    const root = join(store.dir, 'outbox')
    for (const dir of ['pending', 'failed']) mkdirSync(join(root, dir), { recursive: true })
    const pendingFile = join(root, 'pending', `msg_${COMMITMENT.slice(2)}_agreed.json`)
    writeFileSync(pendingFile, JSON.stringify(older(COMMITMENT, 'agreed')))
    // A finished booking, agreed before the webhook was turned on, still gets its event again.
    writeFileSync(
      join(root, 'failed', `msg_${OTHER.slice(2)}_lapsed.json`),
      JSON.stringify(older(OTHER, 'lapsed')),
    )
    const outbox = new Outbox(store.dir, Number(withStatus('agreed').agreement.expiry + 60n) * 1000)
    expect([...outbox.replaced].sort()).toEqual(
      [COMMITMENT, OTHER].map((x) => x.toLowerCase()).sort(),
    )
    expect(existsSync(pendingFile)).toBe(false)
    expect(readdirSync(join(root, 'older')).sort()).toHaveLength(2)
    expect(pendingOf(outbox)).toEqual([])

    const added = reconcile(
      outbox,
      [withStatus('agreed'), withStatus('lapsed', OTHER)],
      new Date(T0),
    )
    expect(added).toBe(2)
    const r = receiver([200, 200])
    await sender(outbox, r.post, { now: T0 }).send()
    expect(r.posts.map((p) => JSON.parse(p.body).code).sort()).toEqual([
      'booking.agreed',
      'booking.lapsed',
    ])
    expect(outbox.redeliverFailed(T0)).toBe(0)
  })

  it("leaves a file it can't read where it is, so its booking waits until it is mended", () => {
    const root = join(store.dir, 'outbox', 'pending')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, `msg_${COMMITMENT.slice(2)}_agreed.json`), '{ not json')
    const outbox = new Outbox(store.dir, T0)
    expect(outbox.replaced.size).toBe(0)
    expect(outbox.pending(() => {}).unreadable).toEqual(new Set([COMMITMENT.toLowerCase()]))
  })
})
