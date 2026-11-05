import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { encodeData } from '../session/data.js'
import {
  type ReservedJob,
  readPolicy,
  readVerdict,
  type ServicePolicy,
  type Verdict,
} from '../session/service.js'
import type { ChildChain } from '../session/world.js'
import { childEnv, command } from './runner.js'

/**
 * Runs the developer's `service.ts` in a process of its own, the way the runner runs `agent.ts` and
 * reads `business.ts`. The process starts in a session of its own with no terminal, no input and
 * no `AVOW_` variable, and the business's and the agent's keys never reach it. It gets its job as a
 * file of public data and answers with one line of JSON, read here at the boundary, and nothing
 * else passes between the two.
 */

/** How long `checkBeforeWork` may take before the session gives up and starts nothing. */
const CHECK_TIMEOUT_MS = 60_000
/** How long reading the budget and the switch may take. */
const POLICY_TIMEOUT_MS = 30_000

/**
 * The module the child runs: the built one beside this one, or under a test running the sources,
 * the package's built one, which plain Node can run.
 */
function childModule(): string {
  const here = fileURLToPath(import.meta.url)
  const beside = here.replace(/service-process\.(ts|js)$/, 'service-child.js')
  const built = beside.replace(`${sep}src${sep}node${sep}`, `${sep}dist${sep}node${sep}`)
  return pathToFileURL(existsSync(beside) ? beside : built).href
}

/** Ends a child's whole process group, so nothing it left behind keeps running. */
function killGroup(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    // The group is already gone.
  }
}

/** Runs the child once with its input, and gives its one line of output or why there's none. */
async function runChild(
  file: string,
  cwd: string,
  input: unknown,
  timeoutMs: number,
): Promise<{ ok: true; json: unknown } | { ok: false; why: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'avow-service-'))
  try {
    const loader = join(dir, 'run.mjs')
    const inputPath = join(dir, 'input.json')
    writeFileSync(
      loader,
      'const [child, service, input] = process.argv.slice(2); const m = await import(child); await m.runServiceChild(service, input)\n',
    )
    writeFileSync(inputPath, encodeData(input))
    const serviceUrl = pathToFileURL(resolve(cwd, file)).href
    const [first, ...rest] = command(file, cwd)
    const args =
      first === file
        ? [loader, childModule(), serviceUrl, inputPath]
        : [first as string, loader, childModule(), serviceUrl, inputPath, ...rest.slice(1)]
    return await new Promise((done) => {
      const child = spawn(process.execPath, args, {
        cwd,
        env: childEnv(null),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
        windowsHide: true,
      })
      let output = ''
      let errors = ''
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        if (child.pid) killGroup(child.pid)
      }, timeoutMs)
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString()
      })
      child.stderr.on('data', (chunk: Buffer) => {
        errors += chunk.toString()
      })
      child.on('error', (error) => {
        errors += error.message
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (child.pid) killGroup(child.pid)
        if (timedOut)
          return done({ ok: false, why: `${file} took longer than ${timeoutMs / 1000} seconds` })
        const last = output.trim().split('\n').at(-1) ?? ''
        if (code !== 0 || !last) {
          const said = errors.trim().split('\n').slice(-3).join(' ').slice(0, 300)
          return done({ ok: false, why: `${file} stopped with an error${said ? `: ${said}` : ''}` })
        }
        try {
          done({ ok: true, json: JSON.parse(last) })
        } catch {
          done({ ok: false, why: `${file} answered with something that isn't JSON` })
        }
      })
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The budget and the compute switch in `service.ts`, read again on every call. */
export async function readServicePolicy(file: string, cwd = process.cwd()): Promise<ServicePolicy> {
  const answer = await runChild(file, cwd, { mode: 'policy' }, POLICY_TIMEOUT_MS)
  if (!answer.ok) throw new Error(`${answer.why}, so the session can't read its budget and switch.`)
  const policy = readPolicy(answer.json)
  if (!policy) throw new Error(`${file} gave a budget or a switch that doesn't read.`)
  return policy
}

/**
 * Runs `checkBeforeWork` in `service.ts` on a job the customer reserved for, and gives its verdict,
 * or why there's none. No verdict starts nothing.
 */
export async function runCheckBeforeWork(
  file: string,
  job: ReservedJob,
  chain: ChildChain,
  cwd = process.cwd(),
): Promise<Verdict | { failed: string }> {
  const answer = await runChild(file, cwd, { mode: 'check', job, chain }, CHECK_TIMEOUT_MS)
  if (!answer.ok) return { failed: `${answer.why}, so nothing was accepted and no work started.` }
  const verdict = readVerdict(answer.json)
  if (!verdict) {
    return {
      failed: `checkBeforeWork in ${file} gave a verdict that doesn't read, so nothing was accepted and no work started.`,
    }
  }
  return verdict
}
