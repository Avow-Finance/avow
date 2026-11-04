import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isSessionId, newSessionId } from '@avow-finance/spec'
import { type Address, isAddressEqual } from 'viem'
import { readSessionStanding } from '../sandbox/session.js'
import { takenUpTo } from './platform.js'

/** How long before Avow's relay closes a session the runner moves to a new one, in seconds. */
export const SESSION_MARGIN = 600n

/** The session the runner reports to. */
export interface RunnerSession {
  id: string
  /** Whether the session hasn't had the agent's authority yet, so the runner announces it. */
  fresh: boolean
  /** When Avow's relay stops taking the session's events, in unix seconds, or null while unknown. */
  endsAt: bigint | null
}

interface SessionOptions {
  /** The sandbox folder, `.avow` in the working directory. */
  dir: string
  apiUrl: string
  fetch?: typeof fetch
  now?: () => bigint
  log?: (line: string) => void
}

const systemClock = () => BigInt(Math.floor(Date.now() / 1000))

/** The session id kept in the sandbox folder, or null when there's none in the form it's kept. */
function keptId(dir: string): string | null {
  try {
    const { id } = JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8')) as { id?: unknown }
    return typeof id === 'string' && isSessionId(id) ? id : null
  } catch {
    return null
  }
}

/**
 * Keeps a session in the sandbox folder, with the runner's process id for the MCP server to find,
 * clears the run numbers of every other session, and goes on from the relay's last run.
 */
function useSession(dir: string, id: string, lastRun: number): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, 'session.json'), `${JSON.stringify({ id, pid: process.pid })}\n`, {
    mode: 0o600,
  })
  try {
    for (const name of readdirSync(join(dir, 'runs'))) {
      if (name !== id) rmSync(join(dir, 'runs', name), { recursive: true, force: true })
    }
  } catch {
    // No run has been numbered yet.
  }
  takenUpTo(dir, id, lastRun)
}

function newSession(dir: string): RunnerSession {
  const id = newSessionId()
  useSession(dir, id, 0)
  return { id, fresh: true, endsAt: null }
}

/**
 * The session the runner reports to, kept in the sandbox folder with the business, so the screen
 * a developer has open keeps working across restarts. A restart keeps it while Avow's relay holds
 * it for this business's account and takes its events for more than `SESSION_MARGIN`. The account
 * is the one the business's sealed key is bound to, so a session another business holds is never
 * kept. On a first run, after `npm run fresh`, or once a session has ended, it's a new session, and
 * the runner announces the agent's authority to it.
 */
export async function keepSession(
  m: SessionOptions & { account: Address | null },
): Promise<RunnerSession> {
  const now = m.now ?? systemClock
  const kept = keptId(m.dir)
  if (!kept || !m.account) return newSession(m.dir)
  const standing = await readSessionStanding({
    apiUrl: m.apiUrl,
    sessionId: kept,
    ...(m.fetch ? { fetch: m.fetch } : {}),
  }).catch(() => undefined)
  if (standing === undefined) {
    m.log?.("Avow's relay didn't say whether your session is still open, so the runner keeps it.")
    useSession(m.dir, kept, 0)
    return { id: kept, fresh: false, endsAt: null }
  }
  const ours =
    standing.business !== null &&
    isAddressEqual(standing.business.account, m.account) &&
    standing.endsAt !== null &&
    standing.endsAt > now() + SESSION_MARGIN
  if (!ours) return newSession(m.dir)
  useSession(m.dir, kept, standing.lastRun)
  return { id: kept, fresh: false, endsAt: standing.endsAt }
}

/**
 * The session for the next run, the same one until Avow's relay is about to stop taking its
 * events. Then it's a new one, which the runner announces the authority to again.
 */
export async function sessionForNextRun(
  session: RunnerSession,
  m: SessionOptions,
): Promise<RunnerSession> {
  const now = m.now ?? systemClock
  let { endsAt } = session
  if (endsAt === null) {
    const standing = await readSessionStanding({
      apiUrl: m.apiUrl,
      sessionId: session.id,
      ...(m.fetch ? { fetch: m.fetch } : {}),
    }).catch(() => undefined)
    endsAt = standing?.endsAt ?? null
  }
  if (endsAt !== null && endsAt <= now() + SESSION_MARGIN) return newSession(m.dir)
  return { ...session, endsAt }
}
