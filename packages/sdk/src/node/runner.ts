import { spawn, spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { Writable } from 'node:stream'
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

/** The process groups the runner started, until each is gone. */
const groups = new Set<number>()

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

/** Whether any process the runner started, or one of theirs, is still alive. */
export function childrenAlive(): boolean {
  for (const pid of groups) {
    try {
      process.kill(process.platform === 'win32' ? pid : -pid, 0)
      return true
    } catch {
      groups.delete(pid)
    }
  }
  return false
}

/**
 * Waits for every process the runner started to be gone, and refuses when one outlives the wait.
 * The runner asks for the passphrase only after this. A process that left the group it was started
 * in isn't seen here, so `checkTerminal` looks for anything holding the terminal too.
 */
export async function ensureChildrenGone(waitMs = 2000): Promise<void> {
  const deadline = Date.now() + waitMs
  while (childrenAlive()) {
    for (const pid of groups) killGroup(pid)
    if (Date.now() > deadline) {
      throw new Error(
        "A process the agent started is still running, so the runner won't ask for the passphrase. Stop it, then press Enter again.",
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/** A process that has the runner's terminal open. */
export interface TerminalHolder {
  pid: number
  command: string
}

/** The device of the terminal the runner reads from, or null when it reads from something else. */
function terminalDevice(): string | null {
  if (!process.stdin.isTTY) return null
  const found = spawnSync('tty', [], { stdio: [0, 'pipe', 'ignore'], encoding: 'utf8' })
  const device = found.status === 0 ? found.stdout.trim() : ''
  return device.startsWith('/dev/') ? device : null
}

/** Each process on Linux this user can see, with its parent, its command and the files it holds. */
function linuxProcesses(): { pid: number; ppid: number; command: string; files: string[] }[] {
  return readdirSync('/proc')
    .filter((name) => /^\d+$/.test(name))
    .flatMap((name) => {
      try {
        const stat = readFileSync(`/proc/${name}/stat`, 'utf8')
        const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
        const command = readFileSync(`/proc/${name}/comm`, 'utf8').trim()
        let files: string[] = []
        try {
          files = readdirSync(`/proc/${name}/fd`).flatMap((fd) => {
            try {
              return [readlinkSync(`/proc/${name}/fd/${fd}`)]
            } catch {
              return []
            }
          })
        } catch {
          // Another user's process, whose files this user can't see.
        }
        return [{ pid: Number(name), ppid, command, files }]
      } catch {
        return []
      }
    })
}

/** Each process `ps` lists, with its parent and its command. */
function psProcesses(): { pid: number; ppid: number; command: string }[] | null {
  const listed = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,comm='], {
    stdio: ['ignore', 'pipe', 'ignore'],
    encoding: 'utf8',
  })
  if (listed.status !== 0) return null
  return listed.stdout.split('\n').flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), command: (m[3] ?? '').trim() }] : []
  })
}

/**
 * Every process apart from the runner and the ones that started it, such as npm and the shell, that
 * has the runner's terminal open. Any of them could read what's typed there. It's null when this
 * machine gives no way to tell, as on Windows, without a terminal, or without `lsof` outside Linux.
 */
export function otherTerminalHolders(): TerminalHolder[] | null {
  if (process.platform === 'win32') return null
  const device = terminalDevice()
  if (!device) return null
  let processes: { pid: number; ppid: number; command: string }[]
  let holders: number[]
  if (process.platform === 'linux') {
    const seen = linuxProcesses()
    processes = seen
    holders = seen.filter((p) => p.files.includes(device)).map((p) => p.pid)
  } else {
    const listed = psProcesses()
    const open = spawnSync('lsof', ['-t', device], {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    })
    // lsof answers 1 when nothing has the file open.
    if (!listed || open.error || (open.status !== 0 && open.status !== 1)) return null
    processes = listed
    holders = open.stdout.split('\n').flatMap((l) => (/^\d+$/.test(l.trim()) ? [Number(l)] : []))
  }
  const parent = new Map(processes.map((p) => [p.pid, p.ppid]))
  const allowed = new Set<number>()
  for (let pid: number | undefined = process.pid; pid && !allowed.has(pid); pid = parent.get(pid)) {
    allowed.add(pid)
  }
  const command = new Map(processes.map((p) => [p.pid, p.command]))
  return [...new Set(holders)]
    .filter((pid) => !allowed.has(pid))
    .map((pid) => ({ pid, command: command.get(pid) ?? 'unknown' }))
}

/**
 * Checks the terminal before the runner asks for the passphrase. It refuses while any process apart
 * from the runner and the ones that started it has the terminal open, and says so plainly where it
 * can't look. Nothing stops a program running as the developer from opening the terminal later, so
 * this closes what it can, and the business's key stays off the agent's machine in production.
 */
export function checkTerminal(log: (line: string) => void = console.log): void {
  const others = otherTerminalHolders()
  if (others === null) {
    log(
      "The runner can't see what else has this terminal open on this machine. Anything running as you can read what you type, so make sure nothing your agent started is still running.",
    )
    return
  }
  if (others.length > 0) {
    const named = others.map((p) => `${p.command} (process ${p.pid})`).join(', ')
    throw new Error(
      `${named} ${others.length === 1 ? 'has' : 'have'} this terminal open and could read what you type, so the runner won't ask for the passphrase. Stop ${others.length === 1 ? 'it' : 'them'}, or run npm start in a new terminal, then press Enter.`,
    )
  }
}

/**
 * Runs a file in a session of its own with no controlling terminal, its input closed and its output
 * passed through pipes, so the runner hands it no way to the terminal the passphrase is typed in.
 * Running as the developer, it could still open the terminal's device itself, which `checkTerminal`
 * looks for. Once it exits, its whole process group is ended.
 */
function runIsolated(
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; capture: boolean },
): Promise<{ code: number; output: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      windowsHide: true,
    })
    if (child.pid) groups.add(child.pid)
    let output = ''
    let code = 1
    child.stdout.on('data', (chunk: Buffer) => {
      if (options.capture) output += chunk.toString()
      else process.stdout.write(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk)
    })
    child.on('error', (error) => {
      process.stderr.write(`${error.message}\n`)
    })
    child.on('exit', (exitCode) => {
      code = exitCode ?? 1
      if (child.pid) killGroup(child.pid)
    })
    child.on('close', () => done({ code, output }))
  })
}

/**
 * Runs the agent's file once, isolated as `runIsolated` runs it, with only the session in its
 * environment. It reads the agent's item, and it gets no input, so it can't be asked for anything.
 */
export function runAgent(
  file: string,
  session: SandboxSession | null,
  options: { cwd?: string; capture?: boolean } = {},
): Promise<{ code: number; output: string }> {
  const cwd = options.cwd ?? process.cwd()
  return runIsolated(command(file, cwd), {
    cwd,
    env: childEnv(session),
    capture: options.capture ?? false,
  })
}

/**
 * Prompts on the terminal, a line at a time. A passphrase is typed with nothing shown, and no line
 * is kept in history, so no later prompt can bring one back.
 */
export function terminalPrompts(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
  tty: boolean = Boolean(process.stdin.isTTY),
) {
  let muted = false
  const shown = new Writable({
    write(chunk, encoding, done) {
      if (!muted) output.write(chunk, encoding)
      done()
    },
  })
  const lines = createInterface({ input, output: shown, terminal: tty, historySize: 0 })
  let closed = false
  const waiting = new Set<(line: string | null) => void>()
  lines.on('close', () => {
    closed = true
    for (const resolve of waiting) resolve(null)
  })
  const ask = (prompt: string, hidden = false) =>
    new Promise<string | null>((resolve) => {
      if (closed) return resolve(null)
      output.write(prompt)
      waiting.add(resolve)
      muted = hidden
      lines.question('', (answer) => {
        muted = false
        waiting.delete(resolve)
        if (hidden && tty) output.write('\n')
        resolve(answer)
      })
    })
  return { ask, history: () => [...((lines as unknown as { history?: string[] }).history ?? [])] }
}

/**
 * Reads the business's config from its file, isolated as the agent runs, so nothing in the file
 * runs where the business's key is ever opened. The file's default export is the config.
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
    const { code, output } = await runIsolated(args, { cwd, env: childEnv(null), capture: true })
    if (code !== 0) throw new Error(`${file} didn't load, so nothing was signed.`)
    const text = output
    const config: unknown = JSON.parse(text)
    if (typeof config !== 'object' || config === null) {
      throw new Error(`${file} has to export its business as its default export.`)
    }
    return config as SandboxBusinessConfig
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
