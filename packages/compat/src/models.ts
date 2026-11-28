import { rmSync } from 'node:fs'
import type { ChatModel } from './chat.js'
import type { Toolbox } from './conversation.js'
import { emptyReport, type ModelReport, runModel } from './run.js'

/** What a run of several models needs, which the command fills with the real world and endpoint. */
export interface ModelRunDeps {
  trials: number
  /** Makes a test business in a fresh folder, and answers with the folder. */
  prepare(): Promise<string>
  /** Starts the MCP server for the folder's agent. */
  open(dir: string): Promise<Toolbox & { close(): Promise<void> }>
  model(id: string): ChatModel
  /** The system prompt, from what the server tells every client. */
  system(instructions: string): string
  /** Keeps the reports so far, called after each model, so a run cut short keeps what it finished. */
  save(reports: readonly ModelReport[]): void
  progress(line: string): void
}

/** Runs each model in turn, saving every report so far once each model's run ends. */
export async function runModels(
  ids: readonly string[],
  deps: ModelRunDeps,
): Promise<ModelReport[]> {
  const reports: ModelReport[] = []
  for (const id of ids) {
    deps.progress(`\n${id}: making a test business on Moderato`)
    const report = await runOne(id, deps)
    for (const s of report.scenarios) {
      deps.progress(`  ${s.id}: ${s.trials.filter((t) => t.passed).length} of ${s.trials.length}`)
    }
    reports.push(report)
    deps.save(reports)
  }
  return reports
}

/**
 * One model's run, in a test business of its own. Anything that stops it becomes the model's row,
 * so the models after it still run, and the business's folder, with its keys, goes once the run
 * ends however it ended.
 */
export async function runOne(id: string, deps: ModelRunDeps): Promise<ModelReport> {
  let dir: string | null = null
  let toolbox: (Toolbox & { close(): Promise<void> }) | null = null
  try {
    dir = await deps.prepare()
    toolbox = await deps.open(dir)
    return await runModel({
      model: deps.model(id),
      toolbox,
      system: deps.system(toolbox.instructions),
      trials: deps.trials,
    })
  } catch (error) {
    return {
      ...emptyReport(id, deps.trials),
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    await toolbox?.close().catch(() => {})
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
}
