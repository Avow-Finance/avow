import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isSessionId } from '@avow-finance/spec'
import type { SandboxPlatform, SandboxStore } from '../sandbox/agent.js'

/** The folder in the working directory where the sandbox keeps its keys and its setup. */
export const SANDBOX_DIR = '.avow'

/** What the sandbox's folder tells git, so its keys stay out of every commit. */
const IGNORE_ALL = '# The sandbox keeps its keys here. Never commit them.\n*\n'

/**
 * A sandbox store in a folder on this machine. Each item is a JSON file only its owner can read,
 * written whole through a temporary file, and the folder ignores itself in git.
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

/** What the runner sets for each run of the agent it starts. */
export const RUNNER_ENV = {
  session: 'AVOW_SANDBOX_SESSION',
  run: 'AVOW_SANDBOX_RUN',
  prepare: 'AVOW_SANDBOX_PREPARE',
} as const

/**
 * The sandbox's defaults in Node. Keys and setup go in the working directory's `.avow` folder, and
 * a run the runner started reports to the session it opened. A run it started only to set up ends
 * once the agent's mandate is enrolled, before anything is booked.
 */
export const nodePlatform: SandboxPlatform = {
  store: () => fileStore(),
  session: () => {
    const id = process.env[RUNNER_ENV.session]
    const run = Number(process.env[RUNNER_ENV.run])
    return id && isSessionId(id) && Number.isInteger(run) && run > 0 ? { id, run } : null
  },
  ready: async () => {
    if (process.env[RUNNER_ENV.prepare] !== '1') return
    await new Promise<void>((resolve) => process.stdout.write('', () => resolve()))
    process.exit(0)
  },
}
