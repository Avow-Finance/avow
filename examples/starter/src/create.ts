import { type SpawnOptions, spawn } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { banner, lookOf, RAIL_OPEN_ENV, Rail, stylesOf } from '@avow-finance/terminal'

/** What a new agent folder starts with, which travels beside this script in the tarball. */
export const TEMPLATE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'template')

/**
 * The template's files and the names they take in the new folder. The ignore file travels as
 * `gitignore`, since npm leaves a file named `.gitignore` out of a package.
 */
const COPIED: Record<string, string> = {
  'agent.ts': 'agent.ts',
  'README.md': 'README.md',
  'tsconfig.json': 'tsconfig.json',
  gitignore: '.gitignore',
}

/** The business's name in the template's business.ts, which the developer's own replaces. */
export const DEFAULT_NAME = 'Starter Test Co'
const NAME_LINE = `  name: '${DEFAULT_NAME}',`

/**
 * The template's business.ts with `name` in place of the default, written as a quoted string the
 * file can hold whatever the name's characters. A name with a control character is refused.
 */
export function businessFile(template: string, name: string): string {
  const trimmed = name.trim()
  if (trimmed === '') throw new RangeError("The business's name can't be empty.")
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new RangeError("The business's name can't hold a control character.")
  }
  const source = readFileSync(join(template, 'business.ts'), 'utf8')
  if (source.split(NAME_LINE).length !== 2) {
    throw new Error(`The template's business.ts doesn't set the name as ${NAME_LINE.trim()}`)
  }
  const quoted = `'${trimmed.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
  // A function, so a $ in the name is written as it is and never read as a replacement pattern.
  return source.replace(NAME_LINE, () => `  name: ${quoted},`)
}

/** The folder's name as npm takes a package name: lower case, with no spaces. */
export function packageName(folder: string): string {
  const name = basename(resolve(folder))
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+/, '')
    .slice(0, 214)
  return name || 'my-agent'
}

/**
 * Makes the agent's folder from the template. It refuses a folder that already holds anything, so
 * it never writes over someone's work.
 */
export function createAgentFolder(
  folder: string,
  template: string = TEMPLATE_DIR,
  name: string = DEFAULT_NAME,
): string {
  const target = resolve(folder)
  if (existsSync(target) && readdirSync(target).length > 0) {
    throw new Error(`${folder} already exists and isn't empty. Pick another name.`)
  }
  const business = businessFile(template, name)
  mkdirSync(target, { recursive: true })
  for (const [from, to] of Object.entries(COPIED))
    copyFileSync(join(template, from), join(target, to))
  writeFileSync(join(target, 'business.ts'), business)
  const manifest = JSON.parse(readFileSync(join(template, 'package.json'), 'utf8')) as object
  writeFileSync(
    join(target, 'package.json'),
    `${JSON.stringify({ ...manifest, name: packageName(folder) }, null, 2)}\n`,
  )
  return target
}

/** Runs npm in the folder, with the npm that started this command when there is one. */
function npm(args: readonly string[], options: SpawnOptions) {
  const own = process.env.npm_execpath
  return own && /npm-cli\.[cm]?js$/.test(own)
    ? spawn(process.execPath, [own, ...args], options)
    : spawn('npm', [...args], { ...options, shell: process.platform === 'win32' })
}

/** Waits for a process to end, and gives its exit code. */
function ended(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((done) => {
    child.on('error', () => done(1))
    child.on('close', (code) => done(code ?? 1))
  })
}

/** Runs `npm install` in the folder, quietly, and gives what it printed when it fails. */
export async function install(target: string): Promise<{ ok: boolean; output: string }> {
  const child = npm(['install', '--no-audit', '--no-fund'], {
    cwd: target,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
  return { ok: (await ended(child)) === 0, output }
}

/** What the command line asks for. */
export interface CreateArgs {
  folder: string
  /** The business's name when it was given, so nothing asks for it. */
  name: string | null
  install: boolean
  /** Whether setup runs in the folder once it's made, which needs its packages. */
  start: boolean
}

/** What `create-avow-agent --help` prints. */
export const HELP = `create-avow-agent [folder] [--name <business>] [--no-install] [--no-start]

Makes a folder holding an Avow sandbox agent, installs its packages, and sets up its business on
Tempo's Moderato testnet with test dollars.

  folder           where to make it, my-agent by default
  --name <name>    the business's name, so nothing asks for it
  --no-install     stop once the folder is made
  --no-start       stop once its packages are installed`

/** `create-avow-agent [folder] [--name <business>] [--no-install] [--no-start]` */
export function parseArgs(args: readonly string[]): CreateArgs {
  let folder: string | null = null
  let name: string | null = null
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string
    if (arg === '--name') {
      name = args[i + 1] ?? null
      i += 1
    } else if (arg.startsWith('--name=')) name = arg.slice('--name='.length)
    else if (!arg.startsWith('-')) folder ??= arg
  }
  const install = !args.includes('--no-install')
  return {
    folder: folder ?? 'my-agent',
    name,
    install,
    start: install && !args.includes('--no-start'),
  }
}

/** Asks for the business's name on the rail, and takes the default for an empty answer. */
async function askName(rail: Rail, paint: ReturnType<typeof stylesOf>): Promise<string> {
  rail.ask(`Name your sandbox business, or press Enter for ${DEFAULT_NAME}`)
  const lines = createInterface({ input: process.stdin, output: process.stdout, historySize: 0 })
  try {
    for (;;) {
      const answer = await new Promise<string | null>((done) => {
        lines.once('close', () => done(null))
        lines.question(rail.prefix, done)
      })
      if (answer === null) throw new Error('No name was given.')
      if (answer.trim() === '') {
        rail.answered(DEFAULT_NAME)
        return DEFAULT_NAME
      }
      try {
        businessFile(TEMPLATE_DIR, answer)
        return answer.trim()
      } catch (error) {
        rail.answered(paint.bad(error instanceof Error ? error.message : String(error)))
      }
    }
  } finally {
    lines.close()
  }
}

/**
 * Draws Avow's banner and opens the rail, makes the folder and installs its packages while asking
 * the business's name, then runs setup in it, which carries the same rail on. It waits for setup
 * to end, so a Ctrl+C there stops setup, and then says where the folder is.
 */
export async function main(argv: readonly string[]): Promise<number> {
  const major = Number(process.versions.node.split('.')[0])
  if (major < 20) {
    console.error(`The starter needs Node 20 or later, and this is Node ${process.versions.node}.`)
    return 1
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP)
    return 0
  }
  const args = parseArgs(argv)
  const look = lookOf(process.stdout)
  const paint = stylesOf(look)
  const rail = new Rail(look)
  console.log(banner(look))
  rail.open(`Make ${args.folder}`)
  let target: string
  try {
    target = createAgentFolder(args.folder, TEMPLATE_DIR, args.name ?? DEFAULT_NAME)
  } catch (error) {
    rail.fail(error instanceof Error ? error.message : String(error))
    return 1
  }
  // The packages install while the developer names the business, since neither needs the other.
  const began = Date.now()
  const installing = args.install ? install(target) : null
  if (args.name === null && process.stdin.isTTY) {
    const name = await askName(rail, paint)
    writeFileSync(join(target, 'business.ts'), businessFile(TEMPLATE_DIR, name))
  }
  rail.done(`Made ${args.folder}, with agent.ts, business.ts and a README`)
  if (!installing) {
    rail.close(`Install its packages, then set up its business:`)
    console.log(`      cd ${args.folder}\n      npm install\n      npm start\n`)
    return 0
  }
  rail.wait('Installing its packages')
  const installed = await installing
  if (!installed.ok) {
    rail.fail("npm install didn't finish. What it printed is below.")
    console.error(paint.dim(installed.output.trimEnd()))
    console.error(`\nRun npm install in ${args.folder}, then npm start.`)
    return 1
  }
  rail.done(`Installed its packages in ${Math.max(1, Math.round((Date.now() - began) / 1000))}s`)
  if (!args.start) {
    rail.close('Set up its business:')
    console.log(`      cd ${args.folder}\n      npm start\n`)
    return 0
  }
  // Setup reads the terminal itself. This process only waits, so Ctrl+C reaches setup alone.
  rail.settle()
  const ignore = () => {}
  process.on('SIGINT', ignore)
  const code = await ended(
    npm(['start', '--silent'], {
      cwd: target,
      stdio: 'inherit',
      env: { ...process.env, [RAIL_OPEN_ENV]: '1' },
    }),
  )
  process.off('SIGINT', ignore)
  console.log(
    paint.dim(`\n   Your agent is in ${args.folder}. Run npm start there to pick it up again.\n`),
  )
  return code === 130 ? 0 : code
}
