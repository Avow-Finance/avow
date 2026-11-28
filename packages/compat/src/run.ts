import type { ChatModel, Usage } from './chat.js'
import { converse, type Toolbox } from './conversation.js'
import {
  type Criterion,
  ensureCommitment,
  readFacts,
  SCENARIO_SET,
  SCENARIOS,
  type Scenario,
} from './scenarios.js'

export interface ScenarioResult {
  id: string
  title: string
  /** Every criterion passed and the conversation ended on the model's own answer. */
  passed: boolean
  criteria: Criterion[]
  /** Why the scenario stopped short, from the endpoint, the step limit or the world. */
  error: string | null
  /** The tools the model called, in order, for reading a failure. */
  calls: string[]
}

export interface ModelReport {
  model: string
  /** The models the endpoint says answered, with their versions. */
  served: string[]
  /** The day the run started, in UTC, since results hold only for that model version then. */
  date: string
  scenarioSet: number
  scenarios: ScenarioResult[]
  usage: Usage
}

/** The most model calls one scenario may take before it counts as stuck. */
export const MAX_CALLS = 12

/**
 * Runs every scenario against one model, each in a fresh conversation over the same world, so a
 * scenario that needs a commitment starts from one even when the model failed to make it earlier.
 */
export async function runModel(o: {
  model: ChatModel
  toolbox: Toolbox
  system: string
  scenarios?: readonly Scenario[]
  now?: () => Date
}): Promise<ModelReport> {
  const scenarios = o.scenarios ?? SCENARIOS
  const report: ModelReport = {
    model: o.model.id,
    served: [],
    date: (o.now ?? (() => new Date()))().toISOString().slice(0, 10),
    scenarioSet: SCENARIO_SET,
    scenarios: [],
    usage: { promptTokens: 0, completionTokens: 0, cost: 0 },
  }
  for (const s of scenarios) {
    let facts: Awaited<ReturnType<typeof readFacts>>
    try {
      facts = await readFacts(o.toolbox)
      if (s.needsCommitment) facts = await ensureCommitment(o.toolbox, facts)
    } catch (error) {
      report.scenarios.push(failed(s, `setup: ${message(error)}`))
      continue
    }
    const t = await converse({
      model: o.model,
      toolbox: o.toolbox,
      system: o.system,
      asks: s.asks(facts),
      maxCalls: MAX_CALLS,
    })
    for (const m of t.served) if (!report.served.includes(m)) report.served.push(m)
    report.usage.promptTokens += t.usage.promptTokens
    report.usage.completionTokens += t.usage.completionTokens
    report.usage.cost =
      report.usage.cost === null || t.usage.cost === null ? null : report.usage.cost + t.usage.cost
    const criteria = s.grade(t, facts)
    report.scenarios.push({
      id: s.id,
      title: s.title,
      passed: t.stopped === null && criteria.every((c) => c.passed),
      criteria,
      error: t.stopped,
      calls: t.steps.map((step) => step.name),
    })
  }
  return report
}

const failed = (s: Scenario, error: string): ScenarioResult => ({
  id: s.id,
  title: s.title,
  passed: false,
  criteria: [],
  error,
  calls: [],
})

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
