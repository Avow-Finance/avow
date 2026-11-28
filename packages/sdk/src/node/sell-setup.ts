import { readFileSync, realpathSync } from 'node:fs'
import { basename } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import type { ServiceOfferVersion } from '@avow-finance/spec'
import { SellerMandateRefusal } from '../sandbox/seller-mandate.js'
import {
  type Published,
  type SandboxServices,
  type ServiceOfferDraft,
  sandboxServices,
} from '../sandbox/services.js'
import { listenCommand } from './listen.js'
import { fileStore } from './platform.js'
import {
  ASKED_INPUTS,
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

/** A typed number as a number, and anything else as one no reader takes. */
const typedNumber = (typed: string) =>
  /^[0-9]+(\.[0-9]+)?$/.test(typed) ? Number(typed) : Number.NaN

/**
 * The questions setup asks, in order, each with the input it sets. An answer reads with the same
 * reader `readOfferInput` uses, so a question takes exactly what the flag takes.
 */
const QUESTIONS: readonly {
  key: keyof typeof ASKED_INPUTS
  flag: string
  ask: string
  number: boolean
}[] = [
  {
    key: 'name',
    flag: '--name',
    ask: 'What do you sell? Give the item a short name',
    number: false,
  },
  {
    key: 'summary',
    flag: '--summary',
    ask: 'In one sentence, what does the buyer get for one unit',
    number: false,
  },
  {
    key: 'evidence',
    flag: '--evidence',
    ask: 'What shows the buyer it was delivered',
    number: false,
  },
  { key: 'price', flag: '--price', ask: 'The price of one unit, in test dollars', number: true },
  {
    key: 'late_cancellation_percent',
    flag: '--late-cancellation',
    ask: 'What cancelling late costs the buyer, as a percentage of the price',
    number: true,
  },
  {
    key: 'no_show_percent',
    flag: '--no-show',
    ask: 'What not being there to take delivery costs the buyer, as a percentage of the price',
    number: true,
  },
  { key: 'per_day', flag: '--per-day', ask: 'How many orders a day you take', number: true },
]

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
    Pick<SandboxServices, 'businessId' | 'sells' | 'listWithAvow'> & {
      /** Publishing a service, which is all setup publishes. */
      publish: (draft: ServiceOfferDraft) => Promise<Published<ServiceOfferVersion>>
    }
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
    const read = ASKED_INPUTS[q.key](q.number ? typedNumber(typed.trim()) : typed)
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
    if (!deps.ask) break
    const given = input[q.key]
    if (given !== undefined) {
      // A flag that doesn't read is asked again, with the reason, while someone's there to answer.
      const read = ASKED_INPUTS[q.key](given)
      if (typeof read !== 'object') continue
      log(`${q.flag} ${String(given)} doesn't read. ${read.error}`)
    }
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
  let published: Published<ServiceOfferVersion>
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

/**
 * What a process manager runs: this Node and the installed command's own file, both by absolute
 * path. Running them directly, and not through npx, means the manager's stop signal reaches the
 * listener, and a restart runs the version installed here and never resolves a newer package.
 */
export interface Runnable {
  folder: string
  node: string
  cli: string
  version: string
}

/** How long a manager waits after asking the listener to stop, so it can say what still waits. */
const STOP_GRACE_SECONDS = 30

const slug = (folder: string) =>
  basename(folder)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'seller'

const xml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const shell = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
/** A value in a systemd unit, where % starts a specifier. */
const unit = (s: string) => s.replace(/%/g, '%%')
/** One argument of a systemd command line, quoted so a space or a quote stays in it. */
const unitArg = (s: string) => `"${unit(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

/** Whether the command runs from npx's own cache, which npx may clear or replace. */
export const fromNpxCache = (cli: string) => /[\\/]_npx[\\/]/.test(cli)

/**
 * What a process manager needs to keep `avow-sandbox listen` running in a folder, with the steps to
 * start it. Each restarts the listener after a failure and leaves it stopped after Ctrl+C or a stop,
 * which exit with 0. pm2 and systemd also leave it stopped after exit code 2, a stop a restart can't
 * fix. These are for macOS and Linux.
 */
export function keepRunningText(manager: Manager, r: Runnable): string[] {
  const name = `avow-seller-${slug(r.folder)}`
  const pinned = [
    `It runs avow-sandbox ${r.version} from ${r.cli} with the Node at ${r.node}, so an update changes nothing until you run keep-running again.`,
    ...(fromNpxCache(r.cli)
      ? [
          `That file is in npx's cache, which npx can clear. Install it in this folder first with npm install avow-sandbox@${r.version}, then run npx avow-sandbox sell keep-running ${manager} again.`,
        ]
      : []),
  ]
  if (manager === 'pm2') {
    return [
      'Start the listener under pm2, and keep it across restarts',
      `  pm2 start ${shell(r.cli)} --interpreter ${shell(r.node)} --name ${name} --cwd ${shell(r.folder)} --kill-timeout ${STOP_GRACE_SECONDS * 1000} --stop-exit-codes 0 2 -- listen`,
      '  pm2 save',
      '  pm2 startup',
      ...pinned,
      `pm2 logs ${name} shows its status line and each step, and pm2 stop ${name} stops it, after which it says what still waits.`,
    ]
  }
  if (manager === 'systemd') {
    return [
      `Save this as ~/.config/systemd/user/${name}.service`,
      '',
      '[Unit]',
      `Description=Avow sandbox seller in ${unit(r.folder)}`,
      'After=network-online.target',
      '',
      '[Service]',
      `WorkingDirectory=${unit(r.folder)}`,
      `ExecStart=${unitArg(r.node)} ${unitArg(r.cli)} listen`,
      'Restart=on-failure',
      'RestartSec=10',
      'RestartPreventExitStatus=2',
      `TimeoutStopSec=${STOP_GRACE_SECONDS}`,
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
      'Then start it, and keep it running after you log out',
      `  systemctl --user daemon-reload && systemctl --user enable --now ${name}`,
      '  loginctl enable-linger',
      ...pinned,
      `journalctl --user -u ${name} -f shows what it says, and systemctl --user stop ${name} stops it, after which it says what still waits.`,
    ]
  }
  const label = `finance.avow.${name}`
  const log = `${r.folder}/.avow/listen.log`
  return [
    `Save this as ~/Library/LaunchAgents/${label}.plist`,
    '',
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${label}</string>`,
    `  <key>ProgramArguments</key><array><string>${xml(r.node)}</string><string>${xml(r.cli)}</string><string>listen</string></array>`,
    `  <key>WorkingDirectory</key><string>${xml(r.folder)}</string>`,
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>',
    '  <key>ThrottleInterval</key><integer>30</integer>',
    `  <key>ExitTimeOut</key><integer>${STOP_GRACE_SECONDS}</integer>`,
    `  <key>StandardOutPath</key><string>${xml(log)}</string>`,
    `  <key>StandardErrorPath</key><string>${xml(log)}</string>`,
    '</dict>',
    '</plist>',
    '',
    'Then start it',
    `  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/${label}.plist`,
    ...pinned,
    `launchd restarts it after any exit but 0, exit code 2 included, every 30 seconds, so read ${log} when it keeps stopping. launchctl bootout gui/$(id -u)/${label} stops it, after which it says what still waits.`,
  ]
}

/** This Node, the installed command's file and its version, for `sell keep-running`. */
export function thisRunnable(folder: string): Runnable {
  const cli = realpathSync(fileURLToPath(new URL('./cli.js', import.meta.url)))
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    version?: unknown
  }
  return {
    folder,
    node: realpathSync(process.execPath),
    cli,
    version: typeof pkg.version === 'string' ? pkg.version : 'unknown',
  }
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
the listener running unattended, on macOS or Linux.`

/** `avow-sandbox sell setup | keep-running <manager>`. */
export async function sellCommand(args: readonly string[]): Promise<void> {
  const [verb, ...rest] = args
  if (verb === 'keep-running') {
    const read = readKeepRunningArgs(rest)
    if ('error' in read) {
      console.error(read.error)
      process.exit(1)
    }
    console.log(keepRunningText(read.manager, thisRunnable(process.cwd())).join('\n'))
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
