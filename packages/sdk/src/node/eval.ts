#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs'
import { toWire } from '@avow-finance/spec'
import { evalModel, evalTable } from '../session/eval.js'
import { selectProvider } from '../session/selection.js'
import { readJobFlags } from './job.js'

/**
 * Runs the eval in the fixture world, which needs no testnet and no secret.
 *
 *   pnpm eval -- --model qwen3:8b               five runs of steps 2 to 5, with a table per step
 *   pnpm eval -- --model qwen3:8b --speed       one run, with its speed only
 *   pnpm eval -- --provider anthropic           Claude as the reference, billed to your key
 *
 * `--trials n` sets the runs and `--out file.json` writes the report as JSON. In GitHub Actions the
 * table goes to the job summary too.
 */
async function main(args: string[]): Promise<number> {
  const take = (name: string) => {
    const i = args.indexOf(name)
    if (i < 0) return null
    const [, value] = args.splice(i, 2)
    return value ?? null
  }
  const speed = args.includes('--speed')
  if (speed) args.splice(args.indexOf('--speed'), 1)
  const trials = Number(take('--trials') ?? (speed ? 1 : 5))
  const out = take('--out')
  const flags = readJobFlags(args, process.env)
  if ('error' in flags || !Number.isInteger(trials) || trials < 1) {
    console.error('error' in flags ? flags.error : '--trials needs a whole number from 1')
    return 1
  }
  const chosen = await selectProvider({ ...flags, env: process.env })
  if (!chosen.ok) {
    console.error([chosen.why, ...chosen.help].join('\n'))
    return 1
  }
  const model = chosen.provider
  console.log(
    `Eval in the fixture world with ${model.line}, ${trials} run${trials === 1 ? '' : 's'}.`,
  )
  const report = await evalModel(model, trials, (i, r) => {
    const reached = Object.values(r.steps).filter(Boolean).length
    const held = Object.values(r.boundaries).every(Boolean)
    console.log(
      `Run ${i}: ${reached} of ${Object.keys(r.steps).length} steps, boundaries ${held ? 'held' : 'FAILED'}${r.error ? `, stopped: ${r.error}` : ''}`,
    )
  })
  if (speed) {
    const ms = (v: number | null) => (v === null ? 'n/a' : `${Math.round(v)} ms`)
    console.log(
      `Time to first token ${ms(report.firstTokenMs)}, ${report.tokensPerSecond?.toFixed(1) ?? 'n/a'} tokens a second, ${ms(report.firstJobMs)} for the first job.`,
    )
  } else {
    const table = evalTable([report])
    console.log(`\n${table}`)
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n\n`)
  }
  if (out) writeFileSync(out, `${JSON.stringify(toWire(report), null, 2)}\n`)
  // A boundary that failed in any run fails the eval, whatever the model reached.
  return Object.values(report.boundaries).every((n) => n === report.trials) ? 0 : 2
}

// pnpm passes on the `--` that npm drops.
main(process.argv.slice(2).filter((arg, i) => !(i === 0 && arg === '--'))).then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  },
)
