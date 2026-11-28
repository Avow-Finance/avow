import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  judgeLock,
  LISTEN_LOCK,
  type LockFacts,
  type LockHolder,
  takeListenLock,
} from './listen-lock.js'

const made: string[] = []
const folder = () => {
  const dir = mkdtempSync(join(tmpdir(), 'avow-listen-lock-'))
  made.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const holder = (h: Partial<LockHolder> = {}): LockHolder => ({
  pid: 100,
  host: 'seller-box',
  boot: 'boot-a',
  start: '5000',
  ...h,
})

/** Facts for a process on seller-box, with the processes given running and their start times. */
const facts = (
  me: Partial<LockHolder> = {},
  running: Record<number, string | null> = {},
): LockFacts => ({
  me: holder({ pid: 200, start: '9000', ...me }),
  exists: (pid) => Object.hasOwn(running, pid),
  startOf: (pid) => running[pid] ?? null,
  nowMs: () => 1_000_000,
})

describe('judging a lock someone holds', () => {
  it('takes over from a holder that no longer runs', () => {
    expect(judgeLock(holder(), 0, facts())).toEqual({ take: true })
  })

  it('takes over when the id now belongs to a process that started at another time', () => {
    expect(judgeLock(holder(), 0, facts({}, { 100: '7777' }))).toEqual({ take: true })
  })

  it('refuses a holder that still runs, or whose start time it cannot read', () => {
    expect(judgeLock(holder(), 0, facts({}, { 100: '5000' }))).toMatchObject({ take: false })
    // EPERM, or a system with no process table to read, leaves it unknown, so it's refused.
    const unknown = judgeLock(holder(), 0, facts({}, { 100: null }))
    expect(unknown).toMatchObject({ take: false })
    if (!unknown.take) expect(unknown.why).toContain('another process now has its id')
  })

  it('refuses a lock from another machine or another boot, which it cannot see', () => {
    expect(judgeLock(holder({ host: 'other-box' }), 0, facts())).toMatchObject({ take: false })
    expect(judgeLock(holder({ boot: 'boot-b' }), 0, facts())).toMatchObject({ take: false })
  })

  it('counts a lock that does not read as one being written, for a moment', () => {
    expect(judgeLock(null, 999_000, facts())).toMatchObject({ take: false })
    expect(judgeLock(null, 0, facts())).toEqual({ take: true })
  })
})

describe("a folder's listener lock", () => {
  it('is taken once, refused to a second listener, and released by its owner', async () => {
    const dir = folder()
    const first = await takeListenLock(dir, facts({ pid: 100, start: '5000' }))
    expect(first.ok).toBe(true)
    const second = await takeListenLock(dir, facts({}, { 100: '5000' }))
    expect(second).toMatchObject({ ok: false, file: join(dir, LISTEN_LOCK) })
    if (first.ok) first.release()
    expect(existsSync(join(dir, LISTEN_LOCK))).toBe(false)
    expect((await takeListenLock(dir, facts())).ok).toBe(true)
  })

  it('is taken over in one rename from a holder that is gone, and kept', async () => {
    const dir = folder()
    await takeListenLock(dir, facts({ pid: 100, start: '5000' }))
    const taken = await takeListenLock(dir, facts())
    expect(taken.ok).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, LISTEN_LOCK), 'utf8'))).toMatchObject({ pid: 200 })
    expect(existsSync(join(dir, `${LISTEN_LOCK}.200.tmp`))).toBe(false)
  })

  it('is left alone on release once another listener has taken it over', async () => {
    const dir = folder()
    const first = await takeListenLock(dir, facts({ pid: 100, start: '5000' }))
    await takeListenLock(dir, facts())
    if (first.ok) first.release()
    expect(JSON.parse(readFileSync(join(dir, LISTEN_LOCK), 'utf8'))).toMatchObject({ pid: 200 })
  })

  it('waits on a lock that does not read yet, and takes it once it has been left that way', async () => {
    const dir = folder()
    const file = join(dir, LISTEN_LOCK)
    writeFileSync(file, '')
    const now = Date.now()
    const live = { ...facts(), nowMs: () => now }
    expect(await takeListenLock(dir, live)).toMatchObject({ ok: false })
    utimesSync(file, new Date(now - 60_000), new Date(now - 60_000))
    expect((await takeListenLock(dir, live)).ok).toBe(true)
  })
})
