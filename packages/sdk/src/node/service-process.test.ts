import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { SessionEvent } from '@avow-finance/spec'
import { afterEach, describe, expect, it } from 'vitest'
import { JobExecutor } from '../session/executor.js'
import { type FixtureWorld, fixtureWorld } from '../session/fixture-world.js'
import { readServicePolicy, runCheckBeforeWork } from './service-process.js'

/** The SDK's built entry a developer's service.ts imports, as a URL a file anywhere can import. */
const ENTRY = pathToFileURL(resolve(import.meta.dirname, '../../dist/service-entry.js')).href

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  delete process.env.AVOW_TEST_SECRET
})

/** A folder holding a service file with the given check, as a developer would write one. */
function folder(check: string, policy = 'computeBudgetPerGpuHour: 2.4, bookCompute: false') {
  const dir = mkdtempSync(join(tmpdir(), 'avow-service-test-'))
  dirs.push(dir)
  writeFileSync(
    join(dir, 'service.mjs'),
    `import { defineService, dontStart, start } from '${ENTRY}'
export default defineService({
  ${policy},
  async checkBeforeWork(job, avow) {
    ${check}
  },
})
`,
  )
  return dir
}

/** An order quoted with a firm compute booking. */
async function quoted(world: FixtureWorld) {
  const order = await world.pullOrder()
  const firm = (await world.offers(order)).offers.find((o) => o.id === 'h100-firm')
  if (!firm) throw new Error('the demo lists a firm offer')
  const booked = await world.book(firm, 1)
  if (!booked.ok) throw new Error(booked.code)
  const sent = await world.quote(order, { ...booked.booking, id: 'b1' })
  if (!sent.ok) throw new Error(sent.code)
  return { run: 1, order, quote: sent.quote }
}

/** Follows a quoted job with the service's check running in its own process. */
async function follow(dir: string) {
  const world = fixtureWorld()
  const events: SessionEvent[] = []
  const notes: string[] = []
  const executor = new JobExecutor({
    world,
    emit: (e) => events.push(e),
    checkBeforeWork: async (job) =>
      runCheckBeforeWork('service.mjs', job, await world.chainFor(job), dir),
    note: (line) => notes.push(line),
    pollMs: 1000,
    workMs: 5000,
  })
  const outcome = await executor.follow(await quoted(world))
  return { outcome, events, notes, world }
}

describe("the developer's service process", () => {
  it('reads the budget and the compute switch', async () => {
    const dir = folder('return dontStart({ code: "message.invalid" })')
    expect(await readServicePolicy('service.mjs', dir)).toEqual({
      budgetPerGpuHour: 2_400_000n,
      computeSwitch: 'off',
    })
  })

  it('runs checkBeforeWork, which reads the chain it was handed, and work follows its start', async () => {
    const dir = folder(
      'const check = await avow.verifyCommitment(job)\n    return check.ok ? start(check) : dontStart(check)',
    )
    const { outcome, events } = await follow(dir)
    expect(outcome).toEqual({ kind: 'paid' })
    const fact = events.find((e) => e.type === 'fact' && e.verifiedBy === 'service')
    expect(fact).toMatchObject({ check: 'reserve', text: expect.stringContaining('$10 reserve') })
  })

  it('gets no key and no AVOW_ variable from the session', async () => {
    process.env.AVOW_TEST_SECRET = 'never in the child'
    const dir = folder(
      'const leaked = Object.keys(process.env).some((k) => k.startsWith("AVOW_"))\n    return leaked ? dontStart({ code: "message.invalid" }) : dontStart({ code: "chain.reserve_mismatch" })',
    )
    const { events } = await follow(dir)
    expect(events.find((e) => e.type === 'job_commitment_refused')).toMatchObject({
      code: 'chain.reserve_mismatch',
      layer: 'service',
    })
  })

  it('starts nothing when the check throws or answers something that is no verdict', async () => {
    for (const check of ['throw new Error("broken")', 'return { start: true }']) {
      const { outcome, events, notes, world } = await follow(folder(check))
      expect(outcome, check).toEqual({
        kind: 'not_started',
        code: 'service.check_failed',
        layer: 'service',
      })
      expect(world.acceptances).toEqual([])
      expect(events.some((e) => e.type === 'job_work_started')).toBe(false)
      expect(notes.join(' ')).toMatch(/nothing was accepted and no work started/)
    }
  })
})
