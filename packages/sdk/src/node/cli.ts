#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { formatUsd, type SandboxDeployment } from '@avow-finance/spec'
import {
  banner,
  clean,
  firstRunIntro,
  lookOf,
  RAIL_OPEN_ENV,
  Rail,
  stylesOf,
} from '@avow-finance/terminal'
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
import { connectCommand } from './connect.js'
import { FIRST_RUN_STEPS } from './first-run.js'
import { readJobFlags, runJobSession, SERVICE_FILE } from './job.js'
import { listenCommand, orderCommand } from './mailbox.js'
import { mcpCommand } from './mcp.js'
import { fileStore, latestRun, SANDBOX_DIR, takeRun } from './platform.js'
import {
  checkTerminal,
  ensureChildrenGone,
  readBusinessConfig,
  runAgent,
  terminalPrompts,
} from './runner.js'
import { keepSession, sessionForNextRun } from './runner-session.js'
import { terminalInput } from './session-input.js'

/**
 * `avow-sandbox` runs a sandbox agent the way a developer works on one, with the business and the
 * agent kept apart. The runner is the business. It reads `business.ts`, holds the root key sealed
 * under a passphrase, and asks before it signs a mandate. The agent's file runs in a process of
 * its own with only the agent's key, once each time Enter is pressed, and reports to the screen.
 *
 *   avow-sandbox [start]   sets up, opens the screen, then runs the agent session when the folder
 *                          has service.ts, or agent.ts at each Enter when it doesn't
 *   avow-sandbox job       runs one job with no input
 *   avow-sandbox fresh     moves the business aside and starts a fresh one
 *
 * It draws setup as one rail of steps under Avow's banner. When create-avow-agent runs it in the
 * folder it just made, the banner is already drawn and the rail already open, so it carries on.
 */

const AGENT_FILE = 'agent.ts'
const BUSINESS_FILE = 'business.ts'

/** What `avow-sandbox --help` prints. */
const HELP = `avow-sandbox [start | job | fresh] [--provider local|anthropic] [--model id] [--scripted]

  start    sets up your business, opens your screen, and runs your agent session when the folder
           has service.ts, or agent.ts each time you press Enter when it doesn't
  job      sets up when it's needed, then runs one job with no input
  connect  connects the agent in this folder to a business you run from the console, with
           --business <id> from the console and --name for what the console calls it, and
           --sell when it also quotes and accepts jobs for the business
  order    orders the demo job from another business with --supplier <id>, then checks the
           quote, funds it and waits for the acceptance
  listen   reads the business's inbox and quotes and accepts each order, until you stop it
  mcp      add claude-code or add claude-desktop gives a model in Claude this folder's agent,
           with tools to connect it to a business and commit within the limits approved
  fresh    moves your business aside, keys and all, and sets up a fresh one

  --provider local       a model Ollama runs on this machine, at no charge
  --provider anthropic   Claude, with ANTHROPIC_API_KEY from your environment, billed to that key
  --model id             the model to ask for, such as qwen3:8b
  --scripted             scripted decisions, the same every run, with no model
  --details              every tool call, receipt, address and link, as your screen shows them

With no provider chosen, the session picks a supported model Ollama has pulled, and runs the scripted
decisions when there's none. AVOW_MODEL_PROVIDER and AVOW_MODEL choose the same as the flags.

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
  // An agent connecting to a business it doesn't hold the key of, from any folder.
  if (args[0] === 'connect') return connectCommand(args.slice(1))
  // Its agent ordering from another business, or listening for orders to its own.
  if (args[0] === 'order') return orderCommand(args.slice(1))
  if (args[0] === 'listen') return listenCommand()
  // The MCP server, so a model in Claude can connect the folder's agent and commit with it.
  if (args[0] === 'mcp') return mcpCommand(args.slice(1))
  const command = !args[0] || args[0].startsWith('--') ? 'start' : args[0]
  const flags = readJobFlags(args[0] === command ? args.slice(1) : args, process.env)
  if ('error' in flags) {
    console.error(`${flags.error}\n\n${HELP}`)
    process.exit(1)
  }
  if (command === '--help' || command === '-h' || command === 'help') {
    console.log(HELP)
    return
  }
  if (command !== 'start' && command !== 'fresh' && command !== 'job') {
    console.error(`There's no command ${command} here.\n\n${HELP}`)
    process.exit(1)
  }
  // The job chapter runs when the folder has service.ts, and `job` needs it.
  const jobs = command === 'job' || existsSync(resolve(SERVICE_FILE))
  for (const file of command === 'job'
    ? [BUSINESS_FILE, SERVICE_FILE]
    : [AGENT_FILE, BUSINESS_FILE]) {
    if (!existsSync(resolve(file))) {
      console.error(`There's no ${file} in ${process.cwd()}.`)
      process.exit(1)
    }
  }
  const look = lookOf(process.stdout, process.env, process.stderr)
  const paint = stylesOf(look)
  const input = terminalPrompts()
  // The rail writes through the prompts, so output that arrives while the developer types never
  // lands on the row they're typing on.
  const rail = new Rail(look, (text) => input.print(text))
  const say = (line = '') => {
    rail.settle()
    console.log(line)
  }

  const dir = join(process.cwd(), SANDBOX_DIR)
  const store = fileStore(dir)
  // A first run teaches as it goes, in four numbered steps, the last two in the agent session.
  const firstRun =
    command === 'fresh' || (command === 'start' && (await loadBusinessItem(store)) === null)
  if (!CONTINUED) {
    say(banner(look))
    if (firstRun) say(firstRunIntro(look))
  }
  const config = await readBusinessConfig(BUSINESS_FILE)
  if (!CONTINUED && !firstRun) rail.open(config.name)
  if (command === 'fresh' && existsSync(dir)) {
    const aside = `${SANDBOX_DIR}-${new Date().toISOString().replace(/[:.]/g, '-')}`
    renameSync(dir, join(process.cwd(), aside))
    rail.done(`Moved your previous business to ${aside}, keys and all.`)
  }

  const prompts: SandboxPrompts = {
    async newPassphrase() {
      await ensureChildrenGone()
      checkTerminal((line) => rail.line(line))
      rail.ask(`Choose a passphrase for your business's key, at least ${MIN_PASSPHRASE} characters`)
      for (;;) {
        const first = await input.ask(rail.prefix, true)
        if (first === null) throw new Error('No passphrase was set.')
        if (first.length < MIN_PASSPHRASE) {
          rail.answered(`That's shorter than ${MIN_PASSPHRASE} characters. Choose another.`, 'bad')
          continue
        }
        rail.answered('Set', 'quiet')
        if ((await input.ask(`${rail.prefix}${paint.dim('Type it again ')}`, true)) === first) {
          rail.answered('Typed again, and it matches', 'quiet')
          return first
        }
        rail.answered("Those didn't match. Choose it again.", 'bad')
      }
    },
    async passphrase() {
      await ensureChildrenGone()
      checkTerminal((line) => rail.line(line))
      rail.ask("Type your business's passphrase")
      const typed = await input.ask(rail.prefix, true)
      if (typed === null) throw new Error('No passphrase was typed.')
      rail.answered('Typed', 'quiet')
      return typed
    },
    async confirm(question, details = []) {
      rail.ask(question)
      for (const detail of details) rail.line(detail)
      const answer = await input.ask(`${rail.prefix}${paint.dim('y/N')} `)
      const yes = /^y(es)?$/i.test((answer ?? '').trim())
      rail.answered(yes ? 'Yes' : 'No', 'quiet')
      return yes
    },
  }
  // Setup's steps take the first two of the first run's numbers, and a run with no service.ts
  // has only those two.
  const steps = { at: 0, of: jobs && firstRun ? FIRST_RUN_STEPS : 2 }
  const show = (line: string, kind: SetupLineKind = 'note') => {
    if (kind === 'step') {
      const [title = '', why] = line.split('\n')
      steps.at += 1
      rail.step(steps.at, steps.of, title, why)
    } else if (kind === 'step_done') rail.stepDone(line)
    else if (kind === 'detail') {
      if (flags.details) rail.quiet(line)
    } else if (kind === 'stage') rail.stage(line)
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
      supplier: jobs,
      log: show,
    })
    if (done.supplier && !done.supplier.ok) show(done.supplier.why)
    if (done.announced) session = { ...session, fresh: false }
    return done
  }

  let ready = false
  try {
    const done = await prepare()
    ready = !jobs || done.supplier?.ok === true
    // A first run goes straight on to its next step, and only a stop gets the rail's last line.
    if (!(firstRun && jobs && ready)) {
      rail.close(
        ready ? `${config.name} is ready.` : `${config.name} is set up, and can't take jobs yet.`,
      )
    }
  } catch (error) {
    rail.fail(error instanceof Error ? error.message : String(error))
    rail.close(jobs ? 'Fix that and run it again.' : 'Fix that and press Enter to try again.')
  }
  // The link takes a line of its own, so the terminal never breaks it.
  const screen = sessionUrl(session.id)
  const opened = openInBrowser(screen)
  if (firstRun && jobs && ready) {
    rail.quiet(
      opened
        ? 'Your browser opened your screen, which shows every step as it happens, at'
        : 'Your screen shows every step as it happens, at',
    )
    say(`${rail.prefix}${screen}`)
  } else {
    say(
      `\n   ${opened ? 'Your screen opened in your browser, at' : 'Watch your agent on your screen, at'}`,
    )
    say(`   ${screen}`)
  }

  if (jobs) {
    if (!ready) process.exit(1)
    if (!firstRun) {
      say()
      rail.open(command === 'job' ? 'One job' : 'Your agent session')
    }
    const code = await runJobSession({
      firstRun,
      mode: command === 'job' ? 'one' : 'interactive',
      flags,
      rail,
      look,
      store,
      deployment,
      dir,
      session,
      nextRun: () => takeRun(dir, session.id),
      prompts,
      input: terminalInput(input, rail),
    })
    process.exit(code)
  }

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
      rail.fail(error instanceof Error ? error.message : String(error))
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
  // A supplier's or a relay's own words can end up in an error, so they're cleaned like any outside text.
  console.error(clean(error instanceof Error ? error.message : String(error)))
  process.exit(1)
})
