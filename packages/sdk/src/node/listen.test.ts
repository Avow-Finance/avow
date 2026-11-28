import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listenFor } from '../sandbox/mailbox-context.js'
import type { KeptJobSale } from '../sandbox/seller-sales.js'
import type { Quoted } from '../sandbox/service-quoted.js'
import { SERVICE_ORDERS_UNSERVED } from '../sandbox/services.js'
import {
  countRead,
  countStep,
  keptSales,
  LISTEN_EXIT,
  type ListenDeps,
  newTally,
  outstandingOf,
  runListener,
  statusLine,
  stepLine,
  stopLines,
} from './listen.js'
import { LISTEN_LOCK, machineFacts, takeListenLock } from './listen-lock.js'

const made: string[] = []
const folder = () => {
  const dir = mkdtempSync(join(tmpdir(), 'avow-listen-'))
  made.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
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

  it('takes no new step once it is asked to stop', async () => {
    const stop = new AbortController()
    const sold: string[] = []
    await listenFor({
      inbox: async () => [
        { orderId: 'first', status: 'requested' as const },
        { orderId: 'second', status: 'requested' as const },
      ],
      sell: async (order) => {
        sold.push(order.orderId)
        stop.abort('SIGTERM')
      },
      every: 1,
      signal: stop.signal,
    })
    expect(sold).toEqual(['first'])
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

const job = (j: Partial<KeptJobSale> & { orderId: string }): KeptJobSale => ({
  item: 'fine-tune',
  until: 2_000n,
  accepted: false,
  deliverBy: 5_000n,
  ...j,
})

const sales = (quotes: Quoted[], jobs: KeptJobSale[]) => keptSales(quotes, jobs)

describe('what still waits when a listener stops', () => {
  const outstanding = outstandingOf(
    [
      { orderId: 'new', status: 'requested' },
      { orderId: 'funded', status: 'reserved', reserve: { acceptBy: 1_900n } },
    ],
    sales(
      [
        quote({ orderId: 'funded' }),
        quote({ orderId: 'waiting' }),
        quote({ orderId: 'lapsed', until: 500n }),
        quote({
          orderId: 'owed',
          accepted: true,
          sale: { units: 1, price: 1n, deliverBy: 9_000n },
        }),
        quote({
          orderId: 'delivered',
          accepted: true,
          sale: { units: 1, price: 1n, deliverBy: 1n },
        }),
      ],
      [job({ orderId: 'job-quoted' }), job({ orderId: 'job-owed', accepted: true })],
    ),
    1_000n,
  )

  it('sorts services and jobs into ones to accept, to quote, waiting on the buyer, and owed', () => {
    expect(outstanding).toEqual({
      toQuote: ['new'],
      toAccept: [{ orderId: 'funded', acceptBy: 1_900n }],
      quoted: [
        { orderId: 'waiting', item: 'Transcript', until: 2_000n },
        { orderId: 'job-quoted', item: 'fine-tune', until: 2_000n },
      ],
      owed: [
        { orderId: 'owed', item: 'Transcript', deliverBy: 9_000n },
        { orderId: 'job-owed', item: 'fine-tune', deliverBy: 5_000n },
      ],
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
    expect(lines).toContain('2 quotes wait for the buyer to fund')
    expect(lines).toContain('2 accepted commitments stand')
    expect(lines).toContain('run npx avow-sandbox listen in /srv/seller')
  })

  it('says nothing waits when nothing does', () => {
    const none = { toQuote: [], toAccept: [], quoted: [], owed: [] }
    expect(stopLines({ code: 'listen.stopped', detail: '' }, none, '/f')).toContain(
      'Nothing waits on this business.',
    )
  })

  it("says it couldn't read what waits, and never that nothing does", () => {
    const lines = stopLines(
      { code: 'listen.stopped', detail: '' },
      { unread: 'fetch failed' },
      '/f',
    )
    expect(lines.join('\n')).toContain("couldn't read what still waits")
    expect(lines).not.toContain('Nothing waits on this business.')
  })
})

/**
 * A listener's world. Its services listen through the real `listenFor` over the orders given, and
 * the first order sold stops the listener, as a process manager's SIGTERM would.
 */
function world(o: {
  sells?: boolean
  steps?: { step: string; decline?: { reason: string } }[]
  folder?: string
  open?: () => Promise<never>
  stopRead?: Error
  realLock?: boolean
}) {
  const stop = new AbortController()
  const logs: string[] = []
  const errors: string[] = []
  const sold: string[] = []
  let locked = false
  let released = false
  let stopped = false
  const orders = [
    { orderId: 'o1', status: 'requested' as const },
    { orderId: 'o2', status: 'requested' as const },
  ]
  const services = {
    sells: o.sells ?? true,
    published: async () => [],
    inbox: async () => {
      if (stopped && o.stopRead) throw o.stopRead
      return orders
    },
    quotes: async () => [],
    sellerStanding: async () => ({ inForce: false as const, notice: 'No mandate.' }),
    listen: (p: Parameters<typeof listenFor>[0]) =>
      listenFor({
        ...p,
        inbox: services.inbox,
        every: 1,
        sell: async (order: { orderId: string }, onStep: (step: { step: string }) => void) => {
          sold.push(order.orderId)
          for (const step of o.steps ?? []) onStep(step)
          stopped = true
          stop.abort('SIGTERM')
          throw new Error('Over capacity')
        },
      }),
  }
  const mailbox = { businessId: 'biz_test', inbox: async () => [], listen: async () => {} }
  const jobSales = async () => [job({ orderId: 'job-owed', accepted: true, deliverBy: 10n ** 12n })]
  const deps = {
    folder: o.folder ?? '/srv/seller',
    open: o.open ?? (async () => ({ mailbox, services, jobSales })),
    out: {
      log: (l: string) => logs.push(l),
      error: (l: string) => errors.push(l),
      status: () => {},
    },
    signal: stop.signal,
    ...(o.realLock
      ? {}
      : {
          lock: async () => {
            locked = true
            return { ok: true as const, release: () => (released = true) }
          },
        }),
  } as unknown as ListenDeps
  return { deps, logs, errors, sold, lock: () => ({ locked, released }) }
}

describe('a listener', () => {
  it('stops on a signal after the step it was taking, says why with what waits, and lets the folder go', async () => {
    const w = world({
      steps: [{ step: 'quoted' }, { step: 'declined', decline: { reason: 'offer.withdrawn' } }],
    })
    const stop = await runListener(w.deps)
    expect(stop.code).toBe('listen.stopped')
    expect(LISTEN_EXIT[stop.code]).toBe(0)
    expect(w.sold).toEqual(['o1'])
    const said = w.logs.join('\n')
    expect(said).toContain('a test business that sells for test dollars')
    expect(said).toContain('o1: declined with reason code offer.withdrawn')
    expect(said).toContain('with SIGTERM. It finished the step it was taking and started no other.')
    expect(said).toContain('2 new orders wait for a quote')
    expect(said).toContain('job-owed for fine-tune')
    expect(w.errors).toEqual(['o1: Over capacity'])
    expect(w.lock()).toEqual({ locked: true, released: true })
  })

  it("says so when it can't read what waits as it stops", async () => {
    const w = world({ stopRead: new Error('fetch failed') })
    await runListener(w.deps)
    const said = w.logs.join('\n')
    expect(said).toContain("couldn't read what still waits")
    expect(said).not.toContain('Nothing waits')
  })

  it('reads a sandbox that carries no service orders as having none waiting', async () => {
    const w = world({ stopRead: new Error(SERVICE_ORDERS_UNSERVED) })
    await runListener(w.deps)
    expect(w.logs.join('\n')).toContain('job-owed for fine-tune')
  })

  it("stops with exit code 2 and takes no lock when the agent can't sell", async () => {
    const w = world({ sells: false })
    const stop = await runListener(w.deps)
    expect(stop.code).toBe('listen.not_seller')
    expect(LISTEN_EXIT[stop.code]).toBe(2)
    expect(w.logs.join('\n')).toContain('connect --sell')
    expect(w.lock().locked).toBe(false)
  })

  it('refuses to run beside another listener, and names the file to clear', async () => {
    const dir = folder()
    const first = world({ folder: dir, realLock: true })
    // The lock names a process that runs, this one's parent, as if another listener held it.
    const facts = machineFacts()
    const held = await takeListenLock(join(dir, '.avow'), {
      ...facts,
      me: { ...facts.me, pid: process.ppid, start: facts.startOf(process.ppid) },
    })
    expect(held.ok).toBe(true)
    const stop = await runListener(first.deps)
    expect(stop).toMatchObject({ code: 'listen.already_running' })
    expect(LISTEN_EXIT[stop.code]).toBe(2)
    expect(first.logs.join('\n')).toContain(`remove ${join(dir, '.avow', LISTEN_LOCK)}`)
  })

  it("fails with stop lines when it can't take the folder's lock", async () => {
    const dir = folder()
    // .avow is a file, so the lock can't be written in it.
    writeFileSync(join(dir, '.avow'), '')
    const w = world({ folder: dir, realLock: true })
    const stop = await runListener(w.deps)
    expect(stop.code).toBe('listen.failed')
    expect(LISTEN_EXIT[stop.code]).toBe(1)
    expect(stop.detail).toContain("couldn't take the folder's lock")
    expect(w.logs.at(-1)).toContain('To resume')
  })

  it("fails with stop lines when it can't open the folder", async () => {
    const w = world({
      open: async () => {
        throw new Error("The sandbox's services file holds something it can't read.")
      },
    })
    const stop = await runListener(w.deps)
    expect(stop.code).toBe('listen.failed')
    expect(stop.detail).toContain("couldn't open the folder")
    expect(w.logs.at(-1)).toContain('To resume')
  })
})
