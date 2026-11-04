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
