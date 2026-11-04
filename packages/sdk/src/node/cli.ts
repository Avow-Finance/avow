#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { Writable } from 'node:stream'
import { formatUsd, newSessionId } from '@avow-finance/spec'
import { moderatoClient } from '../moderato.js'
import { dailyLimitOf, keyLeftToday } from '../sandbox/agent.js'
import { loadSandboxDeployment } from '../sandbox/deployment.js'
import { sessionUrl } from '../sandbox/session.js'
import { prepareSandboxBusiness, type SandboxPrompts } from '../sandbox/setup.js'
import { loadAgentItem } from '../sandbox/store.js'
import { MIN_PASSPHRASE } from '../sandbox/vault.js'
import { fileStore, SANDBOX_DIR } from './platform.js'
import { readBusinessConfig, runAgent } from './runner.js'

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

/** The terminal's input, a line at a time, with typing hidden while a passphrase is asked for. */
function terminal() {
  let muted = false
  const output = new Writable({
    write(chunk, encoding, done) {
      if (!muted) process.stdout.write(chunk, encoding)
      done()
    },
  })
  const lines = createInterface({
    input: process.stdin,
    output,
    terminal: Boolean(process.stdin.isTTY),
  })
  let closed = false
  const waiting = new Set<(line: string | null) => void>()
  lines.on('close', () => {
    closed = true
    for (const resolve of waiting) resolve(null)
  })
  const ask = (prompt: string, hidden = false) =>
    new Promise<string | null>((resolve) => {
      if (closed) return resolve(null)
      process.stdout.write(prompt)
      waiting.add(resolve)
      muted = hidden
      lines.question('', (answer) => {
        muted = false
        waiting.delete(resolve)
        if (hidden && process.stdin.isTTY) process.stdout.write('\n')
        resolve(answer)
      })
    })
  return { ask, closed: () => closed }
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

  const input = terminal()
  const prompts: SandboxPrompts = {
    async newPassphrase() {
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
      const typed = await input.ask("Passphrase for your business's key: ", true)
      if (typed === null) throw new Error('No passphrase was typed.')
      return typed
    },
    async confirm(question) {
      return /^y(es)?$/i.test(((await input.ask(`${question} `)) ?? '').trim())
    },
  }

  const store = fileStore(dir)
  const id = newSessionId()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, 'session.json'), `${JSON.stringify({ id, pid: process.pid })}\n`, {
    mode: 0o600,
  })
  let run = 0
  const prepare = async () =>
    prepareSandboxBusiness({
      config: await readBusinessConfig(BUSINESS_FILE),
      prompts,
      store,
      session: { id, run: Math.max(run, 1) },
    })

  try {
    await prepare()
  } catch (error) {
    console.log(`\n${error instanceof Error ? error.message : String(error)}`)
    console.log('Fix that and press Enter to try again.')
  }
  const screen = sessionUrl(id)
  console.log(`\nWatch your agent at ${screen}`)
  openInBrowser(screen)

  for (;;) {
    console.log(`\nPress Enter to run ${AGENT_FILE}, or Ctrl+C to stop.`)
    if ((await input.ask('')) === null) break
    run += 1
    console.log(`\nRun ${run}\n`)
    try {
      await prepare()
    } catch (error) {
      console.log(`${error instanceof Error ? error.message : String(error)}\n`)
      continue
    }
    const { code } = await runAgent(AGENT_FILE, { id, run })
    if (code !== 0) console.log(`\n${AGENT_FILE} stopped with an error.`)
    await showKeyLeft(store).catch(() => {})
  }
  process.exit(0)
}

/** What the agent's key can still move today, and a fresh business when that runs low. */
async function showKeyLeft(store: ReturnType<typeof fileStore>): Promise<void> {
  const agent = await loadAgentItem(store)
  if (!agent) return
  const limit = dailyLimitOf(agent.mandate.message, agent.business.token)
  if (limit === null) return
  const deployment = await loadSandboxDeployment()
  const left = await keyLeftToday(
    moderatoClient(deployment.rpcUrl),
    agent.business.account,
    agent.mandate.message.agentKey,
    agent.business.token,
  )
  console.log(
    `\nYour agent's key can move ${formatUsd(left)} more today, of its ${formatUsd(limit)} daily limit.`,
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
