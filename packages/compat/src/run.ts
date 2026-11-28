import type { ChatModel, Usage } from './chat.js'
import { converse, type Toolbox } from './conversation.js'
import {
  type Criterion,
  ensureCommitment,
  type Facts,
  readFacts,
  SCENARIO_SET,
  SCENARIOS,
  type Scenario,
} from './scenarios.js'

/** One run of one scenario. */
export interface Trial {
  /** Every criterion passed and the conversation ended on the model's own answer. */
  passed: boolean
  criteria: Criterion[]
  /** Why the trial stopped short, or couldn't start, from the endpoint, the call limit or the world. */
  error: string | null
  /** The tools the model called, in order, for reading a failure. */
  calls: string[]
}

export interface ScenarioResult {
  id: string
  title: string
  trials: Trial[]
}

export interface ModelReport {
  model: string
  /** The models the endpoint says answered, with their versions. */
  served: string[]
  /** The day the run started, in UTC, since results hold only for that model version then. */
  date: string
  scenarioSet: number
  /** How many times each scenario ran. */
  trials: number
  scenarios: ScenarioResult[]
  usage: Usage
  /** Why the model's run couldn't go on, such as its test business not being made. */
  error: string | null
}

/** The most model calls one trial may take before it counts as stuck. */
export const MAX_CALLS = 12
/** How many times each scenario runs, since a model can answer the same ask differently. */
export const DEFAULT_TRIALS = 3

/**
 * Runs every scenario against one model, each trial in a fresh conversation over the same world.
 * Every trial of a scenario runs before the next scenario, and the refusal scenarios run last, so
 * a booking a model shouldn't have made shrinks only the room the scenarios after it size their
 * asks from.
 */
export async function runModel(o: {
  model: ChatModel
  toolbox: Toolbox
  system: string
  trials?: number
  scenarios?: readonly Scenario[]
  now?: () => Date
}): Promise<ModelReport> {
  const trials = o.trials ?? DEFAULT_TRIALS
  const report = emptyReport(o.model.id, trials, o.now)
  for (const s of o.scenarios ?? SCENARIOS) {
    const result: ScenarioResult = { id: s.id, title: s.title, trials: [] }
    report.scenarios.push(result)
    for (let i = 0; i < trials; i++) result.trials.push(await trial(o, s, report))
  }
  return report
}

async function trial(
  o: { model: ChatModel; toolbox: Toolbox; system: string },
  s: Scenario,
  report: ModelReport,
): Promise<Trial> {
  let facts: Facts
  try {
    facts = await readFacts(o.toolbox)
    if (s.needsCommitment) facts = await ensureCommitment(o.toolbox, facts)
  } catch (error) {
    return unstarted(`setup: ${message(error)}`)
  }
  if (facts.canCommitNow < s.room) {
    return unstarted(
      `the agent can commit $${facts.canCommitNow}, and the scenario needs $${s.room}`,
    )
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
  return {
    passed: t.stopped === null && criteria.every((c) => c.passed),
    criteria,
    error: t.stopped,
    calls: t.steps.map((step) => step.name),
  }
}

/** A report for a model before anything ran, which is also its row when nothing could. */
export function emptyReport(model: string, trials: number, now = () => new Date()): ModelReport {
  return {
    model,
    served: [],
    date: now().toISOString().slice(0, 10),
    scenarioSet: SCENARIO_SET,
    trials,
    scenarios: [],
    usage: { promptTokens: 0, completionTokens: 0, cost: 0 },
    error: null,
  }
}

const unstarted = (error: string): Trial => ({ passed: false, criteria: [], error, calls: [] })

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
