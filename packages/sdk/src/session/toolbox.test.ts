import { type SessionEvent, toolResultProblem } from '@avow-finance/spec'
import { describe, expect, it } from 'vitest'
import { fixtureWorld } from './fixture-world.js'
import { chooseOffer } from './scripted.js'
import {
  defineService,
  dontStart,
  policyChanges,
  readPolicy,
  readVerdict,
  type ServicePolicy,
  start,
} from './service.js'
import { newSessionState, Toolbox } from './toolbox.js'

/** A tool layer over the fixture world under a policy, recording its events. */
async function toolbox(
  policy: ServicePolicy = { budgetPerGpuHour: 3_000_000n, computeSwitch: 'on' },
) {
  const world = fixtureWorld()
  const events: SessionEvent[] = []
  const state = newSessionState()
  state.order = await world.pullOrder()
  const box = new Toolbox(
    world,
    () => policy,
    (e) => events.push(e),
    state,
  )
  let call = 0
  const run = (tool: Parameters<Toolbox['run']>[0], input: unknown = {}) =>
    box.run(tool, input, { run: 1, orderId: state.order?.orderId ?? null, call: ++call })
  return { world, events, state, run }
}

const last = <T extends SessionEvent['type']>(events: SessionEvent[], type: T) =>
  events.filter((e): e is Extract<SessionEvent, { type: T }> => e.type === type).at(-1)

describe('the tool layer', () => {
  it('records a booking call whose input didn’t read as the booking tool, refused by service', async () => {
    const t = await toolbox()
    const outcome = await t.run('book_compute', { offer: 42 })
    expect(outcome.ok).toBe(false)
    const call = last(t.events, 'tool_call')
    const result = last(t.events, 'tool_result')
    expect(call).toMatchObject({ tool: 'book_compute', offer: null, quantity: null })
    expect(result).toMatchObject({ ok: false, layer: 'service', code: 'message.invalid' })
    if (!call || !result) throw new Error('the call and its result were posted')
    expect(toolResultProblem(call, result)).toBeNull()
  })

  it('books the firm offer, and refuses what service.ts, the SDK or the listing rule out', async () => {
    const t = await toolbox()
    await t.run('compute_offers')
    expect((await t.run('book_compute', { offer: 'h100-gone', quantity: 1 })).ok).toBe(false)
    expect(last(t.events, 'tool_result')).toMatchObject({
      code: 'service.unknown_offer',
      layer: 'service',
    })
    expect((await t.run('book_compute', { offer: 'h100-x16', quantity: 2 })).ok).toBe(false)
    expect(last(t.events, 'tool_result')).toMatchObject({ code: 'service.quantity_unavailable' })
    // 16 GPUs reserve $640, past the $500 the mandate allows for one commitment.
    expect((await t.run('book_compute', { offer: 'h100-x16', quantity: 16 })).ok).toBe(false)
    expect(last(t.events, 'refused')).toMatchObject({
      code: 'mandate.over_commitment_cap',
      layer: 'sdk',
    })
    const booked = await t.run('book_compute', { offer: 'h100-firm', quantity: 1 })
    expect(booked.ok).toBe(true)
    expect(JSON.parse(booked.content)).toMatchObject({
      booking: 'b1',
      offer: 'h100-firm',
      reserve: '$40',
    })
    expect(last(t.events, 'commitment')).toMatchObject({
      role: 'compute',
      verifiedBy: 'service',
      state: 'accepted',
    })
  })

  it('reads service.ts again before each booking, so an edit mid-turn applies to it', async () => {
    const world = fixtureWorld()
    const events: SessionEvent[] = []
    const state = newSessionState()
    state.order = await world.pullOrder()
    let policy: ServicePolicy = { budgetPerGpuHour: 3_000_000n, computeSwitch: 'on' }
    const box = new Toolbox(
      world,
      () => policy,
      (e) => events.push(e),
      state,
      async () => {
        policy = { ...policy, computeSwitch: 'off' }
      },
    )
    const ctx = { run: 1, orderId: state.order.orderId, call: 1 }
    await box.run('compute_offers', {}, ctx)
    await box.run('book_compute', { offer: 'h100-firm', quantity: 1 }, { ...ctx, call: 2 })
    expect(last(events, 'refused')).toMatchObject({ code: 'service.compute_off', layer: 'service' })
  })

  it('applies the compute budget and the compute switch before anything is booked', async () => {
    const tight = await toolbox({ budgetPerGpuHour: 2_000_000n, computeSwitch: 'on' })
    await tight.run('compute_offers')
    await tight.run('book_compute', { offer: 'h100-firm', quantity: 1 })
    expect(last(tight.events, 'refused')).toMatchObject({
      code: 'service.over_budget',
      layer: 'service',
    })
    const off = await toolbox({ budgetPerGpuHour: 3_000_000n, computeSwitch: 'off' })
    await off.run('compute_offers')
    await off.run('book_compute', { offer: 'h100-firm', quantity: 1 })
    expect(last(off.events, 'refused')).toMatchObject({
      code: 'service.compute_off',
      layer: 'service',
    })
    // With the switch off a quote takes no booking, and one that names a booking is refused.
    expect((await off.run('submit_quote', { booking: 'b1' })).ok).toBe(false)
    expect(last(off.events, 'tool_result')).toMatchObject({ code: 'service.compute_off' })
    expect((await off.run('submit_quote')).ok).toBe(true)
    expect(last(off.events, 'job_quote_sent')).toMatchObject({ compute: null })
  })
})

describe('the scripted choice of compute', () => {
  const order = {
    orderId: 'o',
    needs: { gpu: 'H100', gpus: 1 },
    deliverBy: 'x, 10 min after the job starts',
  }
  const offer = (id: string, price: string, extra: object = {}) => ({
    id,
    gpusPerBooking: '1 to 16',
    windowStarts: 'x, 2 min before the job starts',
    windowEnds: 'x, 15 min after the job starts',
    pricePerGpuHour: price,
    freeCancellation: 'none, firm',
    ...extra,
  })
  const listing = (budget: string) => ({
    offers: [
      offer('flex', '$1.60', { freeCancellation: 'until x, when the job starts' }),
      offer('later', '$2.20', { windowStarts: 'x, 20 min after the job starts' }),
      offer('firm', '$2.40'),
    ],
    limits: { computeBudgetPerGpuHour: budget, computeSwitch: 'on' as const },
  })

  it('takes the cheapest firm offer that holds the whole job, within the budget', () => {
    expect(chooseOffer(order, listing('$3.00'))).toMatchObject({ offer: { id: 'firm' } })
    expect(chooseOffer(order, listing('$2.00'))).toEqual({
      none: 'every offer that fits costs more than the $2.00 budget',
    })
  })
})

describe("the developer's service", () => {
  it('refuses a budget, a switch or a check that isn’t what it takes', () => {
    const check = async () => dontStart({ code: 'message.invalid' })
    expect(() =>
      defineService({ computeBudgetPerGpuHour: 2.405, bookCompute: true, checkBeforeWork: check }),
    ).toThrow('positive amount of dollars')
    expect(() =>
      defineService({
        computeBudgetPerGpuHour: 3,
        bookCompute: 'yes' as never,
        checkBeforeWork: check,
      }),
    ).toThrow('true or false')
    expect(() =>
      defineService({
        computeBudgetPerGpuHour: 3,
        bookCompute: true,
        checkBeforeWork: null as never,
      }),
    ).toThrow('has to be a function')
    expect(
      defineService({ computeBudgetPerGpuHour: 2.4, bookCompute: false, checkBeforeWork: check })
        .policy,
    ).toEqual({
      budgetPerGpuHour: 2_400_000n,
      computeSwitch: 'off',
    })
  })

  it('reads a verdict at the boundary, and nothing that isn’t one', () => {
    const block = { number: '12', hash: `0x${'ab'.repeat(32)}`, timestamp: '1800000000' }
    const started = readVerdict({
      start: true,
      check: { ok: true, state: 'reserved', reserve: '10000000', block, bookings: [] },
    })
    expect(started).toEqual({
      start: true,
      check: {
        ok: true,
        state: 'reserved',
        reserve: 10_000_000n,
        block: { number: 12n, hash: block.hash, timestamp: 1_800_000_000n },
        bookings: [],
      },
    })
    expect(
      readVerdict({ start: false, code: 'chain.reserve_mismatch', block: null, index: null }),
    ).toEqual(dontStart({ code: 'chain.reserve_mismatch' }))
    for (const bad of [
      { start: true },
      { start: 'yes' },
      { start: false, code: 'made.up', block: null, index: null },
      { start: false, code: 'chain.reserve_mismatch', block: { number: 'x' }, index: null },
      { start: false, code: 'chain.reserve_mismatch', block: null, index: 9 },
      { start: true, check: { ok: true, state: 'paid', reserve: '1', block, bookings: [] } },
    ]) {
      expect(readVerdict(bad), JSON.stringify(bad)).toBeNull()
    }
    expect(readPolicy({ budgetPerGpuHour: '1800000', computeSwitch: 'off' })).toEqual({
      budgetPerGpuHour: 1_800_000n,
      computeSwitch: 'off',
    })
    expect(readPolicy({ budgetPerGpuHour: 1.8, computeSwitch: 'off' })).toBeNull()
    expect(start({ ok: false, code: 'chain.reserve_missing', block: null, index: null })).toEqual(
      dontStart({ code: 'chain.reserve_missing' }),
    )
  })

  it('says each change a developer makes to service.ts in one line', () => {
    const before: ServicePolicy = { budgetPerGpuHour: 3_000_000n, computeSwitch: 'on' }
    expect(policyChanges(before, before)).toEqual([])
    expect(policyChanges(before, { budgetPerGpuHour: 1_800_000n, computeSwitch: 'off' })).toEqual([
      'service.ts changed: compute booking is off',
      'service.ts changed: budget is now $1.80 per GPU-hour',
    ])
  })
})
