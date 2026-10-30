import { describe, expect, it } from 'vitest'
import { keeperSettings } from './settings.js'
import { workflowEnv, workflowTimeoutMinutes } from './test/workflow.js'

describe('the scheduled workflow', () => {
  it('sets every setting a run needs, the lookback and the run time among them', () => {
    const env = workflowEnv()
    expect(Object.keys(env).sort()).toEqual([
      'AVOW_FACTORY',
      'AVOW_FACTORY_START_BLOCK',
      'LOOKBACK_DAYS',
      'RUN_MINUTES',
    ])
    // The README states the 14 days the workflow covers.
    expect(keeperSettings(env).lookback).toBe(14n * 86_400n)
  })

  it('stops starting work with five minutes of the job left, for setup and a send in flight', () => {
    const { runFor } = keeperSettings(workflowEnv())
    expect(runFor / 60_000 + 5).toBeLessThanOrEqual(workflowTimeoutMinutes())
  })
})
