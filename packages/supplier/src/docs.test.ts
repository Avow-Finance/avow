import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeWebhookSecret } from './signature.js'
import type { Booking } from './store.js'
import { agreedBooking, tempStore } from './test/fixtures.js'
import { bookingEvent, Outbox, WEBHOOK_EVENTS, webhookSender } from './webhook.js'

// The reference page has to name the adapter as it is, so these tests read it and compare what it
// shows with the built command, the webhook and the settings.

const PAGE = readFileSync(
  join(import.meta.dirname, '../../../fern/docs/pages/supplier-adapter.mdx'),
  'utf8',
)
const MAIN = join(import.meta.dirname, '..', 'dist', 'main.js')
const SETTINGS_SOURCE = readFileSync(join(import.meta.dirname, 'settings.ts'), 'utf8')

/** The page's text from a heading to the next heading of the same level or higher. */
function section(heading: string): string {
  const level = /^#+/.exec(heading)?.[0].length ?? 2
  const start = PAGE.indexOf(`\n${heading}\n`)
  expect(start, `the page should have the heading ${heading}`).toBeGreaterThan(-1)
  const rest = PAGE.slice(start + heading.length + 2)
  const next = rest.search(new RegExp(`^#{1,${level}} `, 'm'))
  return next === -1 ? rest : rest.slice(0, next)
}

/** The first cell of each table row in a section, when it's one name in backticks. */
const firstCells = (text: string, name: RegExp) =>
  [...text.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1] as string).filter((n) => name.test(n))

const stateDir = mkdtempSync(join(tmpdir(), 'avow-supplier-docs-'))
afterAll(() => rmSync(stateDir, { recursive: true, force: true }))

/**
 * Runs the built command with no settings but a state directory of its own and an RPC nobody
 * answers, so no command reaches the network, `serve` stops for its missing settings and `init`
 * stops once the faucet can't be reached.
 */
const run = (...args: string[]): Promise<{ status: number | null; stderr: string }> =>
  new Promise((resolve) => {
    execFile(
      process.execPath,
      [MAIN, ...args],
      {
        env: { PATH: process.env.PATH, STATE_DIR: stateDir, RPC_URL: 'http://127.0.0.1:9' },
        encoding: 'utf8',
        timeout: 60_000,
      },
      (error, _stdout, stderr) => {
        const code = (error as { code?: unknown } | null)?.code
        resolve({ status: error ? (typeof code === 'number' ? code : null) : 0, stderr })
      },
    )
  })

/** The commands and each one's flags, as the command's own usage line names them. */
async function usage(): Promise<Map<string, string[]>> {
  const result = await run()
  expect(result.status).toBe(2)
  const line = result.stderr.trim()
  expect(line).toMatch(/^Usage: avow-supplier /)
  return new Map(
    line
      .slice('Usage: avow-supplier '.length)
      .split(' | ')
      .map((part) => {
        const [command, ...rest] = part.split(' ')
        return [command as string, rest.flatMap((w) => /--[a-z-]+/.exec(w)?.[0] ?? [])]
      }),
  )
}

/**
 * Every adapter command the page runs, with the flags it shows on that line. The buyer quickstart's
 * commands share the `node dist/main.js` form, so a code block that changes into its folder, and any
 * line that names the folder, are left out.
 */
function pageCommands(): { command: string; flags: string[] }[] {
  const lines = PAGE.split(/^```/m).flatMap((part, i) =>
    i % 2 === 1 && /^cd examples\/buyer$/m.test(part) ? [] : part.split('\n'),
  )
  return lines
    .filter((line) => !line.includes('examples/buyer'))
    .flatMap((line) => [
      ...line.matchAll(/(?:node dist\/main\.js|avow-supplier) ([a-z-]+)([^`|]*)/g),
    ])
    .map((m) => ({
      command: m[1] as string,
      flags: [...(m[2] ?? '').matchAll(/--[a-z-]+/g)].map(String),
    }))
}

describe('the supplier adapter reference', () => {
  let commands = new Map<string, string[]>()
  beforeAll(async () => {
    commands = await usage()
  }, 60_000)

  it('runs only commands and flags the adapter has, and shows every command', () => {
    const shown = pageCommands()
    for (const { command, flags } of shown) {
      expect([...commands.keys()], `the page runs ${command}`).toContain(command)
      for (const flag of flags) expect(commands.get(command)).toContain(flag)
    }
    const table = firstCells(section('## Commands'), /^[a-z-]+$/)
    expect(new Set(table)).toEqual(new Set(commands.keys()))
    for (const command of commands.keys()) {
      expect(shown.map((s) => s.command)).toContain(command)
    }
    // A flag the commands section names in prose belongs to a command too.
    const named = [...section('## Commands').matchAll(/`(--[a-z-]+)`/g)].map((m) => m[1])
    const known = [...commands.values()].flat()
    for (const flag of named) expect(known).toContain(flag)
  })

  it('names commands the built adapter runs, and flags it takes', {
    timeout: 120_000,
  }, async () => {
    const flagged = [...commands].flatMap(([command, flags]) => flags.map((f) => [command, f]))
    const [ran, unknown, withFlags] = await Promise.all([
      Promise.all([...commands.keys()].map(async (c) => ({ c, result: await run(c) }))),
      run('report', '--not-a-flag'),
      Promise.all(flagged.map(([c, f]) => run(c as string, f as string))),
    ])
    for (const { c, result } of ran) {
      expect(result.status, `${c} should run, ${result.stderr}`).not.toBe(2)
      expect(result.stderr).not.toMatch(/^Usage:/)
    }
    // An unknown flag is refused, so a flag that isn't refused is one the command takes.
    expect(unknown.stderr).toMatch(/report takes no --not-a-flag/)
    for (const result of withFlags) expect(result.stderr).not.toMatch(/takes no/)
  })

  it('lists the webhook events the adapter sends', () => {
    // The events table comes before the webhook's subsections.
    const intro = section('## The webhook').split('\n### ')[0] ?? ''
    const events = firstCells(intro, /^[a-z]+\.[a-z]+$/)
    expect(new Set(events)).toEqual(new Set(Object.values(WEBHOOK_EVENTS)))
  })

  it("shows an event's fields as the adapter writes them", () => {
    const booking = agreedBooking()
    const { status: _status, sent: _sent, ...record } = booking
    const accepted: Booking = {
      ...record,
      status: 'accepted',
      sent: { hash: `0x${'ab'.repeat(32)}`, validBefore: null },
    }
    const event = bookingEvent(accepted, new Date())
    const sample = [...PAGE.matchAll(/```json\n([\s\S]*?)```/g)]
      .map((m) => JSON.parse(m[1] as string))
      .find((json) => json.type === WEBHOOK_EVENTS.accepted)
    expect(Object.keys(sample).sort()).toEqual(Object.keys(event ?? {}).sort())
    expect(Object.keys(sample.data).sort()).toEqual(Object.keys(event?.data ?? {}).sort())
    const fields = firstCells(section('### The payload'), /^[a-zA-Z.]+$/)
    expect(new Set(fields)).toEqual(
      new Set([
        ...Object.keys(event ?? {}).filter((k) => k !== 'data'),
        ...Object.keys(event?.data ?? {}).map((k) => `data.${k}`),
      ]),
    )
  })

  it('names every header a delivery carries', async () => {
    const { store, remove } = tempStore()
    try {
      const outbox = new Outbox(store.dir, Date.now())
      const event = bookingEvent(agreedBooking(), new Date())
      if (event) outbox.add(event, Date.now())
      const sent: Record<string, string>[] = []
      await webhookSender({
        target: { url: 'https://bookings.example/avow', secret: makeWebhookSecret() },
        outbox,
        post: async (_url, init) => {
          sent.push(init.headers)
          return 200
        },
        nowMs: Date.now,
        log: () => {},
      })()
      expect(sent).toHaveLength(1)
      const headers = firstCells(section('### Checking the signature'), /^[a-z-]+$/)
      expect(new Set(headers)).toEqual(new Set(Object.keys(sent[0] ?? {})))
    } finally {
      remove()
    }
  })

  it('lists every setting the adapter reads, and none it lacks', () => {
    const read = new Set(
      [...SETTINGS_SOURCE.matchAll(/env\.([A-Z][A-Z_]+)|address\(env, '([A-Z][A-Z_]+)'/g)].map(
        (m) => (m[1] ?? m[2]) as string,
      ),
    )
    const listed = firstCells(section('## Settings'), /^[A-Z][A-Z_]+$/)
    expect(new Set(listed)).toEqual(read)
  })
})
