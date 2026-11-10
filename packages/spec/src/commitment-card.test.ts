import { describe, expect, it } from 'vitest'
import { commitmentCards } from './commitment-card.js'
import type { SessionEvent } from './sandbox.js'
import { AGENT_SESSION_EVENTS, JOB_EVENTS, ORDER, READ_BLOCK, START } from './test-helpers.js'

// The agent's listing and booking call, then the job's own events, as one order posts them.
const order: SessionEvent[] = [...AGENT_SESSION_EVENTS, ...JOB_EVENTS]
const before = (type: SessionEvent['type']) =>
  order.slice(
    0,
    order.findIndex((e) => e.type === type),
  )
// Minutes from the job's start, so a card's moments read against it.
const clock = (seconds: bigint) => `${(seconds - START) / 60n}m`

describe('a commitment as a card', () => {
  it('shows nothing before a commitment was accepted', () => {
    expect(commitmentCards(before('job_compute_secured'), ORDER)).toEqual([])
    expect(commitmentCards(order, 'another order')).toEqual([])
  })

  it('shows the compute booking once the supplier accepted it, from the offer the agent booked', () => {
    const cards = commitmentCards(before('job_commitment_checked'), ORDER, clock)
    expect(cards).toEqual([
      {
        role: 'compute',
        from: 'Your business',
        to: 'avow-demo-gpu',
        promise: 'accepted',
        money: 'reserved',
        rows: [
          {
            label: 'Promise',
            // The firm offer holds the GPU from two minutes before the job's start.
            text: 'Use 1 H100 from -2m to 15m, at $2.40 a GPU-hour paid as used',
          },
          {
            label: 'If broken',
            text: 'If your business cancels late or never shows, avow-demo-gpu charges up to $5.',
          },
          { label: 'Backed by', text: '$5 reserved in your lock, for avow-demo-gpu' },
          { label: 'Money now', text: 'Held in your lock' },
        ],
      },
    ])
  })

  it('shows the job with nothing prepaid, what breaking it costs and the booking it rests on', () => {
    const [, job] = commitmentCards(before('job_delivered'), ORDER, clock)
    expect(job).toEqual({
      role: 'job',
      from: "Avow's test customer",
      to: 'your business',
      promise: 'accepted',
      money: 'reserved',
      rows: [
        {
          label: 'Promise',
          text: 'Pay $40 on delivery, with nothing prepaid, for fine-tuning due by 30m',
        },
        {
          label: 'If broken',
          text: 'If the customer cancels after work starts, you charge up to $10. If it never hands over the inputs, you charge up to $6.',
        },
        { label: 'Backed by', text: "$10 reserved in the customer's lock, for your business" },
        {
          label: 'Depends on',
          text: `Your compute commitment, which the customer says it checked at block ${READ_BLOCK.number}`,
        },
        { label: 'Money now', text: "Held in the customer's lock" },
      ],
    })
  })

  it('keeps the promise apart from the money: kept once paid, with the reserve still held', () => {
    const [, job] = commitmentCards(before('job_customer_cancelled'), ORDER, clock)
    expect([job?.promise, job?.money]).toEqual(['kept', 'reserved'])
  })

  it('says a promise is broken at once, while the charge for it moves one step at a time', () => {
    const accepted = before('job_delivered')
    const reference = accepted.find((e) => e.type === 'job_work_started')?.reference
    if (!reference) throw new Error('the job started')
    const base = { run: 1, source: 'session' as const, orderId: ORDER, reference }
    const steps: SessionEvent[] = [
      { ...base, type: 'job_customer_cancelled', cancelledAt: START + 10n },
      {
        ...base,
        type: 'job_charge_reported',
        kind: 'lateCancellation',
        amount: 10_000_000n,
        reportNumber: 1,
        transactionHash: `0x${'ab'.repeat(32)}`,
      },
      {
        ...base,
        type: 'job_charge_confirmed',
        amount: 10_000_000n,
        contestableUntil: START + 660n,
      },
      { ...base, type: 'job_charge_paid', amount: 10_000_000n },
    ]
    const at = (count: number) => {
      const job = commitmentCards([...accepted, ...steps.slice(0, count)], ORDER, clock)[1]
      return [job?.promise, job?.money, job?.rows.at(-1)?.text]
    }
    expect(at(1)).toEqual(['broken', 'reserved', "Held in the customer's lock"])
    expect(at(2)).toEqual([
      'broken',
      'charge_reported',
      "$10 charge reported by your business, waiting for Avow's answer",
    ])
    expect(at(3)).toEqual([
      'broken',
      'charge_confirmed',
      "$10 charge confirmed by Avow. The customer can contest it until 11m, and it's payable then if it hasn't",
    ])
    expect(at(4)).toEqual(['broken', 'charged', '$10 paid to your business'])
    // A contest pauses the charge, and the promise stays broken.
    const paused = commitmentCards(
      [
        ...accepted,
        ...steps.slice(0, 3),
        { ...base, type: 'job_charge_paused', cause: 'contested' },
      ],
      ORDER,
      clock,
    )[1]
    expect([paused?.promise, paused?.money, paused?.rows.at(-1)?.text]).toEqual([
      'broken',
      'charge_paused',
      "Held in the customer's lock, paused for a ruling since the customer contested the charge",
    ])
  })

  it('says a commitment ended once its reserve came back, and reads moments in UTC by default', () => {
    const cards = commitmentCards(order, ORDER)
    expect(cards.map((c) => [c.role, c.promise, c.money])).toContainEqual([
      'compute',
      'ended',
      'released',
    ])
    expect(cards[0]?.rows[0]?.text).toMatch(/from \d\d:\d\d UTC to \d\d:\d\d UTC/)
  })
})
