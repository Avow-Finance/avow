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
