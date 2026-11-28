#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { readArgs } from './args.js'
import { openAiCompatible } from './chat.js'
import { runModels } from './models.js'
import { resultsTable } from './report.js'
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
  const reports = await runModels(args.models, {
    trials: args.trials,
    prepare: () => prepareWorld(() => {}),
    open: (dir) => mcpToolbox(dir, [args.keyEnv]),
    model: (id) => openAiCompatible({ baseUrl: args.baseUrl, apiKey, model: id }),
    system: systemPrompt,
    save: (so) => {
      writeFileSync(join(out, 'results.json'), `${JSON.stringify(so, null, 2)}\n`)
      writeFileSync(join(out, 'results.md'), `${resultsTable(so)}\n`)
    },
    progress: (line) => console.log(line),
  })
  const table = resultsTable(reports)
  console.log(`\n${table}`)
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n\n`)
  return 0
}

// pnpm passes on the `--` that npm drops.
main(process.argv.slice(2).filter((arg, i) => !(i === 0 && arg === '--'))).then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  },
)
