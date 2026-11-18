import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { enforceableTerms } from '@avow-finance/spec'
import type { Hex } from 'viem'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Booking, type BookingStatus, SupplierStore } from './store.js'
import { agreedBooking, COMMITMENT, tempStore } from './test/fixtures.js'
import {
  bookingEvent,
  isWebhookSecret,
  makeWebhookSecret,
  Outbox,
  type SenderDeps,
  signWebhook,
  verifyWebhook,
  type WebhookEvent,
  webhookSender,
} from './webhook.js'

let store: SupplierStore
let remove: () => void
beforeEach(() => {
  ;({ store, remove } = tempStore())
})
afterEach(() => remove())

const T0 = Date.parse('2027-01-04T09:00:00Z')
const SECRET = makeWebhookSecret()
const TX: Hex = `0x${'ab'.repeat(32)}`
const OTHER: Hex = `0x${'ee'.repeat(32)}`

/** The fixture's booking at a status that sends no acceptance. */
const withStatus = (status: 'agreed' | 'held' | 'accepting' | 'lapsed'): Booking => {
  const { sent: _sent, status: _status, ...record } = agreedBooking()
  return { ...record, status }
}
const at = (booking: Booking, ms = T0) => bookingEvent(booking, new Date(ms)) as WebhookEvent
const accepted = (): Booking => ({
  ...agreedBooking(),
  status: 'accepted',
  sent: { hash: TX, validBefore: null },
})

describe('booking events', () => {
  it('gives each status the supplier acts on one event, with an id from the commitment and status', () => {
    const agreed = at(agreedBooking())
    expect(agreed.type).toBe('booking.agreed')
    expect(agreed.id).toBe(`msg_${COMMITMENT.slice(2)}_agreed`)
    expect(at(agreedBooking(), T0 + 60_000).id).toBe(agreed.id)
    expect(at(withStatus('held')).type).toBe('reserve.held')
    expect(at(accepted()).type).toBe('reserve.accepted')
    expect(at(withStatus('lapsed')).type).toBe('booking.lapsed')
    expect(bookingEvent(withStatus('accepting'), new Date(T0))).toBeNull()
  })

  it('says who booked, the reserve in dollars and when the agreement lapses, and the acceptance once there is one', () => {
    const b = agreedBooking()
    const { data } = at(b)
    expect(data).toMatchObject({
      commitmentId: COMMITMENT,
      lock: b.lock,
      chainId: b.chainId,
      buyerBusinessId: b.agreement.buyerBusinessId,
      supplierBusinessId: b.agreement.supplierBusinessId,
      acceptanceTransaction: null,
    })
    expect(data.reserveDollars).toMatch(/^[0-9]+(\.[0-9]+)?$/)
    expect(BigInt(Number(data.reserveDollars) * 1_000_000)).toBe(enforceableTerms(b.terms).reserve)
    expect(data.agreementExpiresAt).toBe(new Date(Number(b.agreement.expiry) * 1000).toISOString())
    expect(at(accepted()).data.acceptanceTransaction).toBe(TX)
  })
})

describe('webhook signatures', () => {
  it('match the Standard Webhooks test vector, so any of its libraries can check a delivery', () => {
    const secret = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'
    const body = '{"test": 2432232314}'
    const signature = signWebhook(secret, 'msg_p5jXN8AQM9LWM0D4loKWxJek', 1614265330, body)
    expect(signature).toBe('v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=')
    const headers = { id: 'msg_p5jXN8AQM9LWM0D4loKWxJek', timestamp: '1614265330', signature }
    expect(verifyWebhook(secret, headers, body, 1614265330)).toBe(true)
  })

  it('refuse another body, another secret, an old or future timestamp, and accept one of several signatures', () => {
    const now = Math.floor(T0 / 1000)
    const body = '{"a":1}'
    const signature = signWebhook(SECRET, 'msg_1', now, body)
    const headers = { id: 'msg_1', timestamp: String(now), signature }
    expect(verifyWebhook(SECRET, headers, body, now)).toBe(true)
    expect(verifyWebhook(SECRET, headers, '{"a":2}', now)).toBe(false)
    expect(verifyWebhook(makeWebhookSecret(), headers, body, now)).toBe(false)
    expect(verifyWebhook(SECRET, headers, body, now + 301)).toBe(false)
    expect(verifyWebhook(SECRET, headers, body, now - 301)).toBe(false)
    expect(verifyWebhook(SECRET, { ...headers, timestamp: 'soon' }, body, now)).toBe(false)
    const rotated = { ...headers, signature: `v1,bm90IGl0 ${signature}` }
    expect(verifyWebhook(SECRET, rotated, body, now)).toBe(true)
  })

  it('make secrets of 32 random bytes and take only well-formed ones', () => {
    expect(isWebhookSecret(SECRET)).toBe(true)
    expect(makeWebhookSecret()).not.toBe(SECRET)
    expect(Buffer.from(SECRET.slice('whsec_'.length), 'base64')).toHaveLength(32)
    for (const bad of ['', 'secret', 'whsec_short', `wh_${SECRET.slice(6)}`]) {
      expect(isWebhookSecret(bad), bad).toBe(false)
    }
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
  return { posts, post }
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
    const outbox = new Outbox(store.dir)
    const event = at(agreedBooking())
    expect(outbox.add(event, T0)).toBe(true)
    expect(outbox.add(event, T0)).toBe(false)
    expect(outbox.pending(() => {})).toHaveLength(1)
  })

  it('posts each due event signed, so the receiver can check it, then keeps it as delivered', async () => {
    const outbox = new Outbox(store.dir)
    const event = at(agreedBooking())
    outbox.add(event, T0)
    const { posts, post } = receiver([200])
    await sender(outbox, post, { now: T0 }).send()
    expect(posts).toHaveLength(1)
    const [{ headers, body }] = posts as [(typeof posts)[number]]
    expect(JSON.parse(body)).toEqual(event)
    expect(headers['webhook-id']).toBe(event.id)
    const signed = {
      id: headers['webhook-id'] as string,
      timestamp: headers['webhook-timestamp'] as string,
      signature: headers['webhook-signature'] as string,
    }
    expect(verifyWebhook(SECRET, signed, body, Math.floor(T0 / 1000))).toBe(true)
    expect(outbox.pending(() => {})).toHaveLength(0)
    expect(readdirSync(join(store.dir, 'outbox', 'delivered'))).toEqual([`${event.id}.json`])
    expect(outbox.add(event, T0)).toBe(false)
  })

  it("retries a failed delivery later, holding back that booking's later events and no other booking's", async () => {
    const outbox = new Outbox(store.dir)
    outbox.add(at(agreedBooking()), T0)
    outbox.add(at(withStatus('held'), T0 + 1000), T0 + 1000)
    const other = { ...agreedBooking(), commitmentId: OTHER }
    outbox.add(at(other, T0 + 2000), T0 + 2000)
    const clock = { now: T0 + 3000 }
    const { posts, post } = receiver([500, 200])
    const { send, lines } = sender(outbox, post, clock)
    await send()
    expect(posts.map((p) => JSON.parse(p.body).id)).toEqual([
      `msg_${COMMITMENT.slice(2)}_agreed`,
      `msg_${OTHER.slice(2)}_agreed`,
    ])
    expect(lines.some((l) => l.includes('the webhook answered 500'))).toBe(true)
    await send()
    expect(posts).toHaveLength(2)
    clock.now += 5_000
    await send()
    expect(posts.slice(2).map((p) => JSON.parse(p.body).type)).toEqual([
      'booking.agreed',
      'reserve.held',
    ])
    expect(outbox.pending(() => {})).toHaveLength(0)
  })

  it('waits longer after each failure, and gives an event up after three days', async () => {
    const outbox = new Outbox(store.dir)
    outbox.add(at(agreedBooking()), T0)
    const clock = { now: T0 }
    const { post } = receiver(Array(100).fill('down'))
    const { send, lines } = sender(outbox, post, clock)
    await send()
    const waits: number[] = []
    for (let i = 0; i < 3; i++) {
      const next = (outbox.pending(() => {})[0]?.nextAttemptAt ?? 0) - clock.now
      waits.push(next)
      clock.now += next
      await send()
    }
    expect(waits).toEqual([5_000, 30_000, 120_000])
    clock.now = T0 + 3 * 24 * 3_600_000
    await send()
    expect(outbox.pending(() => {})).toHaveLength(0)
    expect(readdirSync(join(store.dir, 'outbox', 'failed'))).toHaveLength(1)
    expect(lines.at(-1)).toContain('gave up on booking.agreed')
  })

  it('learns of every booking the store saves', () => {
    const outbox = new Outbox(store.dir)
    const seen: BookingStatus[] = []
    const hooked = new SupplierStore(join(store.dir, 'hooked'), (b) => {
      seen.push(b.status)
      const e = bookingEvent(b, new Date(T0))
      if (e) outbox.add(e, T0)
    })
    hooked.put(agreedBooking())
    hooked.put(withStatus('held'))
    hooked.put(withStatus('held'))
    expect(seen).toEqual(['agreed', 'held', 'held'])
    expect(outbox.pending(() => {}).map((p) => p.event.type)).toEqual([
      'booking.agreed',
      'reserve.held',
    ])
  })
})
