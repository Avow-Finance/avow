import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { SandboxSession } from '../sandbox/agent.js'
import type { SandboxBusinessConfig } from '../sandbox/setup.js'
import { RUNNER_ENV } from './platform.js'

/** How to run a file: TypeScript through the project's own tsx, JavaScript through Node. */
export function command(file: string, cwd: string = process.cwd()): string[] {
  if (!/\.[cm]?tsx?$/.test(file)) return [file]
  try {
    return [createRequire(join(cwd, 'package.json')).resolve('tsx/cli'), file]
  } catch {
    throw new Error(`Running ${file} needs tsx. Install it with npm install tsx.`)
  }
}

/**
 * The environment a child process gets. It's the runner's own, with every `AVOW_` variable taken
 * out and only the session and run put back. The business's passphrase and key are never in it.
 */
export function childEnv(session: SandboxSession | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith('AVOW_')) env[name] = value
  }
  if (session) {
    env[RUNNER_ENV.session] = session.id
    env[RUNNER_ENV.run] = String(session.run)
  }
  return env
}

/**
 * Runs the agent's file once in a process of its own, which reads only the agent's item and reports
 * to the session. It gets no input from the terminal, so it can never be asked for the passphrase.
 */
export function runAgent(
  file: string,
  session: SandboxSession | null,
  options: { cwd?: string; capture?: boolean } = {},
): Promise<{ code: number; output: string }> {
  const cwd = options.cwd ?? process.cwd()
  return new Promise((done) => {
    const child = spawn(process.execPath, command(file, cwd), {
      cwd,
      stdio: ['ignore', options.capture ? 'pipe' : 'inherit', 'inherit'],
      env: childEnv(session),
    })
    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.on('error', (error) => {
      console.error(error.message)
      done({ code: 1, output })
    })
    child.on('exit', (code) => done({ code: code ?? 1, output }))
  })
}

/**
 * Reads the business's config from its file, in a process of its own, so nothing in the file runs
 * where the business's key is ever opened. The file's default export is the config.
 */
export async function readBusinessConfig(
  file: string,
  cwd: string = process.cwd(),
): Promise<SandboxBusinessConfig> {
  const dir = mkdtempSync(join(tmpdir(), 'avow-business-'))
  const loader = join(dir, 'read.mjs')
  writeFileSync(
    loader,
    'const m = await import(process.argv[2]); process.stdout.write(JSON.stringify(m.default ?? null))\n',
  )
  const url = pathToFileURL(resolve(cwd, file)).href
  const [first, ...rest] = command(file, cwd)
  const args = first === file ? [loader, url] : [first as string, loader, url, ...rest.slice(1)]
  try {
    const text = await new Promise<string>((done, fail) => {
      const child = spawn(process.execPath, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'inherit'],
        env: childEnv(null),
      })
      let out = ''
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString()
      })
      child.on('error', fail)
      child.on('exit', (code) =>
        code === 0 ? done(out) : fail(new Error(`${file} didn't load, so nothing was signed.`)),
      )
    })
    const config: unknown = JSON.parse(text)
    if (typeof config !== 'object' || config === null) {
      throw new Error(`${file} has to export its business as its default export.`)
    }
    return config as SandboxBusinessConfig
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
