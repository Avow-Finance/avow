import type { OrderState, SessionEvent } from '@avow-finance/spec'
import { describe, expect, it } from 'vitest'
import { JobExecutor } from './executor.js'
import { type FixtureWorld, fixtureWorld } from './fixture-world.js'
import { defineService, dontStart, start, type Verdict } from './service.js'
import { serviceChecks, snapshotChain } from './service-check.js'
import type { JobWorld } from './world.js'

const service = defineService({
  computeBudgetPerGpuHour: 3,
  bookCompute: true,
  async checkBeforeWork(job, avow) {
    const check = await avow.verifyCommitment(job)
    return check.ok ? start(check) : dontStart(check)
  },
})

/** An order quoted with a firm compute booking, ready for the executor to follow. */
async function quoted(world: FixtureWorld) {
  const order = await world.pullOrder()
  const listing = await world.offers(order)
  const firm = listing.offers.find((o) => o.id === 'h100-firm')
  if (!firm) throw new Error('the demo lists a firm offer')
  const booked = await world.book(firm, 1)
  if (!booked.ok) throw new Error(booked.code)
  const sent = await world.quote(order, { ...booked.booking, id: 'b1' })
  if (!sent.ok) throw new Error(sent.code)
  return { run: 1, order, quote: sent.quote }
}

/** An executor over a world, recording its events and each verdict it was given. */
function executorOver(world: JobWorld, decide?: () => Verdict) {
  const events: SessionEvent[] = []
  const verdicts: Verdict[] = []
  const executor = new JobExecutor({
    world,
    emit: (e) => events.push(e),
    checkBeforeWork: async (job) => {
      const chain = await world.chainFor(job)
      if (chain.kind !== 'snapshot') throw new Error('the fixture world hands over a snapshot')
      const verdict =
        decide?.() ??
        (await service.checkBeforeWork(
          job,
          serviceChecks(snapshotChain(chain.snapshot), world.now),
        ))
      verdicts.push(verdict)
      return verdict
    },
    note: () => {},
    pollMs: 1000,
    workMs: 5000,
  })
  return { executor, events, verdicts }
}

const count = (events: SessionEvent[], type: SessionEvent['type']) =>
  events.filter((e) => e.type === type).length

/** The world, with the customer's order states given in the order scripted, then as it says. */
function withStates(world: FixtureWorld, shape: (real: OrderState, read: number) => OrderState) {
  let read = 0
  return { ...world, orderState: async (id: string) => shape(await world.orderState(id), read++) }
}

describe('the executor', () => {
  it('starts work once, after the verdict and the acceptance, and never before', async () => {
    const world = fixtureWorld()
    const { executor, events } = executorOver(world)
    expect(await executor.follow(await quoted(world))).toEqual({ kind: 'paid' })
    const order = events.map((e) => e.type)
    const fact = events.findIndex((e) => e.type === 'fact' && e.verifiedBy === 'service')
    expect(fact).toBeLessThan(order.indexOf('job_commitment_checked'))
    expect(order.indexOf('job_commitment_checked')).toBeLessThan(order.indexOf('job_work_started'))
    expect(count(events, 'job_work_started')).toBe(1)
    expect(world.acceptances).toHaveLength(1)
  })

  it('accepts nothing and starts nothing on a verdict not to start', async () => {
    const world = fixtureWorld()
    const { executor, events } = executorOver(world, () =>
      dontStart({ code: 'chain.reserve_mismatch' }),
    )
    expect(await executor.follow(await quoted(world))).toEqual({
      kind: 'not_started',
      code: 'chain.reserve_mismatch',
      layer: 'service',
    })
    expect(world.acceptances).toEqual([])
    expect(count(events, 'job_commitment_checked')).toBe(0)
    expect(count(events, 'job_work_started')).toBe(0)
    expect(events.find((e) => e.type === 'job_commitment_refused')).toMatchObject({
      code: 'chain.reserve_mismatch',
      layer: 'service',
    })
  })

  it('retries an acceptance whose outcome was unknown, and takes the one that landed', async () => {
    const world = fixtureWorld()
    world.failAcceptances(1)
    const { executor, events } = executorOver(world)
    expect(await executor.follow(await quoted(world))).toEqual({ kind: 'paid' })
    // The first send landed, so the second call finds it on the lock and sends nothing more.
    expect(world.acceptances).toHaveLength(1)
    const checked = events.find((e) => e.type === 'job_commitment_checked')
    expect(checked).toMatchObject({ acceptedIn: { transactionHash: world.acceptances[0] } })
    expect(count(events, 'job_work_started')).toBe(1)
  })

  it('posts each statement once and moves on once, through repeated states and states out of order', async () => {
    const world = fixtureWorld()
    // Every state comes twice, and a state from before the reserve comes back after it.
    let last: OrderState | null = null
    const stuttering = withStates(world, (real, read) => {
      const shown = read % 2 === 1 && last ? last : real
      last = real
      return read === 5 ? { ...real, status: 'verifying' } : shown
    })
    const { executor, events, verdicts } = executorOver(stuttering)
    expect(await executor.follow(await quoted(world))).toEqual({ kind: 'paid' })
    const said = events.filter((e) => e.type === 'said')
    expect(
      new Set(
        said.map((e) => e.type === 'said' && e.speaker.kind === 'customer' && e.speaker.index),
      ).size,
    ).toBe(said.length)
    expect(count(events, 'job_customer_verified')).toBe(1)
    expect(count(events, 'job_commitment_checked')).toBe(1)
    expect(verdicts).toHaveLength(1)
    expect(world.acceptances).toHaveLength(1)
  })

  it('never takes a customer saying the job is accepted or paid as leave to start work', async () => {
    const world = fixtureWorld()
    // The customer's order claims it's paid as soon as the reserve exists.
    const claiming = withStates(world, (real) =>
      real.status === 'reserved' ? { ...real, status: 'paid', payment: paymentOf(real) } : real,
    )
    const { executor, events } = executorOver(claiming, () =>
      dontStart({ code: 'chain.reserve_mismatch' }),
    )
    expect((await executor.follow(await quoted(world))).kind).toBe('not_started')
    expect(count(events, 'job_work_started')).toBe(0)
    expect(world.acceptances).toEqual([])
  })

  it('follows an order once, however often it is asked', async () => {
    const world = fixtureWorld()
    const { executor, verdicts } = executorOver(world)
    const job = await quoted(world)
    const [a, b] = await Promise.all([executor.follow(job), executor.follow(job)])
    expect(a).toEqual(b)
    expect(verdicts).toHaveLength(1)
    expect(world.acceptances).toHaveLength(1)
  })

  describe('a customer that cancels after work starts', () => {
    /** Follows an order the customer cancels late, in a world that treats the charge one way. */
    async function cancelled(charge?: 'pays' | 'contested' | 'referred' | 'unanswered') {
      const world = fixtureWorld(charge ? { charge } : {})
      const { executor, events } = executorOver(world)
      const order = await world.pullOrder('cancels_late')
      const listing = await world.offers(order)
      const firm = listing.offers.find((o) => o.id === 'h100-firm')
      if (!firm) throw new Error('the demo lists a firm offer')
      const booked = await world.book(firm, 1)
      if (!booked.ok) throw new Error(booked.code)
      const sent = await world.quote(order, { ...booked.booking, id: 'b1' })
      if (!sent.ok) throw new Error(sent.code)
      const outcome = await executor.follow({
        run: 1,
        order,
        quote: sent.quote,
        scenario: 'cancels_late',
      })
      return { world, executor, events, order, outcome }
    }
    const charges = (events: SessionEvent[]) =>
      events.map((e) => e.type).filter((t) => t.startsWith('job_charge') || t.includes('cancel'))

    it('stops the work, reports the charge and ends once Avow confirmed it, with nothing paid yet', async () => {
      const { world, events, order, outcome } = await cancelled()
      expect(outcome).toMatchObject({
        kind: 'cancelled',
        charge: { amount: 10_000_000n, standing: { state: 'confirmed' } },
      })
      expect(charges(events)).toEqual([
        'job_customer_cancelled',
        'job_charge_reported',
        'job_charge_confirmed',
      ])
      expect(count(events, 'job_delivered')).toBe(0)
      // The charge is open to a contest for the whole window the job's terms set.
      const confirmed = events.find((e) => e.type === 'job_charge_confirmed')
      if (confirmed?.type !== 'job_charge_confirmed') throw new Error('the charge was confirmed')
      expect(confirmed.contestableUntil - world.now()).toBeGreaterThan(
        order.terms.resolution.contestWindow - 30n,
      )
    })

    it('pays the charge once its contest window closes with no contest, and not before', async () => {
      const { world, executor, events } = await cancelled('pays')
      const confirmed = events.find((e) => e.type === 'job_charge_confirmed')
      if (confirmed?.type !== 'job_charge_confirmed') throw new Error('the charge was confirmed')
      await executor.charges()
      expect(charges(events).at(-1)).toBe('job_charge_paid')
      expect(count(events, 'job_charge_paid')).toBe(1)
      expect(world.now()).toBeGreaterThanOrEqual(confirmed.contestableUntil)
    })

    it('pauses a confirmed charge the customer contests, and pays nothing', async () => {
      const { executor, events } = await cancelled('contested')
      await executor.charges()
      expect(charges(events)).toEqual([
        'job_customer_cancelled',
        'job_charge_reported',
        'job_charge_confirmed',
        'job_charge_paused',
      ])
      expect(events.at(-1)).toMatchObject({ type: 'job_charge_paused', cause: 'contested' })
    })

    it("refers a report Avow's records don't support, with no confirmation", async () => {
      const { events, outcome } = await cancelled('referred')
      expect(outcome).toMatchObject({
        kind: 'cancelled',
        charge: { standing: { state: 'paused', cause: 'referred' } },
      })
      expect(count(events, 'job_charge_confirmed')).toBe(0)
      expect(count(events, 'job_charge_paid')).toBe(0)
    })

    it('escalates a report Avow never answers to a ruling at its deadline', async () => {
      const { world, events, outcome } = await cancelled('unanswered')
      expect(outcome).toMatchObject({
        kind: 'cancelled',
        charge: { standing: { state: 'paused', cause: 'unanswered' } },
      })
      const reported = events.findIndex((e) => e.type === 'job_charge_reported')
      expect(reported).toBeGreaterThan(-1)
      expect(count(events, 'job_charge_confirmed')).toBe(0)
      // The pause comes no sooner than Avow's deadline to answer.
      expect(world.now()).toBeGreaterThanOrEqual(1_800_000_000n + 600n)
    })

    it('waits before it reports, since a report filed at once is referred', async () => {
      const { world, events } = await cancelled()
      const at = (type: SessionEvent['type']) => events.findIndex((e) => e.type === type)
      const said = events[at('job_customer_cancelled')]
      if (said?.type !== 'job_customer_cancelled') throw new Error('the customer cancelled')
      // The executor waited, so the report sits well after the cancellation and Avow confirmed it.
      expect(world.now() - said.cancelledAt).toBeGreaterThanOrEqual(45n)
      expect(at('job_charge_confirmed')).toBeGreaterThan(at('job_charge_reported'))

      // The same cancellation reported at once is referred, since the two clocks could disagree.
      const hasty = fixtureWorld()
      const order = await hasty.pullOrder('cancels_late')
      const firm = (await hasty.offers(order)).offers.find((o) => o.id === 'h100-firm')
      if (!firm) throw new Error('the demo lists a firm offer')
      const booked = await hasty.book(firm, 1)
      if (!booked.ok) throw new Error(booked.code)
      const sent = await hasty.quote(order, { ...booked.booking, id: 'b1' })
      if (!sent.ok) throw new Error(sent.code)
      // The customer verifies and reserves on its second read, and the business accepts.
      await hasty.orderState(order.orderId)
      await hasty.orderState(order.orderId)
      expect((await hasty.accept(order, sent.quote)).ok).toBe(true)
      let state = await hasty.orderState(order.orderId)
      while (state.status !== 'cancelled') {
        await hasty.sleep(5000)
        state = await hasty.orderState(order.orderId)
      }
      const report = await hasty.reportCharge(order, 'lateCancellation')
      if (!report.ok) throw new Error(report.code)
      await hasty.sleep(10_000)
      expect(await hasty.charge(order, report)).toEqual({ state: 'paused', cause: 'referred' })
    })

    it('stops following a charge when the session ends', async () => {
      const { world, executor, events } = await cancelled('pays')
      const before = world.now()
      executor.stop()
      await executor.charges()
      expect(count(events, 'job_charge_paid')).toBe(0)
      expect(world.now() - before).toBeLessThan(10n)
    })

    it('files no second report and no report on a job nobody cancelled', async () => {
      const { world, order } = await cancelled()
      expect(await world.reportCharge(order, 'lateCancellation')).toMatchObject({
        ok: false,
        code: 'report.not_reportable',
      })
      const plain = fixtureWorld()
      const fresh = await plain.pullOrder()
      expect(await plain.reportCharge(fresh, 'lateCancellation')).toMatchObject({
        ok: false,
        code: 'chain.reserve_missing',
      })
    })
  })
})

/** A payment the order claims, for a customer that says it paid before anything was delivered. */
function paymentOf(state: OrderState) {
  return {
    kind: 'payment' as const,
    chainId: 42431,
    transactionHash: `0x${'99'.repeat(32)}` as const,
    logIndex: 0,
    token: '0x20c0000000000000000000000000000000000001' as const,
    from: '0x00000000000000000000000000000000000c0571' as const,
    to: '0x000000000000000000000000000000000000beef' as const,
    amount: 40_000_000n,
    memo: state.commitmentId,
  }
}
