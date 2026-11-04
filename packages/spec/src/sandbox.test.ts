import { describe, expect, it } from 'vitest'
import { dollars } from './demo.js'
import type { CommitmentReference } from './references.js'
import {
  formatUsd,
  isSessionId,
  newSessionId,
  parseSessionEvent,
  parseSessionEventAnswer,
  parseSessionEventPost,
  refusalSentence,
  SANDBOX_PATHS,
  SESSION_EVENT_TYPES,
  type SessionEvent,
} from './sandbox.js'
import { toWire } from './wire.js'

const reference: CommitmentReference = {
  kind: 'commitment',
  chainId: 42431,
  lock: '0x00000000000000000000000000000000000010c4',
  commitmentId: `0x${'ab'.repeat(32)}`,
  side: 'buyer',
  termsHash: `0x${'cd'.repeat(32)}`,
}

/** One event of each type, as the starter posts them. */
const events: SessionEvent[] = [
  { type: 'run_started', run: 1 },
  {
    type: 'authority_changed',
    run: 2,
    authority: dollars(800),
    previous: dollars(500),
    suppliers: ['avow-demo-gpu'],
    mandateHash: `0x${'ef'.repeat(32)}`,
  },
  {
    type: 'refused',
    run: 2,
    code: 'mandate.over_open_reserves_cap',
    layer: 'avow',
    amounts: {
      needed: dollars(400),
      left: dollars(300),
      authority: dollars(500),
      dailyLimit: dollars(500),
    },
  },
  { type: 'committed', run: 3, reference, amount: dollars(250) },
  { type: 'accepted', run: 3, reference },
]

/** The event as it crosses JSON between the starter, Avow's API and the screen. */
const overJson = (value: unknown): unknown => JSON.parse(JSON.stringify(toWire(value)))

describe('session ids', () => {
  it('makes ids of 32 lower-case hex characters, a new one each time', () => {
    const a = newSessionId()
    expect(isSessionId(a)).toBe(true)
    expect(a).not.toBe(newSessionId())
  })

  it('puts only a session id in a path', () => {
    const id = newSessionId()
    expect(SANDBOX_PATHS.sessionEvents(id)).toBe(`/v1/sandbox/sessions/${id}/events`)
    for (const bad of ['', '../businesses', id.toUpperCase(), `${id}0`]) {
      expect(isSessionId(bad)).toBe(false)
      expect(() => SANDBOX_PATHS.sessionEvents(bad)).toThrow(RangeError)
    }
  })
})

describe('session events', () => {
  it('names every type once', () => {
    expect(new Set(events.map((e) => e.type))).toEqual(new Set(SESSION_EVENT_TYPES))
  })

  it('reads back every event exactly as it went out', () => {
    for (const event of events) {
      expect(parseSessionEvent(overJson(event))).toEqual({ ok: true, value: event })
      expect(parseSessionEventPost(overJson({ event }))).toEqual({ ok: true, value: { event } })
    }
  })

  it('refuses an unknown type, a field the schema lacks, or a value out of form', () => {
    const refused = overJson(events[2]) as Record<string, unknown>
    const bad: unknown[] = [
      { type: 'run_finished', run: 1 },
      { type: 'run_started', run: 1, note: 'hello' },
      { type: 'run_started', run: 0 },
      { ...refused, code: 'mandate.too_big' },
      { ...refused, layer: 'supplier' },
      { ...refused, amounts: { needed: '-1', left: '0', authority: '0', dailyLimit: null } },
      { ...(overJson(events[3]) as object), reference: { ...reference, kind: 'payment' } },
    ]
    for (const json of bad) expect(parseSessionEvent(json).ok).toBe(false)
    expect(parseSessionEventPost({ event: events[0], extra: 1 }).ok).toBe(false)
  })

  it("reads Avow's answer as the event's place in the session", () => {
    expect(parseSessionEventAnswer({ sequence: 3 })).toEqual({ ok: true, value: { sequence: 3 } })
    expect(parseSessionEventAnswer({ sequence: 0 }).ok).toBe(false)
  })
})

describe('refusalSentence', () => {
  const amounts = {
    needed: dollars(400),
    left: dollars(300),
    authority: dollars(500),
    dailyLimit: dollars(500),
  }
  const onChain =
    "The lock takes no reserve without Avow's approval, and your agent's key can't move more than $500 a day, a limit your business set on chain."

  it('says what the booking needs, what authority is left, who refused and what the chain holds', () => {
    expect(
      refusalSentence({ code: 'mandate.over_open_reserves_cap', layer: 'avow', amounts }),
    ).toBe(
      `This booking needs $400 and your agent has $300 of authority left, so Avow refused the reserve and no money moved. ${onChain}`,
    )
    expect(refusalSentence({ code: 'mandate.over_commitment_cap', layer: 'sdk', amounts })).toBe(
      `This booking needs $400 and your agent's whole authority is $500, so the SDK refused the reserve and no money moved. ${onChain}`,
    )
    expect(
      refusalSentence({
        code: 'mandate.over_open_reserves_cap',
        layer: 'avow',
        amounts: { ...amounts, dailyLimit: null },
      }),
    ).toBe(
      "This booking needs $400 and your agent has $300 of authority left, so Avow refused the reserve and no money moved. The lock takes no reserve without Avow's approval.",
    )
  })

  it("says the lock refused when it did, and nothing it can't back", () => {
    expect(
      refusalSentence({ code: 'mandate.over_open_reserves_cap', layer: 'lock', amounts }),
    ).toBe(
      'This booking needs $400 and your agent has $300 of authority left, so the lock refused the reserve and no money moved.',
    )
    expect(refusalSentence({ code: 'sponsorship.simulation_failed', layer: 'lock', amounts })).toBe(
      "The lock refused this $400 booking and no money moved. The transaction fails when it runs on the latest block, so Avow's relay won't pay for it.",
    )
    for (const layer of ['sdk', 'avow', 'lock'] as const) {
      expect(refusalSentence({ code: 'mandate.expired', layer, amounts })).not.toMatch(
        /would refuse|even with/,
      )
    }
  })

  it('writes dollars with cents only when there are some', () => {
    expect(formatUsd(dollars(1500))).toBe('$1,500')
    expect(formatUsd(12_500_000n)).toBe('$12.50')
    expect(formatUsd(1n)).toBe('$0.000001')
    expect(formatUsd(0n)).toBe('$0')
  })
})
