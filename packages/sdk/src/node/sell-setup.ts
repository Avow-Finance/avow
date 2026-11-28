import { basename } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { SERVICE_QUANTITY_MAX } from '@avow-finance/spec'
import { SellerMandateRefusal } from '../sandbox/seller-mandate.js'
import { type SandboxServices, sandboxServices } from '../sandbox/services.js'
import { listenCommand } from './listen.js'
import { fileStore } from './platform.js'
import {
  listedLines,
  type OfferInput,
  offerSentences,
  publishedLines,
  readOfferInput,
  readPublishArgs,
  writeOfferFile,
} from './services.js'

/**
 * `avow-sandbox sell setup` sets a seller up in one command. It asks for the item, its price, both
 * charges and how many orders a day it takes, publishes the offer, lists it with Avow when asked,
 * and starts the listener that quotes and accepts every order within those rules. Flags answer the
 * questions up front, so it also runs where nobody can type. `sell keep-running` prints what a
 * process manager needs to keep the listener running unattended.
 *
 * Every step signs on this machine with the agent's key in `.avow`, and nothing here approves a
 * request or widens a limit. A seller's mandate, when one is in force, still bounds what the agent
 * publishes, quotes and accepts, and the agent holds itself to it.
 */

/** The questions setup asks, in order, each with the input it sets and how its answer reads. */
const QUESTIONS: readonly {
  key: keyof OfferInput
  flag: string
  ask: string
  read: (typed: string) => string | number | { error: string }
}[] = [
  { key: 'name', flag: '--name', ask: 'What do you sell? Give the item a short name', read: text },
  {
    key: 'summary',
    flag: '--summary',
    ask: 'In one sentence, what does the buyer get for one unit',
    read: text,
  },
  {
    key: 'evidence',
    flag: '--evidence',
    ask: 'What shows the buyer it was delivered',
    read: text,
  },
  {
    key: 'price',
    flag: '--price',
    ask: 'The price of one unit, in test dollars',
    read: (t) =>
      /^[0-9]+(\.[0-9]{1,6})?$/.test(t) && Number(t) > 0
        ? Number(t)
        : { error: 'Give a price above zero, to six decimals at most, such as 50 or 12.5.' },
  },
  {
    key: 'late_cancellation_percent',
    flag: '--late-cancellation',
    ask: 'What cancelling late costs the buyer, as a percentage of the price',
    read: percent,
  },
  {
    key: 'no_show_percent',
    flag: '--no-show',
    ask: 'What not being there to take delivery costs the buyer, as a percentage of the price',
    read: percent,
  },
  {
    key: 'per_day',
    flag: '--per-day',
    ask: 'How many orders a day you take',
    read: (t) =>
      /^[1-9][0-9]{0,6}$/.test(t) && Number(t) <= SERVICE_QUANTITY_MAX
        ? Number(t)
        : { error: `Give a whole number of orders from 1 to ${SERVICE_QUANTITY_MAX}.` },
  },
]

function text(typed: string): string | { error: string } {
  return typed ? typed : { error: 'Type an answer, or Ctrl+C to stop.' }
}

function percent(typed: string): number | { error: string } {
  return /^[0-9]+(\.[0-9]{1,2})?$/.test(typed) && Number(typed) <= 100
    ? Number(typed)
    : { error: 'Give a percentage from 0 to 100, to two decimals at most, such as 20.' }
}

/** What `sell setup` was asked to do, read from its flags. */
export interface SellSetupAsk {
  input: OfferInput
  /** Whether to list the offer with Avow, or null to ask. */
  listWithAvow: boolean | null
  /** Whether to start the listener once the offer is published. */
  listen: boolean
  /** Whether to publish without asking first. */
  yes: boolean
}

/** The flags `sell setup` takes that stand alone, with no value after them. */
const SWITCHES = ['--list-with-avow', '--no-list-with-avow', '--no-listen', '--yes'] as const

/** What `sell setup` was asked to do, or why it can't run. */
export function readSellSetupArgs(args: readonly string[]): SellSetupAsk | { error: string } {
  const switches = new Set(args.filter((a) => (SWITCHES as readonly string[]).includes(a)))
  if (switches.has('--list-with-avow') && switches.has('--no-list-with-avow')) {
    return { error: 'Give --list-with-avow or --no-list-with-avow, not both.' }
  }
  const rest = args.filter((a) => !(SWITCHES as readonly string[]).includes(a))
  const input = readPublishArgs(rest)
  if ('error' in input) return { error: input.error.replace('offer publish', 'sell setup') }
  return {
    input,
    listWithAvow: switches.has('--list-with-avow')
      ? true
      : switches.has('--no-list-with-avow')
        ? false
        : null,
    listen: !switches.has('--no-listen'),
    yes: switches.has('--yes'),
  }
}

/** The flags still needed for a setup nobody can answer questions in. */
export function missingFlags(input: OfferInput): string[] {
  return QUESTIONS.filter((q) => input[q.key] === undefined).map((q) => q.flag)
}

/** What setup uses beyond its own logic, which a test replaces. */
export interface SellSetupDeps {
  services: () => Promise<
    Pick<SandboxServices, 'businessId' | 'sells' | 'publish' | 'listWithAvow'>
  >
  /** Asks a question and answers with what was typed, or null when nobody can type. */
  ask: ((question: string) => Promise<string | null>) | null
  writeOffer: typeof writeOfferFile
  log: (line: string) => void
  /** Starts the listener, which runs until it's stopped. */
  listen: () => Promise<void>
}

/** How setup ended, and the exit code that says so. */
export type SellSetupEnd =
  | { ok: true; published: boolean }
  | { ok: false; error: string; exitCode: 1 | 2 }

/** Asks until an answer reads, or answers with null when nobody's there to type. */
async function askFor(
  q: (typeof QUESTIONS)[number],
  ask: NonNullable<SellSetupDeps['ask']>,
  log: (line: string) => void,
): Promise<string | number | null> {
  for (;;) {
    const typed = await ask(`${q.ask}: `)
    if (typed === null) return null
    const read = q.read(typed.trim())
    if (typeof read !== 'object') return read
    log(read.error)
  }
}

async function yesNo(ask: NonNullable<SellSetupDeps['ask']>, question: string): Promise<boolean> {
  return /^y(es)?$/i.test(((await ask(`${question} y/N `)) ?? '').trim())
}

/**
 * Sets a seller up: reads or asks for the offer, shows it, publishes it, lists it with Avow when
 * asked, and starts the listener. A seller's mandate that refuses the offer stops it, with the
 * reason, and Avow refusing a listing is said plainly and setup carries on without one.
 */
export async function sellSetup(ask: SellSetupAsk, deps: SellSetupDeps): Promise<SellSetupEnd> {
  const { log } = deps
  const services = await deps.services()
  if (!services.sells) {
    return {
      ok: false,
      exitCode: 2,
      error:
        'The agent in this folder holds no signing key, so it can quote and accept nothing. Connect it to sell with npx avow-sandbox connect --sell, then run sell setup again.',
    }
  }
  log(
    `Setting up ${services.businessId} to sell. It's a sandbox business on Tempo's Moderato testnet, a test business that sells for test dollars and isn't verified.`,
  )
  const input: OfferInput = { ...ask.input }
  const missing = missingFlags(input)
  if (missing.length > 0 && !deps.ask) {
    return {
      ok: false,
      exitCode: 1,
      error: `Nobody can answer questions here, so give ${missing.join(', ')} as flags.`,
    }
  }
  for (const q of QUESTIONS) {
    if (input[q.key] !== undefined || !deps.ask) continue
    const answer = await askFor(q, deps.ask, log)
    if (answer === null)
      return { ok: false, exitCode: 1, error: 'Setup stopped before the offer was complete.' }
    input[q.key] = answer
  }
  const draft = readOfferInput(input)
  if ('error' in draft) return { ok: false, exitCode: 1, error: draft.error }
  log('The offer reads')
  for (const line of offerSentences({ ...draft, supplier: services.businessId })) {
    log(`  ${line}`)
  }
  log(
    `The listener quotes and accepts every order for it within this price and ${draft.rules.dailyCapacity} order${draft.rules.dailyCapacity === 1 ? '' : 's'} a day, without asking you.`,
  )
  if (deps.ask && !ask.yes && !(await yesNo(deps.ask, 'Publish this offer?'))) {
    log('Nothing was published.')
    return { ok: true, published: false }
  }
  let published: Awaited<ReturnType<SandboxServices['publish']>>
  try {
    published = await services.publish(draft)
  } catch (error) {
    if (error instanceof SellerMandateRefusal) {
      return {
        ok: false,
        exitCode: 2,
        error: `Not published. ${error.message} Change the offer to fit the mandate, or ask for other limits with npx avow-sandbox ask-to-sell.`,
      }
    }
    throw error
  }
  for (const line of publishedLines(published, deps.writeOffer(published.version))) log(line)
  const list =
    ask.listWithAvow ??
    (deps.ask ? await yesNo(deps.ask, "List it in Avow's directory too?") : false)
  if (list) {
    try {
      const listed = await services.listWithAvow(published.id)
      for (const line of listed.ok ? listedLines(listed.listing) : [listed.notice]) log(line)
    } catch (error) {
      log(
        `Not listed with Avow. ${error instanceof Error ? error.message : String(error)} The offer stays published here, and the listener still sells it.`,
      )
    }
  }
  log(
    'To keep the listener running unattended, npx avow-sandbox sell keep-running pm2, systemd or launchd prints the setup for that process manager.',
  )
  if (!ask.listen) {
    log('Run npx avow-sandbox listen here to quote and accept the orders that come.')
    return { ok: true, published: true }
  }
  await deps.listen()
  return { ok: true, published: true }
}

/** The process managers `sell keep-running` prints a setup for. */
export const MANAGERS = ['pm2', 'systemd', 'launchd'] as const
export type Manager = (typeof MANAGERS)[number]

const slug = (folder: string) =>
  basename(folder)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'seller'

const xml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const shell = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/**
 * What a process manager needs to keep `avow-sandbox listen` running in a folder, with the steps to
 * start it. Each restarts the listener after a failure and leaves it stopped after Ctrl+C or a stop,
 * which exit with 0. pm2 and systemd also leave it stopped after exit code 2, a stop a restart can't
 * fix.
 */
export function keepRunningText(manager: Manager, folder: string, path: string): string[] {
  const name = `avow-seller-${slug(folder)}`
  if (manager === 'pm2') {
    return [
      'Start the listener under pm2, which also runs on Windows, and keep it across restarts',
      `  pm2 start npx --name ${name} --cwd ${shell(folder)} --stop-exit-codes 0 2 -- avow-sandbox listen`,
      '  pm2 save',
      '  pm2 startup',
      `pm2 logs ${name} shows its status line and each step, and pm2 stop ${name} stops it, after which it says what still waits.`,
    ]
  }
  if (manager === 'systemd') {
    return [
      `Save this as ~/.config/systemd/user/${name}.service`,
      '',
      '[Unit]',
      `Description=Avow sandbox seller in ${folder}`,
      'After=network-online.target',
      '',
      '[Service]',
      `WorkingDirectory=${folder}`,
      `Environment="PATH=${path}"`,
      'ExecStart=/usr/bin/env npx avow-sandbox listen',
      'Restart=on-failure',
      'RestartSec=10',
      'RestartPreventExitStatus=2',
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
      'Then start it, and keep it running after you log out',
      `  systemctl --user daemon-reload && systemctl --user enable --now ${name}`,
      '  loginctl enable-linger',
      `journalctl --user -u ${name} -f shows what it says, and systemctl --user stop ${name} stops it, after which it says what still waits.`,
    ]
  }
  const label = `finance.avow.${name}`
  const log = `${folder}/.avow/listen.log`
  return [
    `Save this as ~/Library/LaunchAgents/${label}.plist`,
    '',
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${label}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array><string>/usr/bin/env</string><string>npx</string><string>avow-sandbox</string><string>listen</string></array>',
    `  <key>WorkingDirectory</key><string>${xml(folder)}</string>`,
    `  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(path)}</string></dict>`,
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>',
    '  <key>ThrottleInterval</key><integer>30</integer>',
    `  <key>StandardOutPath</key><string>${xml(log)}</string>`,
    `  <key>StandardErrorPath</key><string>${xml(log)}</string>`,
    '</dict>',
    '</plist>',
    '',
    'Then start it',
    `  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/${label}.plist`,
    `launchd restarts it after any exit but 0, exit code 2 included, every 30 seconds, so read ${log} when it keeps stopping. launchctl bootout gui/$(id -u)/${label} stops it, after which it says what still waits.`,
  ]
}

/** What `sell keep-running` was asked for, or why it can't run. */
export function readKeepRunningArgs(
  args: readonly string[],
): { manager: Manager } | { error: string } {
  const [manager, ...more] = args
  return (MANAGERS as readonly (string | undefined)[]).includes(manager) && more.length === 0
    ? { manager: manager as Manager }
    : { error: `sell keep-running takes ${MANAGERS.join(', ')}` }
}

const SELL_HELP = `sell setup asks for the item, its price, both charges and orders a day, publishes the offer and
starts the listener. --name, --summary, --evidence, --price, --late-cancellation, --no-show and
--per-day answer the questions up front, with the rest of offer publish's flags.
--list-with-avow lists the offer with Avow, --no-listen stops after publishing, and --yes publishes
without asking. sell keep-running pm2|systemd|launchd prints what a process manager needs to keep
the listener running unattended.`

/** `avow-sandbox sell setup | keep-running <manager>`. */
export async function sellCommand(args: readonly string[]): Promise<void> {
  const [verb, ...rest] = args
  if (verb === 'keep-running') {
    const read = readKeepRunningArgs(rest)
    if ('error' in read) {
      console.error(read.error)
      process.exit(1)
    }
    console.log(keepRunningText(read.manager, process.cwd(), process.env.PATH ?? '').join('\n'))
    return
  }
  if (verb !== 'setup') {
    console.error(SELL_HELP)
    process.exit(1)
  }
  const read = readSellSetupArgs(rest)
  if ('error' in read) {
    console.error(read.error)
    process.exit(1)
  }
  const tty = process.stdin.isTTY === true && process.stdout.isTTY === true
  const lines = tty ? createInterface({ input: process.stdin, output: process.stdout }) : null
  let closed = false
  lines?.once('close', () => {
    closed = true
  })
  // Ctrl+C at a question ends setup, with nothing published.
  lines?.once('SIGINT', () => lines.close())
  const end = await sellSetup(read, {
    services: () => sandboxServices({ store: fileStore() }),
    ask: lines
      ? (question) => (closed ? Promise.resolve(null) : lines.question(question).catch(() => null))
      : null,
    writeOffer: writeOfferFile,
    log: (line) => console.log(line),
    // The questions are done, so the terminal goes back to the listener and its Ctrl+C.
    listen: () => {
      lines?.close()
      return listenCommand()
    },
  }).finally(() => lines?.close())
  if (!end.ok) {
    console.error(end.error)
    process.exit(end.exitCode)
  }
}
