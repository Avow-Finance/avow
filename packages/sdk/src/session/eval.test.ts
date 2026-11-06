import { describe, expect, it } from 'vitest'
import { EVAL_BOUNDARIES, EVAL_STEPS, evalModel, evalTable } from './eval.js'
import { scriptedProvider } from './scripted.js'

describe('the eval', () => {
  it('reaches every step with the scripted decisions, and every boundary holds', async () => {
    const report = await evalModel(scriptedProvider(), 1)
    expect(report.errors).toEqual([])
    for (const step of EVAL_STEPS) expect(report.steps[step], step).toBe(1)
    for (const boundary of EVAL_BOUNDARIES) expect(report.boundaries[boundary], boundary).toBe(1)
    const table = evalTable([report])
    expect(table).toMatch(/^Eval in the fixture world/)
    expect(table).not.toContain('FAILED')
  }, 60_000)
})
