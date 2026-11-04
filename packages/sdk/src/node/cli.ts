#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { newSessionId } from '@avow-finance/spec'
import { sessionUrl } from '../sandbox/session.js'
import { RUNNER_ENV } from './platform.js'

/**
 * `avow-sandbox agent.ts` runs a sandbox agent the way a developer works on one. It runs the file
 * once to set up the business and enroll the agent's mandate, opens the screen that shows what the
 * agent does, and then runs the file again each time Enter is pressed, reporting to that screen.
 */

/** How to run a file: TypeScript through the project's own tsx, JavaScript through Node. */
function command(file: string): string[] {
  if (!/\.[cm]?tsx?$/.test(file)) return [file]
  try {
    return [createRequire(join(process.cwd(), 'package.json')).resolve('tsx/cli'), file]
  } catch {
    throw new Error(`Running ${file} needs tsx. Install it with npm install tsx.`)
  }
}

/** Runs the file once in its own process, with the runner's settings in its environment. */
function runOnce(file: string, env: Record<string, string>): Promise<number> {
  const settings: NodeJS.ProcessEnv = { ...process.env }
  for (const name of Object.values(RUNNER_ENV)) delete settings[name]
  return new Promise((done) => {
    const child = spawn(process.execPath, command(file), {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...settings, ...env },
    })
    child.on('error', (error) => {
      console.error(error.message)
      done(1)
    })
    child.on('exit', (code) => done(code ?? 1))
  })
}

/** Opens a link in the default browser, quietly, when someone is at the terminal to see it. */
function openInBrowser(url: string): void {
  if (!process.stdout.isTTY || process.env.CI || process.env.AVOW_SANDBOX_NO_OPEN === '1') return
  const [opener, ...args] =
    process.platform === 'darwin'
      ? ['open', url]
      : process.platform === 'win32'
        ? ['cmd', '/c', 'start', '""', url]
        : ['xdg-open', url]
  const child = spawn(opener as string, args, { stdio: 'ignore', detached: true })
  child.on('error', () => {})
  child.unref()
}

async function main(): Promise<void> {
  const file = process.argv[2] ?? 'agent.ts'
  if (!existsSync(resolve(file))) {
    console.error(`There's no ${file} in ${process.cwd()}.`)
    process.exit(1)
  }
  command(file)
  console.log(`Getting the agent in ${file} ready.`)
  const prepared = await runOnce(file, { [RUNNER_ENV.prepare]: '1' })
  if (prepared !== 0) {
    console.log(
      `\n${file} stopped before its agent was ready. Fix what it says above, and the next run tries again.`,
    )
  }
  const session = newSessionId()
  const screen = sessionUrl(session)
  console.log(`\nWatch your agent at ${screen}`)
  openInBrowser(screen)

  const ask = () => console.log(`\nPress Enter to run ${file}, or Ctrl+C to stop.`)
  let run = 0
  let running: Promise<void> | null = null
  const lines = createInterface({ input: process.stdin })
  lines.on('line', () => {
    if (running) return
    run += 1
    console.log(`\nRun ${run}\n`)
    running = runOnce(file, { [RUNNER_ENV.session]: session, [RUNNER_ENV.run]: String(run) }).then(
      (code) => {
        if (code !== 0) console.log(`\n${file} stopped with an error.`)
        running = null
        ask()
      },
    )
  })
  lines.on('close', async () => {
    await running
    process.exit(0)
  })
  ask()
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
