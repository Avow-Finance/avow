import { getAddress } from 'viem'
import { describe, expect, it } from 'vitest'
import { dollars } from './demo.js'
import type { CommitmentReference } from './references.js'
import {
  accountOfSandboxId,
  formatUsd,
  isSessionId,
  newSessionId,
  parseSessionEvent,
  parseSessionEventAnswer,
  parseSessionEventPost,
  refusalReason,
  refusalSentence,
  SANDBOX_PATHS,
  SESSION_EVENT_TYPES,
  type SessionEvent,
  sandboxBusinessId,
  whenRetryPasses,
} from './sandbox.js'
import { AGENT_SESSION_EVENTS, JOB_EVENTS } from './test-helpers.js'
import { toWire } from './wire.js'

const reference: CommitmentReference = {
  kind: 'commitment',
  chainId: 42431,
  lock: '0x00000000000000000000000000000000000010c4',
  commitmentId: `0x${'ab'.repeat(32)}`,
  side: 'buyer',
  termsHash: `0x${'cd'.repeat(32)}`,
}

/** One event of each type, as the starter and a job post them. */
const events: SessionEvent[] = [
  { type: 'run_started', run: 1, source: 'script', tool: null },
  { type: 'run_started', run: 1, source: 'mcp', tool: 'book' },
  {
    type: 'authority_changed',
    run: 2,
    source: 'business',
    authority: dollars(800),
    previous: dollars(500),
    suppliers: ['avow-demo-gpu'],
    mandateHash: `0x${'ef'.repeat(32)}`,
  },
  {
    type: 'refused',
    run: 2,
    source: 'mcp',
    code: 'mandate.over_open_reserves_cap',
    layer: 'avow',
    amounts: {
      needed: dollars(400),
      left: dollars(300),
      authority: dollars(500),
      capPerCommitment: dollars(500),
      dailyLimit: dollars(500),
      dailyLeft: dollars(300),
    },
  },
  { type: 'committed', run: 3, source: 'script', reference, amount: dollars(250) },
  { type: 'accepted', run: 3, source: 'script', reference },
  ...JOB_EVENTS,
  ...AGENT_SESSION_EVENTS,
]

/** The event as it crosses JSON between the starter, Avow's API and the screen. */
const overJson = (value: unknown): unknown => JSON.parse(JSON.stringify(toWire(value)))

describe('sandbox business ids', () => {
  it('name the account they were made from, and nothing else', () => {
    const account = getAddress('0x9df2eec2a472a1819d20fba1f8a6f70a232f6447')
    const id = sandboxBusinessId(account)
    expect(id).toBe('sandbox-9df2eec2a472a1819d20fba1f8a6f70a232f6447')
    expect(accountOfSandboxId(id)).toBe(account)
    expect(accountOfSandboxId('sandbox-nobody')).toBeNull()
    expect(accountOfSandboxId('avow-demo-gpu')).toBeNull()
    expect(accountOfSandboxId(`${id}0`)).toBeNull()
  })
})

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
    const refused = overJson(events[3]) as Record<string, unknown>
    const bad: unknown[] = [
      { type: 'run_finished', run: 1, source: 'script', tool: null },
      { type: 'run_started', run: 1, source: 'script', tool: null, note: 'hello' },
      { type: 'run_started', run: 0, source: 'script', tool: null },
      { type: 'run_started', run: 1, source: 'someone', tool: null },
      { type: 'run_started', run: 1, source: 'mcp', tool: 'pay' },
      { type: 'run_started', run: 1 },
      { ...refused, code: 'mandate.too_big' },
      { ...refused, layer: 'model' },
      {
        ...refused,
        amounts: {
          needed: '-1',
          left: '0',
          authority: '0',
          capPerCommitment: '0',
          dailyLimit: null,
          dailyLeft: null,
        },
      },
      { ...(overJson(events[4]) as object), reference: { ...reference, kind: 'payment' } },
    ]
    for (const json of bad) expect(parseSessionEvent(json).ok).toBe(false)
    expect(parseSessionEventPost({ event: events[0], extra: 1 }).ok).toBe(false)
  })

  it('still reads a refusal posted before refusals recorded the cap per commitment', () => {
    const refused = overJson(events[3]) as { amounts: Record<string, unknown> }
    const { capPerCommitment: _, ...before } = refused.amounts
    const read = parseSessionEvent({ ...refused, amounts: before })
    if (!read.ok || read.value.type !== 'refused') throw new Error('the old refusal reads')
    expect(read.value.amounts.capPerCommitment).toBeNull()
    expect(
      refusalSentence({ ...read.value, code: 'mandate.over_commitment_cap', layer: 'avow' }),
    ).toContain('more than your mandate allows for one commitment')
  })

  it('says a relay that changed the bytes sent nothing, and the same booking can go again', () => {
    expect(whenRetryPasses({ code: 'sponsorship.altered', layer: 'relay' })).toBe(
      'Nothing was sent, so the same booking can pass when you try again.',
    )
  })

  it('takes a job accepted with no transaction seen, and no transaction without its block', () => {
    const checked = JOB_EVENTS.find((e) => e.type === 'job_commitment_checked')
    if (!checked) throw new Error('The fixtures check a commitment')
    const unseen = { ...checked, acceptedIn: null }
    expect(parseSessionEvent(overJson(unseen))).toEqual({ ok: true, value: unseen })
    const json = overJson(checked) as { acceptedIn: Record<string, unknown> }
    const { blockNumber: _, ...noBlock } = json.acceptedIn
    expect(parseSessionEvent({ ...json, acceptedIn: noBlock }).ok).toBe(false)
  })

  it('takes business on an authority change and on nothing else', () => {
    const changed = overJson(events[2]) as Record<string, unknown>
    for (const source of ['script', 'mcp']) {
      expect(parseSessionEvent({ ...changed, source }).ok).toBe(false)
    }
    for (const event of events.filter((e) => e.type !== 'authority_changed')) {
      expect(parseSessionEvent({ ...(overJson(event) as object), source: 'business' }).ok).toBe(
        false,
      )
    }
  })

  it("reads Avow's answer as the event's place in the session", () => {
    expect(parseSessionEventAnswer({ sequence: 3 })).toEqual({ ok: true, value: { sequence: 3 } })
    expect(parseSessionEventAnswer({ sequence: 0 }).ok).toBe(false)
  })
})

describe('refusalSentence', () => {
  it('gives the refusal, then when the same booking could pass, in one sentence for every side', () => {
    const amounts = {
      needed: dollars(400),
      left: dollars(300),
      authority: dollars(500),
      capPerCommitment: dollars(500),
      dailyLimit: dollars(1000),
      dailyLeft: dollars(800),
    }
    const r = { code: 'mandate.over_open_reserves_cap', layer: 'avow', amounts } as const
    expect(refusalSentence(r)).toBe(`${refusalReason(r)} ${whenRetryPasses(r)}`)
    expect(refusalSentence(r)).toMatch(
      /^This booking needs \$400 and your agent has \$300 left of its \$500 held at once, so Avow refused .* The same booking can pass once enough of what the agent holds is released/,
    )
  })
})

describe('whenRetryPasses', () => {
  it('says when the same booking could pass, for each way it was refused', () => {
    expect(whenRetryPasses({ code: 'mandate.over_open_reserves_cap', layer: 'avow' })).toMatch(
      /once enough of what the agent holds is released, .* or once the business raises the authority/,
    )
    expect(whenRetryPasses({ code: 'keychain.over_daily_limit', layer: 'keychain' })).toMatch(
      /once the key's day starts again, or once the business raises the daily limit/,
    )
    expect(whenRetryPasses({ code: 'sponsorship.rate_limited', layer: 'relay' })).toMatch(
      /only limiting .* can pass when you try again later/,
    )
    expect(whenRetryPasses({ code: 'sponsorship.refused', layer: 'relay' })).toMatch(
      /only once what it checked changes/,
    )
    expect(whenRetryPasses({ code: 'mandate.supplier_not_allowed', layer: 'sdk' })).toMatch(
      /only once the business signs a new mandate/,
    )
    expect(whenRetryPasses({ code: 'chain.reserve_missing', layer: 'unknown' })).toMatch(
      /^The same booking might pass if you try again\.$/,
    )
  })
})

describe('refusalReason', () => {
  const amounts = {
    needed: dollars(400),
    left: dollars(300),
    authority: dollars(500),
    capPerCommitment: dollars(350),
    dailyLimit: dollars(500),
    dailyLeft: dollars(300),
  }
  const onChain =
    "The lock takes no reserve without Avow's approval, and your agent's key moves at most $500 a day, a limit your business set on chain."

  it('says what the booking needs, what authority is left, who refused and what the chain holds', () => {
    expect(refusalReason({ code: 'mandate.over_open_reserves_cap', layer: 'avow', amounts })).toBe(
      `This booking needs $400 and your agent has $300 left of its $500 held at once, so Avow refused the reserve and no money moved. ${onChain}`,
    )
    // The per-commitment cap is its own number, never the held-at-once one.
    expect(refusalReason({ code: 'mandate.over_commitment_cap', layer: 'sdk', amounts })).toBe(
      `This booking needs $400, more than the $350 your mandate allows for one commitment, so the SDK refused the reserve and no money moved. ${onChain}`,
    )
    expect(
      refusalReason({
        code: 'mandate.over_open_reserves_cap',
        layer: 'avow',
        amounts: { ...amounts, dailyLimit: null },
      }),
    ).toBe(
      "This booking needs $400 and your agent has $300 left of its $500 held at once, so Avow refused the reserve and no money moved. The lock takes no reserve without Avow's approval.",
    )
  })

  it("says Avow's relay and the account's keychain refused when they did", () => {
    expect(refusalReason({ code: 'sponsorship.rate_limited', layer: 'relay', amounts })).toMatch(
      /^Avow's relay refused this \$400 booking and no money moved\./,
    )
    expect(
      refusalReason({
        code: 'keychain.over_daily_limit',
        layer: 'keychain',
        amounts: { ...amounts, dailyLeft: dollars(200) },
      }),
    ).toBe(
      "This booking needs $400. Your agent had $300 left of its $500 held at once, so Avow approved it, but its key has $200 left of its $500 a day, so your account's keychain refused it and no money moved. Your business set that daily limit on chain, and no approval from Avow lifts it.",
    )
  })

  it('says so when nothing gave a reason', () => {
    expect(refusalReason({ code: 'chain.reserve_missing', layer: 'unknown', amounts })).toBe(
      'The reserve for this $400 booking never landed, and nothing on the way said why, so no money moved.',
    )
  })

  it("says the lock refused when it did, and nothing it can't back", () => {
    expect(refusalReason({ code: 'mandate.over_open_reserves_cap', layer: 'lock', amounts })).toBe(
      'This booking needs $400 and your agent has $300 left of its $500 held at once, so the lock refused the reserve and no money moved.',
    )
    expect(refusalReason({ code: 'sponsorship.simulation_failed', layer: 'lock', amounts })).toBe(
      "The lock refused this $400 booking and no money moved. The transaction fails when it runs on the latest block, so Avow's relay won't pay for it.",
    )
    for (const layer of ['sdk', 'avow', 'lock'] as const) {
      expect(refusalReason({ code: 'mandate.expired', layer, amounts })).not.toMatch(
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
