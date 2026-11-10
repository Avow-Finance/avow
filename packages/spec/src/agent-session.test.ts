import { describe, expect, it } from 'vitest'
import { JOB_TOOLS, SPEAKER_NAME, speakerName, toolResultProblem } from './agent-session.js'
import { encodeApiBody } from './api-request.js'
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

  it('name a model the way the terminal can draw it, and the customer by what it said', () => {
    expect(speakerName('qwen3:8b')).toBe('qwen3:8b')
    expect(speakerName('hf.co/org/model\u001b[31m')).toBe('hf.co/org/model--31m')
    expect(speakerName('x'.repeat(80))).toHaveLength(64)
    // A name starts with a letter or a digit, as the terminal draws one.
    expect(speakerName('@cf/meta/llama-3.1-8b-instruct')).toBe('cf/meta/llama-3.1-8b-instruct')
    expect(speakerName('-qwen')).toBe('qwen')
    expect(speakerName(':latest')).toBe('latest')
    expect(speakerName(' ./ ')).toBe('model')
    for (const name of ['@cf/meta/llama-3.1-8b-instruct', '-qwen', ':latest', ' qwen3']) {
      expect(SPEAKER_NAME.test(name), name).toBe(false)
      expect(SPEAKER_NAME.test(speakerName(name)), name).toBe(true)
    }
    const said = kind('said', (e) => (e.speaker as { kind: string }).kind === 'model')
    expect(reads({ ...said, speaker: { kind: 'model', model: 'a\nb' } })).toBe(false)
    expect(reads({ ...said, speaker: { kind: 'model', model: '-qwen' } })).toBe(false)
    const customer = kind('said', (e) => (e.speaker as { kind: string }).kind === 'customer')
    expect(reads({ ...customer, speaker: { kind: 'customer' } })).toBe(false)
  })

  it('keep speech apart, from a model by its id or from the customer, and never anyone else', () => {
    const said = kind('said')
    expect(reads({ ...said, speaker: { kind: 'developer' } })).toBe(false)
    expect(reads({ ...said, speaker: { kind: 'model' } })).toBe(false)
    expect(reads({ ...said, text: '' })).toBe(false)
    expect(reads({ ...said, check: 'dependency' })).toBe(false)
  })

  it('carry the offer and quantity on a booking call, both or neither, and on no other', () => {
    const book = kind('tool_call', (e) => e.tool === 'book_compute')
    const { quantity: _, ...noQuantity } = book
    expect(reads(noQuantity)).toBe(false)
    // A call whose input wasn't in the tool's form names neither.
    expect(reads({ ...book, offer: null, quantity: null })).toBe(true)
    expect(reads({ ...book, offer: null })).toBe(false)
    expect(reads({ ...book, quantity: null })).toBe(false)
    const other = kind('tool_call', (e) => e.tool === 'compute_offers')
    expect(reads({ ...other, offer: 'h100-firm', quantity: 1 })).toBe(false)
  })

  it('pair a booking call that didn’t read with a refusal by service, and never with a booking', () => {
    type Call = Extract<(typeof AGENT_SESSION_EVENTS)[number], { type: 'tool_call' }>
    type Result = Extract<(typeof AGENT_SESSION_EVENTS)[number], { type: 'tool_result' }>
    const call = AGENT_SESSION_EVENTS.find(
      (e): e is Call => e.type === 'tool_call' && e.tool === 'book_compute',
    )
    const result = AGENT_SESSION_EVENTS.find(
      (e): e is Result => e.type === 'tool_result' && e.call === call?.call,
    )
    if (!call || !result || result.ok) throw new Error('the fixtures refuse a booking')
    expect(toolResultProblem(call, result)).toBeNull()
    const unread = { ...call, offer: null, quantity: null } as Call
    const byService = { ...result, layer: 'service', code: 'message.invalid' } as Result
    expect(toolResultProblem(unread, byService)).toBeNull()
    // A booking, or a refusal anyone else made, can't be what a call that named nothing got.
    expect(toolResultProblem(unread, result)).toBe('message.invalid')
    const { code: _, layer: __, ...rest } = result
    expect(toolResultProblem(unread, { ...rest, ok: true } as Result)).toBe('message.invalid')
    expect(toolResultProblem(call, { ...result, call: result.call + 1 })).toBe('message.invalid')
    expect(toolResultProblem(call, { ...result, recalled: { run: 1, call: 2 } })).toBe(
      'message.invalid',
    )
  })

  it('encode for the relay as they are, a listing’s offers included', () => {
    // The relay signs each event as canonical JSON, which holds no fractions, so every number in
    // an event, an offer's window among them, is a whole number.
    for (const e of AGENT_SESSION_EVENTS) {
      expect(() => encodeApiBody({ event: e }), String(e.type)).not.toThrow()
    }
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
