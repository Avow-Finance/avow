import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type InboxRead, listenFor } from '../sandbox/mailbox-context.js'
import type { Quoted } from '../sandbox/service-quoted.js'
import {
  countRead,
  countStep,
  LISTEN_EXIT,
  LISTEN_LOCK,
  type ListenDeps,
  newTally,
  outstandingOf,
  runListener,
  statusLine,
  stepLine,
  stopLines,
  takeListenLock,
} from './listen.js'

const folder = () => mkdtempSync(join(tmpdir(), 'a47-listen-'))

describe("a folder's listener lock", () => {
  it('is taken once, refused to a second live listener, and released by its owner', () => {
    const dir = folder()
    const first = takeListenLock(dir, { pid: 100, boot: 5, alive: () => true })
    expect(first.ok).toBe(true)
    expect(takeListenLock(dir, { pid: 200, boot: 5, alive: () => true })).toEqual({
      ok: false,
      pid: 100,
    })
    if (first.ok) first.release()
    expect(existsSync(join(dir, LISTEN_LOCK))).toBe(false)
    expect(takeListenLock(dir, { pid: 200, boot: 5, alive: () => true }).ok).toBe(true)
  })

  it('is taken over from a listener that no longer runs, or ran before the machine restarted', () => {
    const dir = folder()
    takeListenLock(dir, { pid: 100, boot: 5, alive: () => true })
    expect(takeListenLock(dir, { pid: 200, boot: 5, alive: () => false }).ok).toBe(true)
    expect(readFileSync(join(dir, LISTEN_LOCK), 'utf8')).toBe('200 5\n')
    // Process 200 seems to run, but the machine has started since it took the lock.
    expect(takeListenLock(dir, { pid: 300, boot: 9, alive: () => true }).ok).toBe(true)
  })

  it('is taken over from a file that does not read', () => {
    const dir = folder()
    writeFileSync(join(dir, LISTEN_LOCK), 'nonsense')
    expect(takeListenLock(dir, { pid: 1, boot: 1, alive: () => true }).ok).toBe(true)
  })

  it('is left alone on release once another listener has taken it over', () => {
    const dir = folder()
    const first = takeListenLock(dir, { pid: 100, boot: 5, alive: () => true })
    takeListenLock(dir, { pid: 200, boot: 5, alive: () => false })
    if (first.ok) first.release()
    expect(readFileSync(join(dir, LISTEN_LOCK), 'utf8')).toBe('200 5\n')
  })
})

describe("a listener's status", () => {
  it('counts quotes, acceptances and declines, and says when Avow last answered', () => {
    const tally = newTally(new Date('2026-11-28T10:00:00Z'))
    countStep(tally, { step: 'quoted' })
    countStep(tally, { step: 'accepted' })
    countStep(tally, { step: 'declined' })
    countStep(tally, { step: 'compute' })
    countRead(tally, { ok: true, orders: 2 }, new Date('2026-11-28T10:05:00Z'))
    expect(statusLine(tally)).toBe(
      'Listening since 10:00:00 UTC. 1 quoted, 1 accepted, 1 declined, 0 failed. Avow last answered at 10:05:00.',
    )
    countRead(tally, { ok: false, error: new Error('fetch failed') }, new Date())
    expect(statusLine(tally)).toContain(
      "Avow hasn't answered since 10:05:00, and it keeps trying (fetch failed)",
    )
  })

  it('names the reason code its buyer hears when a step declines', () => {
    expect(stepLine({ orderId: 'o1' }, { step: 'quoted' })).toBe('o1: quoted')
    expect(
      stepLine({ orderId: 'o1' }, { step: 'declined', decline: { reason: 'capacity.exhausted' } }),
    ).toBe('o1: declined with reason code capacity.exhausted')
  })

  it('hears every read of the inbox, a failed one included', async () => {
    const stop = new AbortController()
    const reads: boolean[] = []
    let calls = 0
    await listenFor({
      inbox: async () => {
        calls += 1
        if (calls === 1) throw new Error('down')
        stop.abort()
        return []
      },
      sell: async () => {},
      onRead: (read) => reads.push(read.ok),
      every: 1,
      signal: stop.signal,
    })
    expect(reads).toEqual([false, true])
  })
})

const quote = (q: Partial<Quoted> & { orderId: string }): Quoted => ({
  item: 'Transcript',
  at: 0n,
  until: 2_000n,
  accepted: false,
  hashes: [],
  sale: null,
  ...q,
})

describe('what still waits when a listener stops', () => {
  const outstanding = outstandingOf(
    [
      { orderId: 'new', status: 'requested' },
      { orderId: 'funded', status: 'reserved', reserve: { acceptBy: 1_900n } },
    ],
    [
      quote({ orderId: 'funded' }),
      quote({ orderId: 'waiting' }),
      quote({ orderId: 'lapsed', until: 500n }),
      quote({
        orderId: 'owed',
        accepted: true,
        sale: { units: 1, price: 1n, deliverBy: 9_000n },
      }),
      quote({ orderId: 'delivered', accepted: true, sale: { units: 1, price: 1n, deliverBy: 1n } }),
    ],
    1_000n,
  )

  it('sorts orders into ones to accept, to quote, waiting on the buyer, and owed', () => {
    expect(outstanding).toEqual({
      toQuote: ['new'],
      toAccept: [{ orderId: 'funded', acceptBy: 1_900n }],
      quoted: [{ orderId: 'waiting', item: 'Transcript', until: 2_000n }],
      owed: [{ orderId: 'owed', item: 'Transcript', deliverBy: 9_000n }],
    })
  })

  it('says why it stopped, what waits and how to resume', () => {
    const lines = stopLines(
      { code: 'listen.stopped', detail: 'It was asked to stop with SIGTERM.' },
      outstanding,
      '/srv/seller',
    ).join('\n')
    expect(lines).toContain('reason code listen.stopped')
    expect(lines).toContain('1 funded order waits for this business to accept')
    expect(lines).toContain('  funded, accept by 1970-01-01T00:31:40.000Z')
    expect(lines).toContain('1 new order waits for a quote')
    expect(lines).toContain('1 quote waits for the buyer to fund')
    expect(lines).toContain('1 accepted commitment stands')
    expect(lines).toContain('run npx avow-sandbox listen in /srv/seller')
  })

  it('says nothing waits when nothing does', () => {
    const none = { toQuote: [], toAccept: [], quoted: [], owed: [] }
    expect(stopLines({ code: 'listen.stopped', detail: '' }, none, '/f')).toContain(
      'Nothing waits on this business.',
    )
  })
})

/** A listener's world, with orders that take the steps given and stop when told. */
function world(o: {
  sells?: boolean
  steps?: { step: string; decline?: { reason: string } }[]
  fail?: Error
}) {
  const stop = new AbortController()
  const logs: string[] = []
  const errors: string[] = []
  let locked = false
  let released = false
  const services = {
    sells: o.sells ?? true,
    published: async () => [],
    inbox: async () => [{ orderId: 'new', status: 'requested' as const }],
    quotes: async () => [],
    sellerStanding: async () => ({ inForce: false as const, notice: 'No mandate.' }),
    listen: async (p: {
      onRead: (read: InboxRead) => void
      onStep: (order: { orderId: string }, step: { step: string }) => void
      onError: (order: { orderId: string }, error: unknown) => void
    }) => {
      p.onRead({ ok: true, orders: 1 })
      for (const step of o.steps ?? []) p.onStep({ orderId: 'o1' }, step)
      p.onError({ orderId: 'o2' }, new Error('Over capacity'))
      p.onError({ orderId: 'o2' }, new Error('Over capacity'))
      if (o.fail) throw o.fail
      stop.abort('SIGTERM')
    },
  }
  const mailbox = {
    businessId: 'biz_test',
    inbox: async () => [],
    listen: async () => {},
  }
  const deps = {
    folder: '/srv/seller',
    open: async () => ({ mailbox, services }),
    out: {
      log: (l: string) => logs.push(l),
      error: (l: string) => errors.push(l),
      status: () => {},
    },
    signal: stop.signal,
    lock: () => {
      locked = true
      return { ok: true as const, release: () => (released = true) }
    },
  } as unknown as ListenDeps
  return { deps, logs, errors, lock: () => ({ locked, released }) }
}

describe('a listener', () => {
  it('stops on a signal, then says why with what waits, and releases the folder', async () => {
    const w = world({
      steps: [{ step: 'quoted' }, { step: 'declined', decline: { reason: 'offer.withdrawn' } }],
    })
    const stop = await runListener(w.deps)
    expect(stop.code).toBe('listen.stopped')
    expect(LISTEN_EXIT[stop.code]).toBe(0)
    const said = w.logs.join('\n')
    expect(said).toContain('a test business that sells for test dollars')
    expect(said).toContain('o1: declined with reason code offer.withdrawn')
    expect(said).toContain('with SIGTERM')
    expect(said).toContain('1 new order waits for a quote')
    expect(w.errors).toEqual(['o2: Over capacity'])
    expect(w.lock()).toEqual({ locked: true, released: true })
  })

  it("stops with exit code 2 and takes no lock when the agent can't sell", async () => {
    const w = world({ sells: false })
    const stop = await runListener(w.deps)
    expect(stop.code).toBe('listen.not_seller')
    expect(LISTEN_EXIT[stop.code]).toBe(2)
    expect(w.logs.join('\n')).toContain('connect --sell')
    expect(w.lock().locked).toBe(false)
  })

  it('refuses to run beside another listener on the same folder', async () => {
    const w = world({})
    const stop = await runListener({ ...w.deps, lock: () => ({ ok: false, pid: 42 }) })
    expect(stop).toMatchObject({ code: 'listen.already_running' })
    expect(stop.detail).toContain('Process 42')
    expect(LISTEN_EXIT[stop.code]).toBe(2)
  })

  it('says why when it fails, so a process manager restarts it', async () => {
    const w = world({
      fail: new Error("The sandbox's services file holds something it can't read."),
    })
    const stop = await runListener(w.deps)
    expect(stop.code).toBe('listen.failed')
    expect(LISTEN_EXIT[stop.code]).toBe(1)
    expect(w.logs[w.logs.length - 1]).toContain('To resume')
    expect(w.lock().released).toBe(true)
  })
})
