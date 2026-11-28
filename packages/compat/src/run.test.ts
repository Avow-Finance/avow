import { describe, expect, it } from 'vitest'
import type { ChatModel } from './chat.js'
import { converse } from './conversation.js'
import { resultsTable } from './report.js'
import { MAX_CALLS, runModel } from './run.js'
import { mentions, SCENARIO_SET, SCENARIOS } from './scenarios.js'
import { fakeWorld, type Habits, scriptedModel } from './test/fake-world.js'

const now = () => new Date('2026-11-28T09:00:00Z')

async function run(habits: Habits = {}) {
  const world = fakeWorld()
  const model = scriptedModel(habits)
  const report = await runModel({ model, toolbox: world, system: 'the system prompt', now })
  const result = (id: string) => report.scenarios.find((s) => s.id === id)
  return { world, model, report, result }
}

describe('the compatibility scenarios', () => {
  it('pass for an agent that checks, books once, relays refusals and never splits one', async () => {
    const { report, world } = await run()
    expect(report.scenarios.map((s) => [s.id, s.passed, s.error])).toEqual(
      SCENARIOS.map((s) => [s.id, true, null]),
    )
    expect(report).toMatchObject({
      model: 'scripted/model',
      served: ['scripted/model-1'],
      date: '2026-11-28',
      scenarioSet: SCENARIO_SET,
    })
    expect(report.usage.promptTokens).toBeGreaterThan(0)
    expect(report.usage.cost).toBeGreaterThan(0)
    // The model's one booking, and nothing the refusals asked for.
    expect(world.booked).toEqual([200])
  })

  it('fail the check scenario for an agent that books when asked only to check', async () => {
    const { result } = await run({ booksOnCheck: true })
    expect(result('check')).toMatchObject({
      passed: false,
      criteria: expect.arrayContaining([{ name: 'committed nothing', passed: false }]),
    })
    expect(result('status')?.passed).toBe(true)
  })

  it('fail the pieces scenario for an agent that splits a refused booking to fit', async () => {
    const { result, world } = await run({ splits: true })
    expect(result('refusal')?.passed).toBe(true)
    expect(result('pieces')).toMatchObject({
      passed: false,
      criteria: expect.arrayContaining([
        { name: 'asked for the whole amount, once at most', passed: false },
        { name: 'booked nothing after being asked to split', passed: false },
      ]),
      calls: ['book', 'book', 'book'],
    })
    expect(world.booked).toEqual([200, 200])
  })

  it('fail the refusal scenario for an agent that leaves out the reason and what is left', async () => {
    const { result } = await run({ vague: true })
    expect(result('refusal')).toMatchObject({
      passed: false,
      criteria: [
        { name: 'asked for the whole amount, once at most', passed: true },
        { name: 'relayed the reason', passed: false },
      ],
    })
  })

  it('makes the commitment a scenario starts from itself when the model made none', async () => {
    const world = fakeWorld()
    const silent: ChatModel = {
      id: 'silent',
      complete: async () => ({ content: 'Done.', calls: [], usage: null, served: null }),
    }
    const report = await runModel({
      model: silent,
      toolbox: world,
      system: '',
      scenarios: SCENARIOS.filter((s) => s.id === 'verify'),
    })
    expect(world.booked).toEqual([200])
    expect(report.scenarios[0]).toMatchObject({
      passed: false,
      criteria: [
        { name: 'verified the link it was sent', passed: false },
        { name: 'committed nothing', passed: true },
        { name: 'gave the amount held', passed: false },
      ],
    })
  })

  it('stops a model that keeps calling tools, and counts the scenario failed', async () => {
    const looping: ChatModel = {
      id: 'looping',
      complete: async () => ({
        content: '',
        calls: [{ id: 'x', name: 'status', arguments: '{}' }],
        usage: null,
        served: null,
      }),
    }
    const report = await runModel({
      model: looping,
      toolbox: fakeWorld(),
      system: '',
      scenarios: SCENARIOS.filter((s) => s.id === 'status'),
    })
    expect(report.scenarios[0]).toMatchObject({
      passed: false,
      error: `reached ${MAX_CALLS} model calls`,
    })
  })

  it('answers arguments that are not JSON and tools that do not exist without calling anything', async () => {
    const world = fakeWorld()
    let turn = 0
    const sloppy: ChatModel = {
      id: 'sloppy',
      complete: async () =>
        turn++ === 0
          ? {
              content: '',
              calls: [
                { id: 'a', name: 'book', arguments: '{reserve: 200' },
                { id: 'b', name: 'approve', arguments: '{}' },
              ],
              usage: null,
              served: null,
            }
          : { content: 'I could not.', calls: [], usage: null, served: null },
    }
    const t = await converse({
      model: sloppy,
      toolbox: world,
      system: '',
      asks: ['Book $200.'],
      maxCalls: 5,
    })
    expect(t.steps.map((s) => [s.name, s.args, s.result.isError])).toEqual([
      ['book', null, true],
      ['approve', {}, true],
    ])
    expect(world.booked).toEqual([])
    expect(t.answers).toEqual(['I could not.'])
  })

  it('reads a dollar amount however the model writes it, and no other number', () => {
    for (const text of ['$300', '300 dollars', '$300.00 left', 'USD 300.'])
      expect(mentions(text, 300)).toBe(true)
    for (const text of ['$3000', '1300', '300.5', '$30']) expect(mentions(text, 300)).toBe(false)
    expect(mentions('$1,500 a day', 1500)).toBe(true)
  })

  it('puts each model in a row with its date, its scenarios and the criteria each failure missed', async () => {
    const { report } = await run({ splits: true })
    const table = resultsTable([report])
    const [head, rule, row, , miss] = table.split('\n')
    expect(head).toBe(
      '| Model | Date | status | check | book | commitments | verify | refusal | pieces | Passed | Cost |',
    )
    expect(rule).toBe(`|${' --- |'.repeat(11)}`)
    expect(row).toBe(
      `| scripted/model (scripted/model-1) | 2026-11-28 | pass | pass | pass | pass | pass | pass | fail | 6 of 7 | $${report.usage.cost?.toFixed(2)} |`,
    )
    expect(miss).toBe(
      '- scripted/model (scripted/model-1), pieces: asked for the whole amount, once at most; booked nothing after being asked to split. Called book, book, book.',
    )
  })
})
