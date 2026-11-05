import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isSessionId } from '@avow-finance/spec'
import type { SandboxPlatform } from '../sandbox/agent.js'
import type { SandboxStore } from '../sandbox/store.js'

/** The folder in the working directory where the sandbox keeps its keys and its setup. */
export const SANDBOX_DIR = '.avow'

/** What the sandbox's folder tells git, so nothing in it ever reaches a commit. */
const IGNORE_ALL = '# The sandbox keeps its keys here. Never commit them.\n*\n'

/**
 * A sandbox store in a folder on this machine. Each item is a JSON file only its owner can read,
 * written whole through a temporary file, and the folder ignores itself in git. The business's
 * root key in it is sealed under the passphrase, so reading the folder doesn't give the key.
 */
export function fileStore(dir: string = join(process.cwd(), SANDBOX_DIR)): SandboxStore {
  const file = (item: string) => join(dir, `${item}.json`)
  return {
    async read(item) {
      try {
        return await readFile(file(item), 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    },
    async write(item, text) {
      await mkdir(dir, { recursive: true, mode: 0o700 })
      await writeFile(join(dir, '.gitignore'), IGNORE_ALL, { flag: 'wx' }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error
        },
      )
      const temporary = `${file(item)}.${process.pid}.tmp`
      await writeFile(temporary, text, { mode: 0o600 })
      await rename(temporary, file(item))
    },
  }
}

/** What the runner sets for each run of the agent it starts, and nothing else of its own. */
export const RUNNER_ENV = {
  session: 'AVOW_SANDBOX_SESSION',
  run: 'AVOW_SANDBOX_RUN',
} as const

function runsDir(dir: string, session: string): string {
  if (!isSessionId(session)) throw new RangeError(`${session} isn't a session id`)
  return join(dir, 'runs', session)
}

/** The highest run number taken in a session so far, or 0 when none is. */
export function latestRun(dir: string, session: string): number {
  try {
    const taken = readdirSync(runsDir(dir, session)).map(Number).filter(Number.isSafeInteger)
    return Math.max(0, ...taken)
  } catch {
    return 0
  }
}

/**
 * Marks every run number up to `run` as taken in a session, so a session kept across a restart
 * goes on from the last run Avow's relay holds, even when this folder lost its own count.
 */
export function takenUpTo(dir: string, session: string, run: number): void {
  if (run < 1 || latestRun(dir, session) >= run) return
  const runs = runsDir(dir, session)
  mkdirSync(runs, { recursive: true, mode: 0o700 })
  writeFileSync(join(runs, String(run)), '', { mode: 0o600 })
}

/**
 * Takes the next run number in a session, in the sandbox folder `dir`. The runner and the MCP
 * server both start runs, and the screen tells runs apart by number, so each claims its number by
 * creating a file named for it, which only one process can create. A restarted MCP server goes on
 * from the numbers already taken.
 */
export function takeRun(dir: string, session: string): number {
  const runs = runsDir(dir, session)
  mkdirSync(runs, { recursive: true, mode: 0o700 })
  for (let run = latestRun(dir, session) + 1; ; run += 1) {
    try {
      writeFileSync(join(runs, String(run)), '', { flag: 'wx', mode: 0o600 })
      return run
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
}

/**
 * The sandbox's defaults in Node. Everything goes in the working directory's `.avow` folder, and a
 * run the runner started reports to the session it opened.
 */
export const nodePlatform: SandboxPlatform = {
  store: () => fileStore(),
  session: () => {
    const id = process.env[RUNNER_ENV.session]
    const run = Number(process.env[RUNNER_ENV.run])
    return id && isSessionId(id) && Number.isInteger(run) && run > 0 ? { id, run } : null
  },
}
