import type { SessionEvent } from '@avow-finance/spec'
import { describe, expect, it } from 'vitest'
import { type FixtureWorld, fixtureWorld } from './fixture-world.js'
import { scriptedProvider } from './scripted.js'
import { defineService, dontStart, type ServicePolicy, start } from './service.js'
import { serviceChecks, snapshotChain } from './service-check.js'
import { runSession, type SessionView } from './session.js'

/** The template's service: a $3 budget, the compute switch as given, and the three-line check. */
function service(bookCompute = true) {
  return defineService({
    computeBudgetPerGpuHour: 3,
    bookCompute,
    async checkBeforeWork(job, avow) {
      const check = await avow.verifyCommitment(job)
      return check.ok ? start(check) : dontStart(check)
    },
  })
}

/** A view that keeps what it was asked to draw. */
function recordingView() {
  const lines: string[] = []
  const view: SessionView = {
    intro: (l) => lines.push(...l),
    event: () => {},
    speak: () => ({ write: () => {}, end: () => {} }),
    quiet: (l) => lines.push(l),
    fail: (l) => lines.push(`failed: ${l}`),
    evidence: (t) => lines.push(t.title),
  }
  return { lines, view }
}

/** A session against the fixture world, with the service's check run in this process. */
function session(world: FixtureWorld, policy: () => ServicePolicy, svc = service()) {
  const events: SessionEvent[] = []
  const { lines, view } = recordingView()
  let run = 0
  return {
    events,
    lines,
    run: () =>
      runSession({
        world,
        provider: scriptedProvider(),
        readPolicy: async () => policy(),
        checkBeforeWork: async (job) => {
          const chain = await world.chainFor(job)
          if (chain.kind !== 'snapshot') throw new Error('the fixture world hands over a snapshot')
          return svc.checkBeforeWork(job, serviceChecks(snapshotChain(chain.snapshot), world.now))
        },
        emit: (e) => events.push(e),
        view,
        input: null,
        nextRun: () => ++run,
        pollMs: 1000,
        workMs: 5000,
      }),
  }
}

const types = (events: SessionEvent[]) => events.map((e) => e.type)

describe('the first job, scripted against the fixture world', () => {
  it('books firm compute, quotes it, and starts work only after service.ts verified the commitment', async () => {
    const world = fixtureWorld()
    const s = session(world, () => service().policy)
    const result = await s.run()
    expect(result).toMatchObject({ firstJob: { kind: 'paid' }, stopped: null })
    const seen = types(s.events)
    const at = (type: SessionEvent['type']) => seen.indexOf(type)
    for (const type of [
      'job_order_received',
      'job_compute_secured',
      'job_quote_sent',
      'job_customer_verifying',
      'job_customer_verified',
      'job_commitment_checked',
      'job_work_started',
      'job_delivered',
      'job_paid',
    ] as const) {
      expect(at(type), type).toBeGreaterThanOrEqual(0)
    }
    expect(at('job_compute_secured')).toBeLessThan(at('job_quote_sent'))
    expect(at('job_customer_verified')).toBeLessThan(at('job_commitment_checked'))
    expect(at('job_commitment_checked')).toBeLessThan(at('job_work_started'))
    // The fact service.ts gives comes before the decisive event, with its block and reference.
    const serviceFact = s.events.findIndex((e) => e.type === 'fact' && e.verifiedBy === 'service')
    expect(serviceFact).toBeGreaterThanOrEqual(0)
    expect(serviceFact).toBeLessThan(at('job_commitment_checked'))
    // It compared the four offers and booked the firm one.
    const booked = s.events.find((e) => e.type === 'tool_call' && e.tool === 'book_compute')
    expect(booked).toMatchObject({ offer: 'h100-firm', quantity: 1 })
    const listing = s.events.find((e) => e.type === 'tool_result' && e.tool === 'compute_offers')
    expect(listing?.type === 'tool_result' && listing.listing?.offers).toHaveLength(4)
    // Every line of speech names the scripted decisions as its speaker.
    for (const e of s.events) {
      if (e.type === 'said' && e.speaker.kind === 'model') expect(e.speaker.model).toBe('scripted')
    }
  })

  it('starts no work and accepts nothing when service.ts says not to', async () => {
    const world = fixtureWorld()
    const refusing = defineService({
      computeBudgetPerGpuHour: 3,
      bookCompute: true,
      checkBeforeWork: async () => dontStart({ code: 'chain.reserve_mismatch' }),
    })
    const s = session(world, () => refusing.policy, refusing)
    const result = await s.run()
    expect(result.firstJob).toEqual({
      kind: 'not_started',
      code: 'chain.reserve_mismatch',
      layer: 'service',
    })
    expect(types(s.events)).toContain('job_commitment_refused')
    expect(types(s.events)).not.toContain('job_commitment_checked')
    expect(types(s.events)).not.toContain('job_work_started')
    expect(world.acceptances).toEqual([])
  })

  it('quotes without a booking while the compute switch is off, and the customer refuses it', async () => {
    const world = fixtureWorld()
    const off = service(false)
    const s = session(world, () => off.policy, off)
    const result = await s.run()
    expect(result.firstJob).toMatchObject({
      kind: 'refused',
      refusal: { code: 'dependency.required', layer: 'customer' },
    })
    expect(types(s.events)).not.toContain('job_compute_secured')
    const quote = s.events.find((e) => e.type === 'job_quote_sent')
    expect(quote).toMatchObject({ compute: null })
    // Once the customer has answered, the agent explains the refusal and sends no second quote.
    const quotes = s.events.filter((e) => e.type === 'tool_call' && e.tool === 'submit_quote')
    expect(quotes).toHaveLength(1)
    expect(s.events.some((e) => e.type === 'tool_result' && e.ok === false)).toBe(false)
  })
})

describe('what the developer types', () => {
  it("goes on when the customer won't offer a job it cancels, and takes the next plain order", async () => {
    const real = fixtureWorld()
    // A customer whose agent has no authority to cancel refuses the scenario and offers plain jobs.
    const world: FixtureWorld = {
      ...real,
      pullOrder: async (scenario) => {
        if (scenario) throw new Error("The test customer's agent has no authority to cancel")
        return real.pullOrder()
      },
    }
    const events: SessionEvent[] = []
    const { lines, view } = recordingView()
    const svc = service()
    const typed = ['job cancels', 'job']
    const ended: unknown[] = []
    const whys: string[] = []
    let run = 0
    const result = await runSession({
      world,
      provider: scriptedProvider(),
      readPolicy: async () => svc.policy,
      checkBeforeWork: async (job) => {
        const chain = await world.chainFor(job)
        if (chain.kind !== 'snapshot') throw new Error('the fixture world hands over a snapshot')
        return svc.checkBeforeWork(job, serviceChecks(snapshotChain(chain.snapshot), world.now))
      },
      emit: (e) => events.push(e),
      view,
      input: { inFlight: () => {}, next: async () => typed.shift() ?? null },
      afterJob: (outcome) => {
        ended.push(outcome?.kind)
        if (outcome?.kind === 'stopped') whys.push(outcome.why)
      },
      nextRun: () => ++run,
      pollMs: 1000,
      workMs: 5000,
    })
    expect(result.stopped).toBeNull()
    expect(ended).toEqual(['paid', 'stopped', 'paid'])
    expect(whys).toEqual([
      "Avow's test customer didn't offer a job it cancels. The test customer's agent has no authority to cancel",
    ])
    // The guide that asked says how the job ended, so the session doesn't say it twice.
    expect(lines.join('\n')).not.toContain("didn't offer a job it cancels")
    expect(types(events).filter((t) => t === 'job_order_received')).toHaveLength(2)
  })

  it('takes the next order only on the job command, and sends everything else to the agent', async () => {
    const { JOB_COMMAND, scenarioOf } = await import('./session.js')
    for (const line of ['job', '/job', 'JOB', 'job cancels']) {
      expect(JOB_COMMAND.test(line), line).toBe(true)
    }
    const others = ["Don't quote yet", 'what does a quote mean?', 'take the next job', 'job late']
    for (const line of others) expect(JOB_COMMAND.test(line), line).toBe(false)
    // Only `job cancels` asks the customer to cancel, and a plain job runs to payment.
    expect(scenarioOf('job cancels')).toBe('cancels_late')
    expect(scenarioOf(' /JOB  cancels ')).toBe('cancels_late')
    expect(scenarioOf('job')).toBeNull()
  })
})
