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
        state: 'accepted',
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
        ],
      },
    ])
  })

  it('shows the job with nothing prepaid, what breaking it costs and the booking it rests on', () => {
    const [, job] = commitmentCards(before('job_reserve_released'), ORDER, clock)
    expect(job).toEqual({
      role: 'job',
      from: "Avow's test customer",
      to: 'your business',
      state: 'accepted',
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
      ],
    })
  })

  it('says a commitment is released once its reserve came back, and reads moments in UTC by default', () => {
    const cards = commitmentCards(order, ORDER)
    expect(cards.map((c) => [c.role, c.state])).toContainEqual(['compute', 'released'])
    expect(cards[0]?.rows[0]?.text).toMatch(/from \d\d:\d\d UTC to \d\d:\d\d UTC/)
  })
})
