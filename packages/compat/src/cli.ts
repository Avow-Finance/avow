#!/usr/bin/env node
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { type CompatArgs, readArgs } from './args.js'
import { openAiCompatible } from './chat.js'
import { resultsTable } from './report.js'
import { emptyReport, type ModelReport, runModel } from './run.js'
import { mcpToolbox, prepareWorld, systemPrompt } from './world.js'

/**
 * Runs the scenarios against each model, on Moderato, through the MCP server.
 *
 *   pnpm compat -- --model anthropic/claude-sonnet-5.5,openai/gpt-5.4-mini
 *
 * The key comes from the environment variable `--key-env` names, OPENROUTER_API_KEY when left out,
 * and goes only to the endpoint. `--base-url` names another OpenAI-compatible endpoint, and `--out`
 * the folder for results.json and results.md, compat-results when left out, and `--trials` how many
 * times each scenario runs, 3 when left out. In GitHub Actions the
 * table goes to the job summary too. A model failing scenarios is a result, so the run exits 0 once
 * every model ran.
 */
async function main(argv: string[]): Promise<number> {
  const args = readArgs(argv)
  if ('error' in args) {
    console.error(args.error)
    return 1
  }
  const apiKey = process.env[args.keyEnv]
  if (!apiKey) {
    console.error(
      `Set ${args.keyEnv} to the endpoint's API key. The check reads it from there only.`,
    )
    return 1
  }
  const out = resolve(args.out)
  mkdirSync(out, { recursive: true })
  const reports: ModelReport[] = []
  for (const id of args.models) {
    console.log(`\n${id}: making a test business on Moderato`)
    reports.push(await runOne(id, args, apiKey))
    for (const s of reports.at(-1)?.scenarios ?? []) {
      console.log(`  ${s.id}: ${s.trials.filter((t) => t.passed).length} of ${s.trials.length}`)
    }
    // Written after each model, so a run cut short keeps what it finished.
    writeFileSync(join(out, 'results.json'), `${JSON.stringify(reports, null, 2)}\n`)
    writeFileSync(join(out, 'results.md'), `${resultsTable(reports)}\n`)
  }
  const table = resultsTable(reports)
  console.log(`\n${table}`)
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n\n`)
  return 0
}

/**
 * One model's run, in a test business of its own. Anything that stops it becomes the model's row,
 * so the models after it still run, and the business's folder goes once the run ends.
 */
async function runOne(id: string, args: CompatArgs, apiKey: string): Promise<ModelReport> {
  let dir: string | null = null
  let toolbox: Awaited<ReturnType<typeof mcpToolbox>> | null = null
  try {
    dir = await prepareWorld(() => {})
    toolbox = await mcpToolbox(dir, [args.keyEnv])
    return await runModel({
      model: openAiCompatible({ baseUrl: args.baseUrl, apiKey, model: id }),
      toolbox,
      system: systemPrompt(toolbox.instructions),
      trials: args.trials,
    })
  } catch (error) {
    return {
      ...emptyReport(id, args.trials),
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    await toolbox?.close().catch(() => {})
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
}

// pnpm passes on the `--` that npm drops.
main(process.argv.slice(2).filter((arg, i) => !(i === 0 && arg === '--'))).then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  },
)
