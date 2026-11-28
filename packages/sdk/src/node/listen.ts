import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { uptime } from 'node:os'
import { join } from 'node:path'
import { offerItemOf } from '@avow-finance/spec'
import { sandboxMailbox } from '../sandbox/mailbox.js'
import type { InboxRead } from '../sandbox/mailbox-context.js'
import type { Quoted } from '../sandbox/service-quoted.js'
import { SERVICE_ORDERS_UNSERVED, sandboxServices } from '../sandbox/services.js'
import { fileStore, SANDBOX_DIR } from './platform.js'

/**
 * `avow-sandbox listen`, the seller that quotes and accepts by rule. It reads the business's
 * inboxes every few seconds and takes each order's next step, within each offer's price and daily
 * capacity and, when one is in force, the seller's mandate its own agent holds it to. It keeps one
 * line saying where it stands, and when it stops it says why, what still waits and how to resume.
 *
 * It's safe to restart. Every quote is kept in `.avow` before it's sent and every acceptance is
 * read back from the lock, so a listener that starts again picks up where the last one stopped and
 * never quotes or accepts an order twice. Only one listener runs on a folder at a time, since the
 * day's capacity is counted in the folder.
 */

/** Why a listener stopped. */
export type ListenStopCode =
  /** Ctrl+C or a process manager asked it to stop. */
  | 'listen.stopped'
  /** The agent in this folder holds no signing key, so it can't quote or accept. */
  | 'listen.not_seller'
  /** Another listener already runs on this folder. */
  | 'listen.already_running'
  /** Something it couldn't carry on past, such as a folder it can't read. */
  | 'listen.failed'

export interface ListenStop {
  code: ListenStopCode
  /** What happened, in a sentence. */
  detail: string
}

/**
 * The exit code for each stop. A stop that a restart can't fix exits with 2, which the process
 * manager setups `sell keep-running` prints tell their manager not to restart.
 */
export const LISTEN_EXIT: Record<ListenStopCode, 0 | 1 | 2> = {
  'listen.stopped': 0,
  'listen.failed': 1,
  'listen.not_seller': 2,
  'listen.already_running': 2,
}

/** The file in `.avow` that says which process listens on the folder. */
export const LISTEN_LOCK = 'listen.lock'

/** When this machine last started, to the minute, so a lock left before a restart reads as stale. */
const bootMinute = () => Math.round((Date.now() / 1000 - uptime()) / 60)

/** Whether a process with this id runs, as far as this user can tell. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** What a lock file says, or null for one that doesn't read. */
function readLock(text: string): { pid: number; boot: number } | null {
  const [pid, boot] = text.trim().split(' ').map(Number)
  return Number.isSafeInteger(pid) && Number.isSafeInteger(boot)
    ? { pid: pid as number, boot: boot as number }
    : null
}

/**
 * Takes the folder's listener lock for this process. A lock left by a process that no longer runs,
 * or by one from before this machine last started, is taken over. Two listeners on one folder could
 * both take the day's last place, so a second one is refused with the id of the first.
 */
export function takeListenLock(
  dir: string,
  o: { pid?: number; boot?: number; alive?: (pid: number) => boolean } = {},
): { ok: true; release: () => void } | { ok: false; pid: number } {
  const pid = o.pid ?? process.pid
  const boot = o.boot ?? bootMinute()
  const alive = o.alive ?? isAlive
  const file = join(dir, LISTEN_LOCK)
  const mine = `${pid} ${boot}\n`
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  for (let tries = 0; tries < 2; tries += 1) {
    try {
      writeFileSync(file, mine, { flag: 'wx', mode: 0o600 })
      const release = () => {
        try {
          if (readFileSync(file, 'utf8') === mine) unlinkSync(file)
        } catch {
          // Already gone, which is what releasing wants.
        }
      }
      return { ok: true, release }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    let held: { pid: number; boot: number } | null = null
    try {
      held = readLock(readFileSync(file, 'utf8'))
    } catch {
      // Removed between the write and the read, so the next try takes it.
      continue
    }
    // Boot times read to the minute, so a minute either way is the same start.
    const live = held && held.pid !== pid && Math.abs(held.boot - boot) <= 1 && alive(held.pid)
    if (live) return { ok: false, pid: (held as { pid: number }).pid }
    try {
      unlinkSync(file)
    } catch {
      // Another listener took it over first, and the next try finds out.
    }
  }
  throw new Error(`Couldn't take ${file}, so this listener doesn't start.`)
}

/** What a listener has done since it started, and when Avow last answered it. */
export interface ListenTally {
  since: Date
  quoted: number
  accepted: number
  declined: number
  /** Steps that failed, counted once an order and reason. */
  failed: number
  lastAnswer: Date | null
  /** Why the latest read failed, or null when it didn't. */
  readError: string | null
}

export const newTally = (since: Date): ListenTally => ({
  since,
  quoted: 0,
  accepted: 0,
  declined: 0,
  failed: 0,
  lastAnswer: null,
  readError: null,
})

/** Counts one step a listener took. A step it doesn't know, such as a compute booking, isn't counted. */
export function countStep(tally: ListenTally, step: { step: string }): void {
  if (step.step === 'quoted') tally.quoted += 1
  else if (step.step === 'accepted') tally.accepted += 1
  else if (step.step === 'declined') tally.declined += 1
}

/** Records one read of an inbox. */
export function countRead(tally: ListenTally, read: InboxRead, at: Date): void {
  if (read.ok) {
    tally.lastAnswer = at
    tally.readError = null
  } else {
    tally.readError = read.error instanceof Error ? read.error.message : String(read.error)
  }
}

const clock = (d: Date) => d.toISOString().slice(11, 19)

/** The line a listener keeps up to date, in UTC times. */
export function statusLine(tally: ListenTally): string {
  const counts = `${tally.quoted} quoted, ${tally.accepted} accepted, ${tally.declined} declined, ${tally.failed} failed`
  const answer = tally.readError
    ? `Avow hasn't answered${tally.lastAnswer ? ` since ${clock(tally.lastAnswer)}` : ''}, and it keeps trying (${tally.readError})`
    : tally.lastAnswer
      ? `Avow last answered at ${clock(tally.lastAnswer)}`
      : 'Waiting for the first read'
  return `Listening since ${clock(tally.since)} UTC. ${counts}. ${answer}.`
}

/** An order waiting on this business as supplier, whichever kind of order it is. */
type Waiting = { orderId: string } & (
  | { status: 'requested' | 'expired' | 'quoted' | 'accepted' }
  | { status: 'reserved'; reserve: { acceptBy: bigint } }
)

/** What still waits when a listener stops, read from the inboxes and the folder. */
export interface Outstanding {
  /** New orders nobody has quoted. */
  toQuote: string[]
  /** Funded orders this business hasn't accepted, with the last moment it can. */
  toAccept: { orderId: string; acceptBy: bigint }[]
  /** Quotes the buyer hasn't funded, with the last moment the order can be accepted. */
  quoted: { orderId: string; item: string; until: bigint }[]
  /** Accepted orders not yet due, which this business has to deliver. */
  owed: { orderId: string; item: string; deliverBy: bigint | null }[]
}

/** What still waits, from the orders waiting on the business and the quotes the folder keeps. */
export function outstandingOf(
  waiting: readonly Waiting[],
  quotes: readonly Quoted[],
  now: bigint,
): Outstanding {
  const toQuote = waiting.filter((o) => o.status === 'requested').map((o) => o.orderId)
  const toAccept = waiting.flatMap((o) =>
    o.status === 'reserved' ? [{ orderId: o.orderId, acceptBy: o.reserve.acceptBy }] : [],
  )
  const funded = new Set(toAccept.map((o) => o.orderId))
  const quoted = quotes
    .filter((q) => !q.accepted && q.until > now && !funded.has(q.orderId))
    .map((q) => ({ orderId: q.orderId, item: q.item, until: q.until }))
  const owed = quotes
    .filter((q) => q.accepted && (q.sale === null || q.sale.deliverBy > now))
    .map((q) => ({ orderId: q.orderId, item: q.item, deliverBy: q.sale?.deliverBy ?? null }))
  return { toQuote, toAccept, quoted, owed }
}

const when = (seconds: bigint) => new Date(Number(seconds) * 1000).toISOString()

/** What a listener says when it stops: why, what still waits, and how to start it again. */
export function stopLines(
  stop: ListenStop,
  outstanding: Outstanding | { unread: string } | null,
  folder: string,
): string[] {
  const lines = [`The listener stopped with reason code ${stop.code}. ${stop.detail}`]
  if (outstanding && 'unread' in outstanding) {
    lines.push(`It couldn't read what still waits (${outstanding.unread}).`)
  } else if (outstanding) {
    const { toQuote, toAccept, quoted, owed } = outstanding
    if (toAccept.length > 0) {
      lines.push(
        `${toAccept.length} funded order${toAccept.length === 1 ? '' : 's'} wait${toAccept.length === 1 ? 's' : ''} for this business to accept. One not accepted in time sends its reserve back to the buyer.`,
        ...toAccept.map((o) => `  ${o.orderId}, accept by ${when(o.acceptBy)}`),
      )
    }
    if (toQuote.length > 0) {
      lines.push(
        `${toQuote.length} new order${toQuote.length === 1 ? '' : 's'} wait${toQuote.length === 1 ? 's' : ''} for a quote, and each lapses with nothing reserved if none comes.`,
        ...toQuote.map((id) => `  ${id}`),
      )
    }
    if (quoted.length > 0) {
      lines.push(
        `${quoted.length} quote${quoted.length === 1 ? '' : 's'} wait${quoted.length === 1 ? 's' : ''} for the buyer to fund. A listener has to be running to accept once one is funded.`,
        ...quoted.map((q) => `  ${q.orderId} for ${q.item}, until ${when(q.until)}`),
      )
    }
    if (owed.length > 0) {
      lines.push(
        `${owed.length} accepted commitment${owed.length === 1 ? '' : 's'} stand${owed.length === 1 ? 's' : ''}, and stopping the listener changes none of them. Deliver each by its deadline.`,
        ...owed.map(
          (o) =>
            `  ${o.orderId} for ${o.item}${o.deliverBy === null ? '' : `, deliver by ${when(o.deliverBy)}`}`,
        ),
      )
    }
    if (toAccept.length + toQuote.length + quoted.length + owed.length === 0) {
      lines.push('Nothing waits on this business.')
    }
  }
  if (stop.code === 'listen.not_seller') {
    lines.push(
      'Connect this agent to sell with npx avow-sandbox connect --sell, then start the listener again.',
    )
  } else if (stop.code === 'listen.already_running') {
    lines.push(
      `Stop the other listener first. If none runs, remove ${join(folder, SANDBOX_DIR, LISTEN_LOCK)} and start again.`,
    )
  } else {
    lines.push(
      `To resume, run npx avow-sandbox listen in ${folder}. Every quote and acceptance it made is kept in ${SANDBOX_DIR}, so it picks up where it stopped and takes no step twice.`,
    )
  }
  return lines
}

/** A step a listener took, as `listen` prints it. A decline names the reason its buyer hears. */
export function stepLine(
  order: { orderId: string },
  step: { step: string; decline?: { reason: string } },
): string {
  return step.decline
    ? `${order.orderId}: declined with reason code ${step.decline.reason}`
    : `${order.orderId}: ${step.step}`
}

/** Where a listener writes. A terminal keeps the status on one line, and a log gets it when it changes. */
export interface ListenOutput {
  log: (line: string) => void
  error: (line: string) => void
  /** Keeps the status line up to date. */
  status: (line: string) => void
}

/** How often a log that isn't a terminal hears the status when nothing has changed, in ms. */
const LOG_STATUS_EVERY = 15 * 60_000

/** Output to this process's terminal, or to a process manager's log when it isn't one. */
export function processOutput(tty = process.stdout.isTTY === true): ListenOutput {
  if (tty) {
    let shown = false
    const clear = () => {
      if (shown) process.stdout.write('\r\x1b[2K')
      shown = false
    }
    return {
      log: (line) => {
        clear()
        console.log(line)
      },
      error: (line) => {
        clear()
        console.error(line)
      },
      status: (line) => {
        clear()
        process.stdout.write(line.slice(0, Math.max(20, (process.stdout.columns ?? 120) - 1)))
        shown = true
      },
    }
  }
  let last = ''
  let at = 0
  return {
    log: (line) => console.log(line),
    error: (line) => console.error(line),
    status: (line) => {
      // The time Avow last answered changes every read, so only the rest of the line is compared.
      const gist = line.replace(/\d{2}:\d{2}:\d{2}/g, '')
      if (gist === last && Date.now() - at < LOG_STATUS_EVERY) return
      last = gist
      at = Date.now()
      console.log(line)
    },
  }
}

type Mailbox = Pick<Awaited<ReturnType<typeof sandboxMailbox>>, 'businessId' | 'listen' | 'inbox'>
type Services = Pick<
  Awaited<ReturnType<typeof sandboxServices>>,
  'sells' | 'listen' | 'inbox' | 'quotes' | 'published' | 'sellerStanding'
>

/** What a listener uses beyond its own logic, which a test replaces. */
export interface ListenDeps {
  /** The working folder, which holds `.avow`. */
  folder: string
  open: () => Promise<{ mailbox: Mailbox; services: Services }>
  out: ListenOutput
  /** Aborted with the name of the signal that asks the listener to stop. */
  signal: AbortSignal
  lock?: (dir: string) => ReturnType<typeof takeListenLock>
  now?: () => Date
}

/**
 * Runs a listener until it's asked to stop or can't carry on, and answers with why it stopped
 * after saying so, with what still waits.
 */
export async function runListener(deps: ListenDeps): Promise<ListenStop> {
  const now = deps.now ?? (() => new Date())
  const { out } = deps
  const { mailbox, services } = await deps.open()
  const finish = async (stop: ListenStop, read: boolean): Promise<ListenStop> => {
    let outstanding: Outstanding | { unread: string } | null = null
    if (read) {
      outstanding = await Promise.all([
        mailbox.inbox(),
        services.inbox().catch(() => []),
        services.quotes(),
      ]).then(
        ([jobs, orders, quotes]) =>
          outstandingOf(
            [...jobs, ...orders] as Waiting[],
            quotes,
            BigInt(Math.floor(now().getTime() / 1000)),
          ),
        (error: unknown) => ({ unread: error instanceof Error ? error.message : String(error) }),
      )
    }
    for (const line of stopLines(stop, outstanding, deps.folder)) out.log(line)
    return stop
  }
  if (!services.sells) {
    return finish(
      {
        code: 'listen.not_seller',
        detail:
          'The agent in this folder holds no signing key, so it can quote and accept nothing.',
      },
      false,
    )
  }
  const lock = (deps.lock ?? takeListenLock)(join(deps.folder, SANDBOX_DIR))
  if (!lock.ok) {
    return finish(
      {
        code: 'listen.already_running',
        detail: `Process ${lock.pid} already listens on this folder, and two listeners could both take the day's last place.`,
      },
      false,
    )
  }
  try {
    const offers = await services.published()
    // Asked once up front, so a sandbox that can't carry service orders is said and not polled.
    const unserved = await services.inbox().then(
      () => null,
      (error: unknown) =>
        error instanceof Error && error.message === SERVICE_ORDERS_UNSERVED ? error.message : null,
    )
    const selling = unserved
      ? `not for services. ${unserved}`
      : offers.length === 0
        ? 'for no services yet, since it has published no offers'
        : `for ${offers.map((v) => offerItemOf(v).name).join(', ')}`
    out.log(`Listening for orders to ${mailbox.businessId}, for jobs and ${selling}`)
    out.log(
      "This is a sandbox business on Tempo's Moderato testnet, a test business that sells for test dollars and isn't verified.",
    )
    // Said once up front, and read again before every quote and acceptance.
    if (!unserved) {
      out.log(
        await services.sellerStanding().then(
          (standing) => standing.notice,
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        ),
      )
    }
    out.log('Stop with Ctrl+C. A process manager stops it the same way.')
    const tally = newTally(now())
    // A step that fails is tried again on every read, so its reason is said once an order.
    const said = new Set<string>()
    const told = {
      signal: deps.signal,
      onStep: (
        order: { orderId: string },
        step: { step: string; decline?: { reason: string } },
      ) => {
        countStep(tally, step)
        out.log(stepLine(order, step))
        out.status(statusLine(tally))
      },
      onError: (order: { orderId: string }, error: unknown) => {
        const line = `${order.orderId}: ${error instanceof Error ? error.message : String(error)}`
        if (!said.has(line)) {
          tally.failed += 1
          out.error(line)
        }
        said.add(line)
      },
      onRead: (read: InboxRead) => {
        countRead(tally, read, now())
        out.status(statusLine(tally))
      },
    }
    out.status(statusLine(tally))
    try {
      await Promise.all([mailbox.listen(told), ...(unserved ? [] : [services.listen(told)])])
    } catch (error) {
      return await finish(
        {
          code: 'listen.failed',
          detail: error instanceof Error ? error.message : String(error),
        },
        true,
      )
    }
    const asked = deps.signal.reason
    return await finish(
      {
        code: 'listen.stopped',
        detail: `It was asked to stop${typeof asked === 'string' ? ` with ${asked}` : ''}, and took no step after that.`,
      },
      true,
    )
  } finally {
    lock.release()
  }
}

/** The signals that ask a listener to stop. Windows sends only the first. */
const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

/** `avow-sandbox listen` from a terminal or a process manager, which exits with the stop's code. */
export async function listenCommand(): Promise<void> {
  const stop = new AbortController()
  for (const name of STOP_SIGNALS) process.once(name, () => stop.abort(name))
  const store = fileStore()
  const folder = process.cwd()
  const ended = await runListener({
    folder,
    open: async () => {
      const [mailbox, services] = await Promise.all([
        sandboxMailbox({ store }),
        sandboxServices({ store }),
      ])
      return { mailbox, services }
    },
    out: processOutput(),
    signal: stop.signal,
  })
  process.exit(LISTEN_EXIT[ended.code])
}
