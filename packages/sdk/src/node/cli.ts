#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { formatUsd, type SandboxDeployment } from '@avow-finance/spec'
import { banner, lookOf, RAIL_OPEN_ENV, Rail, stylesOf } from '@avow-finance/terminal'
import { moderatoClient } from '../moderato.js'
import { dailyLimitOf, keyLeftToday } from '../sandbox/agent.js'
import { loadBusinessItem } from '../sandbox/business-store.js'
import { loadSandboxDeployment } from '../sandbox/deployment.js'
import { sessionUrl } from '../sandbox/session.js'
import {
  prepareSandboxBusiness,
  type SandboxPrompts,
  type SetupLineKind,
} from '../sandbox/setup.js'
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
 *
 * It draws setup as one rail of steps under Avow's banner. When create-avow-agent runs it in the
 * folder it just made, the banner is already drawn and the rail already open, so it carries on.
 */

const AGENT_FILE = 'agent.ts'
const BUSINESS_FILE = 'business.ts'

/** What `avow-sandbox --help` prints. */
const HELP = `avow-sandbox [start | fresh]

  start    sets up your business, opens your screen, and runs agent.ts each time you press Enter
  fresh    moves your business aside, keys and all, and sets up a fresh one

It runs on Tempo's Moderato testnet with test dollars. Your business's key stays in .avow on this
machine, sealed under your passphrase.`

/** Set by create-avow-agent, which draws the banner and opens the rail before setup runs. */
const CONTINUED = process.env[RAIL_OPEN_ENV] === '1'

/**
 * Opens a link in the default browser, quietly, when someone is at the terminal to see it, and says
 * whether it tried.
 */
function openInBrowser(url: string): boolean {
  if (!process.stdout.isTTY || process.env.CI || process.env.AVOW_SANDBOX_NO_OPEN === '1') {
    return false
  }
  const [opener, ...args] =
    process.platform === 'darwin'
      ? ['open', url]
      : process.platform === 'win32'
        ? ['cmd', '/c', 'start', '""', url]
        : ['xdg-open', url]
  const child = spawn(opener as string, args, { stdio: 'ignore', detached: true })
  child.on('error', () => {})
  child.unref()
  return true
}

async function main(args: readonly string[]): Promise<void> {
  const command = args[0] ?? 'start'
  if (command === '--help' || command === '-h' || command === 'help') {
    console.log(HELP)
    return
  }
  if (command !== 'start' && command !== 'fresh') {
    console.error(`There's no command ${command} here.\n\n${HELP}`)
    process.exit(1)
  }
  for (const file of [AGENT_FILE, BUSINESS_FILE]) {
    if (!existsSync(resolve(file))) {
      console.error(`There's no ${file} in ${process.cwd()}.`)
      process.exit(1)
    }
  }
  const look = lookOf(process.stdout)
  const paint = stylesOf(look)
  const rail = new Rail(look)
  const say = (line = '') => {
    rail.settle()
    console.log(line)
  }
  if (!CONTINUED) say(banner(look))

  const dir = join(process.cwd(), SANDBOX_DIR)
  const store = fileStore(dir)
  const config = await readBusinessConfig(BUSINESS_FILE)
  if (!CONTINUED) {
    const known = command === 'start' && (await loadBusinessItem(store)) !== null
    rail.open(known ? config.name : `Set up ${config.name}`)
  }
  if (command === 'fresh' && existsSync(dir)) {
    const aside = `${SANDBOX_DIR}-${new Date().toISOString().replace(/[:.]/g, '-')}`
    renameSync(dir, join(process.cwd(), aside))
    rail.done(`Moved your previous business to ${aside}, keys and all.`)
  }

  const input = terminalPrompts()
  const prompts: SandboxPrompts = {
    async newPassphrase() {
      await ensureChildrenGone()
      checkTerminal((line) => rail.line(line))
      rail.ask(`Choose a passphrase for your business's key, at least ${MIN_PASSPHRASE} characters`)
      for (;;) {
        const first = await input.ask(rail.prefix, true)
        if (first === null) throw new Error('No passphrase was set.')
        if (first.length < MIN_PASSPHRASE) {
          rail.answered(
            paint.bad(`That's shorter than ${MIN_PASSPHRASE} characters. Choose another.`),
          )
          continue
        }
        rail.answered(paint.dim('Set'))
        if ((await input.ask(`${rail.prefix}${paint.dim('Type it again ')}`, true)) === first) {
          rail.answered(paint.dim('Typed again, and it matches'))
          return first
        }
        rail.answered(paint.bad("Those didn't match. Choose it again."))
      }
    },
    async passphrase() {
      await ensureChildrenGone()
      checkTerminal((line) => rail.line(line))
      rail.ask("Type your business's passphrase")
      const typed = await input.ask(rail.prefix, true)
      if (typed === null) throw new Error('No passphrase was typed.')
      rail.answered(paint.dim('Typed'))
      return typed
    },
    async confirm(question, details = []) {
      rail.ask(question)
      for (const detail of details) rail.line(detail)
      const answer = await input.ask(`${rail.prefix}${paint.dim('y/N')} `)
      return /^y(es)?$/i.test((answer ?? '').trim())
    },
  }
  const show = (line: string, kind: SetupLineKind = 'note') => {
    if (kind === 'stage') rail.stage(line)
    else if (kind === 'done') rail.done(line)
    else if (kind === 'wait') rail.wait(line)
    else rail.line(line)
  }

  const deployment = await loadSandboxDeployment()
  // The session stays with the business across restarts, so the screen a developer has open
  // keeps working. A new one gets the agent's authority, signed by the business's key.
  const sessionOptions = {
    dir,
    apiUrl: deployment.apiUrl,
    log: (line: string) => rail.line(line),
  }
  let session = await keepSession({
    ...sessionOptions,
    account: (await loadBusinessItem(store))?.account ?? null,
  })
  // Setup reports any authority change under the first run, and the first press of Enter runs
  // under it too, unless a model's tool call has started a run since.
  let run = takeRun(dir, session.id)
  let first = true
  const prepare = async (business = config) => {
    const done = await prepareSandboxBusiness({
      config: business,
      prompts,
      store,
      deployment,
      session: { id: session.id, run },
      announce: session.fresh,
      log: show,
    })
    if (done.announced) session = { ...session, fresh: false }
    return done
  }

  try {
    await prepare()
    rail.close(`${config.name} is ready.`)
  } catch (error) {
    rail.fail(error instanceof Error ? error.message : String(error))
    rail.close('Fix that and press Enter to try again.')
  }
  // The link takes a line of its own, so the terminal never breaks it.
  const screen = sessionUrl(session.id)
  say(
    `\n   ${openInBrowser(screen) ? 'Your screen opened in your browser, at' : 'Watch your agent on your screen, at'}`,
  )
  say(`   ${screen}`)

  for (;;) {
    say(`\n   Press Enter to run ${AGENT_FILE}, or Ctrl+C to stop.`)
    if ((await input.ask('   ')) === null) break
    const next = await sessionForNextRun(session, sessionOptions)
    if (next.id !== session.id) {
      session = next
      first = false
      run = takeRun(dir, session.id)
      say(
        `\n   Avow's relay closes your session within ten minutes, so the runner opened a new one. Watch your agent at`,
      )
      say(`   ${sessionUrl(session.id)}`)
    } else {
      session = next
      if (!first || latestRun(dir, session.id) !== run) run = takeRun(dir, session.id)
    }
    first = false
    say()
    rail.open(`Run ${run}`)
    try {
      // business.ts is read again for each run, so an edit to it takes effect at the next Enter.
      await prepare(await readBusinessConfig(BUSINESS_FILE))
    } catch (error) {
      say(`${error instanceof Error ? error.message : String(error)}\n`)
      continue
    }
    rail.settle()
    const { code } = await runAgent(AGENT_FILE, { id: session.id, run })
    if (code !== 0) say(`\n${AGENT_FILE} stopped with an error.`)
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
