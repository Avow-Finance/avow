import { offerVersionId, type ServiceOfferVersion } from '@avow-finance/spec'
import { describe, expect, it } from 'vitest'
import { SellerMandateRefusal } from '../sandbox/seller-mandate.js'
import { OFFER_LISTINGS_UNTAKEN, type ServiceOfferDraft } from '../sandbox/services.js'
import {
  keepRunningText,
  missingFlags,
  readKeepRunningArgs,
  readSellSetupArgs,
  type SellSetupDeps,
  sellSetup,
} from './sell-setup.js'

const FLAGS = [
  '--name',
  'Transcript',
  '--summary',
  'One hour of audio transcribed into English text',
  '--evidence',
  'The transcript is delivered as a text file',
  '--price',
  '50',
  '--late-cancellation',
  '20',
  '--no-show',
  '50',
  '--per-day',
  '4',
]

describe("sell setup's flags", () => {
  it('read the offer and the switches that stand alone', () => {
    const read = readSellSetupArgs([...FLAGS, '--list-with-avow', '--no-listen', '--yes'])
    expect(read).toMatchObject({
      input: { name: 'Transcript', price: 50, per_day: 4, no_show_percent: 50 },
      listWithAvow: true,
      listen: false,
      yes: true,
    })
    expect(readSellSetupArgs(FLAGS)).toMatchObject({ listWithAvow: null, listen: true, yes: false })
  })

  it('refuse a flag they do not know, and both answers to listing', () => {
    expect(readSellSetupArgs(['--colour', 'red'])).toEqual({
      error: "sell setup doesn't take --colour",
    })
    expect(readSellSetupArgs(['--list-with-avow', '--no-list-with-avow'])).toHaveProperty('error')
  })

  it('name every answer still missing, daily capacity and both charges included', () => {
    expect(missingFlags({ name: 'Transcript', price: 50 })).toEqual([
      '--summary',
      '--evidence',
      '--late-cancellation',
      '--no-show',
      '--per-day',
    ])
  })
})

/** A seller's world, with what it published, wrote and listed, and what it was told. */
function world(o: {
  sells?: boolean
  answers?: string[]
  refuse?: boolean
  lists?: 'untaken' | 'throws'
}) {
  const said: string[] = []
  const asked: string[] = []
  const published: ServiceOfferVersion[] = []
  const listed: string[] = []
  let listening = false
  const answers = [...(o.answers ?? [])]
  const deps: SellSetupDeps = {
    services: async () => ({
      businessId: 'biz_test',
      sells: o.sells ?? true,
      publish: async (draft: ServiceOfferDraft) => {
        if (o.refuse) throw new SellerMandateRefusal('seller_mandate.expired', 'offer')
        const version = { ...draft, supplier: 'biz_test' }
        published.push(version)
        return { version, id: offerVersionId(version), standing: null }
      },
      listWithAvow: async (id) => {
        listed.push(id)
        if (o.lists === 'throws') throw new Error('Avow refused it.')
        return { ok: false, reason: 'offer.listing_unavailable', notice: OFFER_LISTINGS_UNTAKEN }
      },
    }),
    ask: o.answers
      ? async (question) => {
          asked.push(question)
          return answers.shift() ?? null
        }
      : null,
    writeOffer: () => '/srv/seller/transcript.offer.json',
    log: (line) => said.push(line),
    listen: async () => {
      listening = true
    },
  }
  return { deps, said, asked, published, listed, listening: () => listening }
}

const ask = (args: string[]) => {
  const read = readSellSetupArgs(args)
  if ('error' in read) throw new Error(read.error)
  return read
}

describe('sell setup', () => {
  it('publishes from flags where nobody can type, says it sells by rule, and starts listening', async () => {
    const w = world({})
    const end = await sellSetup(ask(FLAGS), w.deps)
    expect(end).toEqual({ ok: true, published: true })
    expect(w.published[0]?.rules).toMatchObject({
      dailyCapacity: 4,
      lateCancellationBps: 2_000,
      noShowBps: 5_000,
    })
    const text = w.said.join('\n')
    expect(text).toContain('a test business that sells for test dollars')
    expect(text).toContain('within this price and 4 orders a day, without asking you')
    expect(text).toContain('/srv/seller/transcript.offer.json')
    expect(text).toContain('sell keep-running')
    // Listing is asked for, and nobody was there to ask.
    expect(w.listed).toEqual([])
    expect(w.listening()).toBe(true)
  })

  it('names the flags it needs when nobody can answer its questions', async () => {
    const w = world({})
    const end = await sellSetup(ask(['--name', 'Transcript']), w.deps)
    expect(end).toMatchObject({ ok: false, exitCode: 1 })
    if (!end.ok) expect(end.error).toContain('--late-cancellation, --no-show, --per-day')
    expect(w.published).toEqual([])
  })

  it('asks for what flags left out, again when an answer does not read, then publishes once confirmed', async () => {
    const w = world({
      answers: [
        'One hour of audio transcribed into English text',
        'The transcript is delivered as a text file',
        'fifty',
        '50',
        '20',
        '150',
        '50',
        '0',
        '4',
        'y',
        'n',
      ],
    })
    const end = await sellSetup(ask(['--name', 'Transcript', '--no-listen']), w.deps)
    expect(end).toEqual({ ok: true, published: true })
    expect(w.asked.filter((q) => q.startsWith('The price'))).toHaveLength(2)
    expect(w.asked.at(-2)).toContain('Publish this offer?')
    expect(w.asked.at(-1)).toContain("List it in Avow's directory too?")
    expect(w.published[0]?.unitPrice).toBe(50_000_000n)
    expect(w.listening()).toBe(false)
  })

  it('publishes nothing when the answer to publishing is no', async () => {
    const w = world({ answers: ['no'] })
    expect(await sellSetup(ask(FLAGS), w.deps)).toEqual({ ok: true, published: false })
    expect(w.published).toEqual([])
    expect(w.listening()).toBe(false)
  })

  it('says plainly that Avow lists nothing yet, and sells the offer anyway', async () => {
    const w = world({ lists: 'untaken' })
    await sellSetup(ask([...FLAGS, '--list-with-avow']), w.deps)
    expect(w.said).toContain(OFFER_LISTINGS_UNTAKEN)
    expect(w.listening()).toBe(true)
  })

  it('carries on without a listing when Avow refuses one', async () => {
    const w = world({ lists: 'throws' })
    await sellSetup(ask([...FLAGS, '--list-with-avow']), w.deps)
    expect(w.said.join('\n')).toContain('Not listed with Avow. Avow refused it.')
    expect(w.listening()).toBe(true)
  })

  it("stops with exit code 2 when the seller's mandate refuses the offer", async () => {
    const w = world({ refuse: true })
    const end = await sellSetup(ask(FLAGS), w.deps)
    expect(end).toMatchObject({ ok: false, exitCode: 2 })
    if (!end.ok) expect(end.error).toContain('seller_mandate.expired')
    expect(w.listening()).toBe(false)
  })

  it('stops with exit code 2 when the agent holds no signing key', async () => {
    const w = world({ sells: false })
    const end = await sellSetup(ask(FLAGS), w.deps)
    expect(end).toMatchObject({ ok: false, exitCode: 2 })
    if (!end.ok) expect(end.error).toContain('connect --sell')
  })
})

describe('keeping the listener running', () => {
  it('leaves pm2 and systemd stopped after a stop a restart cannot fix', () => {
    const pm2 = keepRunningText('pm2', "/srv/Bob's seller", '/usr/bin').join('\n')
    expect(pm2).toContain(
      "--cwd '/srv/Bob'\\''s seller' --stop-exit-codes 0 2 -- avow-sandbox listen",
    )
    expect(pm2).toContain('avow-seller-bob-s-seller')
    const systemd = keepRunningText('systemd', '/srv/seller', '/usr/bin').join('\n')
    expect(systemd).toContain('Restart=on-failure')
    expect(systemd).toContain('RestartPreventExitStatus=2')
    expect(systemd).toContain('WorkingDirectory=/srv/seller')
  })

  it('writes a launchd plist with the folder escaped', () => {
    const plist = keepRunningText('launchd', '/Users/a&b/seller', '/usr/bin').join('\n')
    expect(plist).toContain('<string>/Users/a&amp;b/seller</string>')
    expect(plist).toContain('<key>SuccessfulExit</key><false/>')
  })

  it('takes one of the managers it knows', () => {
    expect(readKeepRunningArgs(['systemd'])).toEqual({ manager: 'systemd' })
    expect(readKeepRunningArgs(['forever'])).toHaveProperty('error')
    expect(readKeepRunningArgs(['pm2', 'extra'])).toHaveProperty('error')
  })
})
