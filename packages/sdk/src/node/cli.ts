#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { formatUsd, type SandboxDeployment } from '@avow-finance/spec'
import { moderatoClient } from '../moderato.js'
import { dailyLimitOf, keyLeftToday } from '../sandbox/agent.js'
import { loadBusinessItem } from '../sandbox/business-store.js'
import { loadSandboxDeployment } from '../sandbox/deployment.js'
import { sessionUrl } from '../sandbox/session.js'
import { prepareSandboxBusiness, type SandboxPrompts } from '../sandbox/setup.js'
import { loadAgentItem } from '../sandbox/store.js'
import { MIN_PASSPHRASE } from '../sandbox/vault.js'
import { fileStore, latestRun, SANDBOX_DIR, takeRun } from './platform.js'
import {
  checkTerminal,
  ensureChildrenGone,
  readBusinessConfig,
  runAgent,
  terminalPrompts,
} from './runner.js'
import { keepSession, sessionForNextRun } from './runner-session.js'

/**
 * `avow-sandbox` runs a sandbox agent the way a developer works on one, with the business and the
 * agent kept apart. The runner is the business. It reads `business.ts`, holds the root key sealed
 * under a passphrase, and asks before it signs a mandate. The agent's file runs in a process of
 * its own with only the agent's key, once each time Enter is pressed, and reports to the screen.
 *
 *   avow-sandbox [start]   sets up, opens the screen and runs agent.ts at each Enter
 *   avow-sandbox fresh     moves the business aside and starts a fresh one
 */

const AGENT_FILE = 'agent.ts'
const BUSINESS_FILE = 'business.ts'

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

async function main(args: readonly string[]): Promise<void> {
  const command = args[0] ?? 'start'
  if (command !== 'start' && command !== 'fresh') {
    console.error('Use avow-sandbox start, or avow-sandbox fresh for a fresh business.')
    process.exit(1)
  }
  for (const file of [AGENT_FILE, BUSINESS_FILE]) {
    if (!existsSync(resolve(file))) {
      console.error(`There's no ${file} in ${process.cwd()}.`)
      process.exit(1)
    }
  }
  const dir = join(process.cwd(), SANDBOX_DIR)
  if (command === 'fresh' && existsSync(dir)) {
    const aside = `${SANDBOX_DIR}-${new Date().toISOString().replace(/[:.]/g, '-')}`
    renameSync(dir, join(process.cwd(), aside))
    console.log(`Moved your previous business to ${aside}, keys and all. Setting up a fresh one.\n`)
  }

  const input = terminalPrompts()
  const prompts: SandboxPrompts = {
    async newPassphrase() {
      await ensureChildrenGone()
      checkTerminal()
      for (;;) {
        const first = await input.ask(
          `Choose a passphrase for your business's key, at least ${MIN_PASSPHRASE} characters: `,
          true,
        )
        if (first === null) throw new Error('No passphrase was set.')
        if (first.length < MIN_PASSPHRASE) {
          console.log(`That's shorter than ${MIN_PASSPHRASE} characters.`)
          continue
        }
        if ((await input.ask('Type it again: ', true)) === first) return first
        console.log("Those didn't match.")
      }
    },
    async passphrase() {
      await ensureChildrenGone()
      checkTerminal()
      const typed = await input.ask("Passphrase for your business's key: ", true)
      if (typed === null) throw new Error('No passphrase was typed.')
      return typed
    },
    async confirm(question) {
      return /^y(es)?$/i.test(((await input.ask(`${question} `)) ?? '').trim())
    },
  }

  const store = fileStore(dir)
  const deployment = await loadSandboxDeployment()
  // The session stays with the business across restarts, so the screen a developer has open
  // keeps working. A new one gets the agent's authority, signed by the business's key.
  const sessionOptions = {
    dir,
    apiUrl: deployment.apiUrl,
    log: (line: string) => console.log(line),
  }
  let session = await keepSession({
    ...sessionOptions,
    account: (await loadBusinessItem(store))?.account ?? null,
  })
  // Setup reports any authority change under the first run, and the first press of Enter runs
  // under it too, unless a model's tool call has started a run since.
  let run = takeRun(dir, session.id)
  let first = true
  const prepare = async () => {
    const done = await prepareSandboxBusiness({
      config: await readBusinessConfig(BUSINESS_FILE),
      prompts,
      store,
      deployment,
      session: { id: session.id, run },
      announce: session.fresh,
    })
    if (done.announced) session = { ...session, fresh: false }
    return done
  }

  try {
    await prepare()
  } catch (error) {
    console.log(`\n${error instanceof Error ? error.message : String(error)}`)
    console.log('Fix that and press Enter to try again.')
  }
  const screen = sessionUrl(session.id)
  console.log(`\nWatch your agent at ${screen}`)
  openInBrowser(screen)

  for (;;) {
    console.log(`\nPress Enter to run ${AGENT_FILE}, or Ctrl+C to stop.`)
    if ((await input.ask('')) === null) break
    const next = await sessionForNextRun(session, sessionOptions)
    if (next.id !== session.id) {
      session = next
      first = false
      run = takeRun(dir, session.id)
      console.log(
        `\nAvow's relay closes your session within ten minutes, so the runner opened a new one. Watch your agent at ${sessionUrl(session.id)}`,
      )
    } else {
      session = next
      if (!first || latestRun(dir, session.id) !== run) run = takeRun(dir, session.id)
    }
    first = false
    console.log(`\nRun ${run}\n`)
    try {
      await prepare()
    } catch (error) {
      console.log(`${error instanceof Error ? error.message : String(error)}\n`)
      continue
    }
    const { code } = await runAgent(AGENT_FILE, { id: session.id, run })
    if (code !== 0) console.log(`\n${AGENT_FILE} stopped with an error.`)
    await showKeyLeft(store, deployment).catch(() => {})
  }
  process.exit(0)
}

/** What the agent's key can still move today, and a fresh business when that runs low. */
async function showKeyLeft(
  store: ReturnType<typeof fileStore>,
  deployment: SandboxDeployment,
): Promise<void> {
  const agent = await loadAgentItem(store)
  if (!agent) return
  const limit = dailyLimitOf(agent.mandate.message, agent.business.token)
  if (limit === null) return
  const left = await keyLeftToday(
    moderatoClient(deployment.rpcUrl),
    agent.business.account,
    agent.mandate.message.agentKey,
    agent.business.token,
  )
  console.log(
    `\nYour agent's key can move ${formatUsd(left)} more today, of its ${formatUsd(limit)} a day, a limit your business set on chain.`,
  )
  if (left * 4n < limit) {
    console.log(
      'That is running low. npm run fresh sets up a fresh sandbox business with a full day.',
    )
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
