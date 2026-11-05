import { describe, expect, it } from 'vitest'
import { JOB_TOOLS } from './agent-session.js'
import { parseSessionEvent, refusalSentence, whenRetryPasses } from './sandbox.js'
import { AGENT_SESSION_EVENTS, ORDER } from './test-helpers.js'
import { toWire } from './wire.js'

const overJson = (value: unknown): Record<string, unknown> =>
  JSON.parse(JSON.stringify(toWire(value)))
const kind = (type: string, extra: (e: Record<string, unknown>) => boolean = () => true) => {
  const found = AGENT_SESSION_EVENTS.map(overJson).find((e) => e.type === type && extra(e))
  if (!found) throw new Error(`no ${type} fixture`)
  return found
}
const reads = (json: unknown) => parseSessionEvent(json).ok

describe('the agent session’s events', () => {
  it('give the model exactly the seven job tools', () => {
    expect(JOB_TOOLS).toEqual([
      'read_order',
      'compute_offers',
      'book_compute',
      'cancel_compute',
      'submit_quote',
      'authority',
      'commitments',
    ])
  })

  it('name a run’s order, or null for a turn the developer started, on every event', () => {
    for (const e of AGENT_SESSION_EVENTS.map(overJson)) {
      expect(e.orderId === ORDER || e.orderId === null, String(e.type)).toBe(true)
      const { orderId: _, ...missing } = e
      expect(reads(missing), String(e.type)).toBe(false)
    }
  })

  it('keep speech apart, from a model by its id or from the customer, and never anyone else', () => {
    const said = kind('said')
    expect(reads({ ...said, speaker: { kind: 'developer' } })).toBe(false)
    expect(reads({ ...said, speaker: { kind: 'model' } })).toBe(false)
    expect(reads({ ...said, text: '' })).toBe(false)
    expect(reads({ ...said, check: 'dependency' })).toBe(false)
  })

  it('carry the offer and quantity on a booking call, and on no other', () => {
    const book = kind('tool_call', (e) => e.tool === 'book_compute')
    const { quantity: _, ...noQuantity } = book
    expect(reads(noQuantity)).toBe(false)
    const other = kind('tool_call', (e) => e.tool === 'compute_offers')
    expect(reads({ ...other, offer: 'h100-firm', quantity: 1 })).toBe(false)
  })

  it('carry the listing and its limits only on a listing’s result, and a refusal’s code and layer only on a refusal', () => {
    const listing = kind('tool_result', (e) => e.tool === 'compute_offers' && e.recalled === null)
    expect(reads({ ...listing, tool: 'authority' })).toBe(false)
    expect(reads({ ...listing, listing: null })).toBe(false)
    expect(reads({ ...listing, limits: null })).toBe(false)
    // The listing says when it was listed, so whether each offer was firm reads from the event.
    expect(listing.listing).toMatchObject({ listedAt: expect.any(String) })
    const refused = kind('tool_result', (e) => e.ok === false)
    expect(reads({ ...refused, layer: 'model' })).toBe(false)
    expect(reads({ ...refused, ok: true })).toBe(false)
    const { code: _, ...noCode } = refused
    expect(reads(noCode)).toBe(false)
  })

  it('mark a result shown again as evidence with the run and call that made it', () => {
    const recalled = kind('tool_result', (e) => e.recalled !== null)
    expect(recalled.recalled).toEqual({ run: 3, call: 1 })
    expect(reads({ ...recalled, recalled: { run: 3 } })).toBe(false)
  })

  it('give every fact who verified it, the commitment, the block and any transaction', () => {
    const fact = kind('fact')
    expect(reads({ ...fact, verifiedBy: 'model' })).toBe(false)
    expect(reads({ ...fact, block: null })).toBe(false)
    const { reference: _, ...unbound } = fact
    expect(reads(unbound)).toBe(false)
    expect(reads({ ...fact, check: 'speech' })).toBe(false)
  })

  it('give a job’s receipt, and only a job’s, the verification its link carries, naming that commitment', () => {
    const job = kind('commitment', (e) => e.role === 'job')
    const compute = kind('commitment', (e) => e.role === 'compute')
    expect(reads({ ...job, verification: null })).toBe(false)
    expect(reads({ ...compute, verification: job.verification })).toBe(false)
    expect(reads({ ...job, reference: compute.reference })).toBe(false)
  })
})

describe('a refusal by the developer’s service.ts or the customer’s verifier', () => {
  const amounts = {
    needed: 40_000_000n,
    left: 500_000_000n,
    authority: 500_000_000n,
    capPerCommitment: 500_000_000n,
    dailyLimit: null,
    dailyLeft: null,
  }

  it('says who refused and when the same booking could pass', () => {
    const off = { code: 'service.compute_off', layer: 'service', amounts } as const
    expect(refusalSentence(off)).toBe(
      'Your service.ts refused this $40 booking and no money moved. The compute switch in service.ts is off, so the tool layer books no compute and a quote names no booking. The same booking can pass once the compute switch in service.ts is on again.',
    )
    expect(whenRetryPasses({ code: 'service.over_budget', layer: 'service' })).toContain(
      'compute budget',
    )
    expect(whenRetryPasses({ code: 'dependency.required', layer: 'customer' })).toBe(
      "The customer's verifier gives the same answer until what it checked changes.",
    )
  })
})
