import {
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

/**
 * The lock that keeps a second `avow-sandbox listen` off a folder. The day's capacity is counted in
 * the folder, so two listeners could both take the last place. The lock covers listeners only: the
 * MCP server's `sell`, the SDK's `sell` and a `start` session take no lock.
 *
 * The lock names the process that holds it, the machine, the machine's boot and when the process
 * started, so a lock is taken over only when its holder is known to be gone. Anything less certain
 * is refused, with the way to clear it, so a listener never runs beside another.
 */

/** The file in `.avow` that says which listener holds the folder. */
export const LISTEN_LOCK = 'listen.lock'

/** How long a lock that doesn't read yet counts as one being written, in ms. */
const WRITING_GRACE_MS = 5_000

/** How long a listener that took over a lock waits before checking it kept it, in ms. */
const TAKEOVER_SETTLE_MS = 250

/** Who holds a lock. */
export interface LockHolder {
  pid: number
  host: string
  /** The machine's boot id, where the system has one. */
  boot: string | null
  /** When the process started, as the system counts it, where it can be read. */
  start: string | null
}

/** What a lock reads of this machine and its processes, which a test replaces. */
export interface LockFacts {
  me: LockHolder
  /** Whether a process with this id exists, owned by this user or another. */
  exists: (pid: number) => boolean
  /** When a process started, as `me.start` counts it, or null where that can't be read. */
  startOf: (pid: number) => string | null
  nowMs: () => number
}

/** The boot id Linux gives each start of the machine, or null elsewhere. */
function bootId(): string | null {
  try {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null
  } catch {
    return null
  }
}

/** When a process started, in clock ticks since boot, from Linux's process table, or null. */
function linuxStart(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // The command name can hold spaces and parentheses, so fields are counted after the last ')'.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    // Field 22 of the whole line, the start time, is the 20th after the name.
    return fields[19] ?? null
  } catch {
    return null
  }
}

function exists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists and belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The facts of this machine and process. */
export function machineFacts(): LockFacts {
  return {
    me: { pid: process.pid, host: hostname(), boot: bootId(), start: linuxStart(process.pid) },
    exists,
    startOf: linuxStart,
    nowMs: () => Date.now(),
  }
}

const lockText = (h: LockHolder) => `${JSON.stringify(h)}\n`

/** What a lock file says, or null for one that doesn't read. */
function readHolder(text: string): LockHolder | null {
  try {
    const h = JSON.parse(text) as Record<string, unknown>
    const nullable = (v: unknown) => v === null || typeof v === 'string'
    return Number.isSafeInteger(h.pid) &&
      typeof h.host === 'string' &&
      nullable(h.boot) &&
      nullable(h.start)
      ? (h as unknown as LockHolder)
      : null
  } catch {
    return null
  }
}

/**
 * Whether a lock can be taken over, or why it's refused. Only a holder known to be gone is taken
 * over: a process that no longer exists, or an id now used by a process that started at another
 * time. A lock from another machine or another boot of this one is refused, since this process
 * can't see whether its holder still runs.
 */
export function judgeLock(
  held: LockHolder | null,
  writtenMs: number,
  facts: LockFacts,
): { take: true } | { take: false; why: string } {
  const { me } = facts
  if (!held) {
    return facts.nowMs() - writtenMs < WRITING_GRACE_MS
      ? { take: false, why: 'Another listener is taking the folder right now.' }
      : { take: true }
  }
  if (held.host !== me.host) {
    return {
      take: false,
      why: `Process ${held.pid} on ${held.host} holds the folder, which another machine shares.`,
    }
  }
  if (held.boot !== null && me.boot !== null && held.boot !== me.boot) {
    return {
      take: false,
      why: `Process ${held.pid} took the folder before this machine last started, and never let it go.`,
    }
  }
  if (held.pid === me.pid || !facts.exists(held.pid)) return { take: true }
  const start = facts.startOf(held.pid)
  if (held.start !== null && start !== null && start !== held.start) return { take: true }
  return {
    take: false,
    why: `Process ${held.pid} holds the folder and still runs${held.start === null || start === null ? ', or another process now has its id' : ''}.`,
  }
}

/** A lock taken, or why it wasn't, with the file to remove once no listener runs. */
export type ListenLock =
  | { ok: true; release: () => void }
  | { ok: false; why: string; file: string }

/** Writes the lock in one step, so nobody reads it half written: a hard link, or else a fresh file. */
function create(file: string, temp: string, text: string): boolean {
  try {
    linkSync(temp, file)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST') return false
    if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EXDEV' && code !== 'ENOSYS') {
      throw error
    }
  }
  try {
    writeFileSync(file, text, { flag: 'wx', mode: 0o600 })
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
}

/**
 * Takes the folder's listener lock for this process, or answers with why not. A lock whose holder
 * is gone is replaced in one rename, and the listener reads it back a moment later, so of two that
 * take over at once only the one whose lock stands goes on.
 */
export async function takeListenLock(
  dir: string,
  facts: LockFacts = machineFacts(),
): Promise<ListenLock> {
  const file = join(dir, LISTEN_LOCK)
  const mine = lockText(facts.me)
  const release = () => {
    try {
      if (readFileSync(file, 'utf8') === mine) unlinkSync(file)
    } catch {
      // Already gone, which is what releasing wants.
    }
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const temp = join(dir, `${LISTEN_LOCK}.${facts.me.pid}.tmp`)
  writeFileSync(temp, mine, { mode: 0o600 })
  try {
    if (create(file, temp, mine)) return { ok: true, release }
    let text: string
    let writtenMs: number
    try {
      text = readFileSync(file, 'utf8')
      writtenMs = statSync(file).mtimeMs
    } catch {
      // Released between the two reads, so it's free to create.
      return create(file, temp, mine)
        ? { ok: true, release }
        : { ok: false, why: 'Another listener took the folder just now.', file }
    }
    const judged = judgeLock(readHolder(text), writtenMs, facts)
    if (!judged.take) return { ok: false, why: judged.why, file }
    writeFileSync(temp, mine, { mode: 0o600 })
    renameSync(temp, file)
    await sleep(TAKEOVER_SETTLE_MS)
    let kept = ''
    try {
      kept = readFileSync(file, 'utf8')
    } catch {
      // Gone again, which the check below treats as lost.
    }
    if (kept === mine) return { ok: true, release }
    return { ok: false, why: 'Another listener took the folder over at the same moment.', file }
  } finally {
    try {
      unlinkSync(temp)
    } catch {
      // Renamed into place, or never written.
    }
  }
}
