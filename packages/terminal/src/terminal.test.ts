import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BANNER,
  BANNER_WIDTH,
  banner,
  type Look,
  lookOf,
  Rail,
  setApart,
  visible,
  wrap,
} from './index.js'

const still = (width = 80): Look => ({ colors: 0, live: false, width })
const LOCK = '0x8684fEd14dC5733751C46640Db293c93f810AF31'
const COMMITMENT: `0x${string}` = `0x9f3c${'0'.repeat(56)}a1e2`
const REFERENCE = { chain: 42431, lock: LOCK, commitmentId: COMMITMENT, side: 'buyer' } as const
const recorder = () => {
  let out = ''
  return {
    write: (text: string) => {
      out += text
    },
    text: () => out,
  }
}

describe('a look', () => {
  it('takes colour on a terminal and none on a pipe, as NO_COLOR and FORCE_COLOR say', () => {
    const tty = { isTTY: true, columns: 100 }
    expect(lookOf(tty, { TERM: 'xterm-256color' })).toEqual({ colors: 256, live: true, width: 100 })
    expect(lookOf(tty, { TERM: 'xterm', COLORTERM: 'truecolor' }).colors).toBe('rgb')
    expect(lookOf(tty, { TERM: 'xterm' }).colors).toBe(16)
    expect(lookOf(tty, { TERM: 'xterm-256color', NO_COLOR: '1' }).colors).toBe(0)
    // An empty NO_COLOR asks for nothing.
    expect(lookOf(tty, { TERM: 'xterm', NO_COLOR: '' }).colors).toBe(16)
    expect(lookOf({ isTTY: false }, {})).toEqual({ colors: 0, live: false, width: 80 })
    expect(lookOf({ isTTY: false }, { FORCE_COLOR: '1' }).colors).toBe(16)
    expect(lookOf(tty, { FORCE_COLOR: '0' }).colors).toBe(0)
    expect(lookOf(tty, { TERM: 'dumb' })).toMatchObject({ colors: 0, live: false })
  })
})

describe('the banner', () => {
  it('draws the mark and wordmark where they fit, and the word alone where they would not', () => {
    const wide = banner(still(80))
    for (const line of BANNER) expect(wide).toContain(line)
    expect(wide).toContain('Testnet sandbox. Test dollars only.')
    expect(Math.max(...wide.split('\n').map((l) => l.length))).toBeLessThanOrEqual(BANNER_WIDTH + 2)
    const narrow = banner(still(BANNER_WIDTH + 3))
    expect(narrow).not.toContain(BANNER[1])
    expect(narrow).toContain('  avow')
  })

  it('draws every cell from the block elements, so any monospaced font lines it up', () => {
    for (const line of BANNER) expect(line).toMatch(/^[ ▖▗▘▙▚▛▜▝▞▟▀▄▌▐█]+$/u)
  })

  it('carries no colour codes where the terminal takes none', () => {
    expect(banner(still())).toBe(visible(banner(still())))
    expect(banner({ ...still(), colors: 16 })).not.toBe(visible(banner({ ...still(), colors: 16 })))
  })
})

describe('the rail', () => {
  afterEach(() => vi.useRealTimers())

  it('opens, spaces each stage, ticks what is done and closes on the outcome', () => {
    const out = recorder()
    const rail = new Rail(still(), out.write)
    rail.open('Set up Starter Test Co')
    rail.stage("Your business's key")
    rail.line('Sealed on this machine.')
    rail.stage('Your business on Tempo testnet')
    rail.done('Created the lock.')
    rail.ask('Sign the mandate? y/N')
    rail.close('Starter Test Co is ready.')
    expect(out.text()).toBe(
      [
        '┌  Set up Starter Test Co',
        '│',
        "◇  Your business's key",
        '│  Sealed on this machine.',
        '│',
        '◇  Your business on Tempo testnet',
        '│  ✓ Created the lock.',
        '│',
        '◆  Sign the mandate? y/N',
        '│',
        '└  Starter Test Co is ready.',
        '',
      ].join('\n'),
    )
  })

  it('carries on a rail another process opened, joining it with a space before its first stage', () => {
    const out = recorder()
    new Rail(still(), out.write).stage('Your business on Tempo testnet')
    expect(out.text()).toBe('│\n◇  Your business on Tempo testnet\n')
  })

  it('lays long text to the width, with the rail running beside each line', () => {
    const out = recorder()
    const rail = new Rail(still(30), out.write)
    rail.line('The first time takes a minute or two on the testnet.')
    rail.done('Registered sandbox business biz_0123456789.')
    for (const line of out.text().trimEnd().split('\n')) {
      expect(line.length).toBeLessThanOrEqual(30)
      expect(line.startsWith('│  ')).toBe(true)
    }
  })

  it('turns a spinner while a step takes time, and clears it for whatever comes next', () => {
    vi.useFakeTimers()
    const out = recorder()
    const rail = new Rail({ colors: 0, live: true, width: 80 }, out.write)
    rail.wait('Waiting for the test dollars')
    vi.advanceTimersByTime(200)
    rail.done('The test dollars arrived.')
    const text = out.text()
    expect(text).toContain('│  ⠋ Waiting for the test dollars')
    expect(text).toContain('│  ⠙ Waiting for the test dollars')
    expect(text.endsWith('\r\u001b[2K│  ✓ The test dollars arrived.\n')).toBe(true)
    // Nothing turns once it's settled.
    const after = out.text().length
    vi.advanceTimersByTime(500)
    expect(out.text().length).toBe(after)
  })

  it('shows a waiting step once, still, where the terminal cannot draw a line again', () => {
    const out = recorder()
    new Rail(still(), out.write).wait('Waiting for the test dollars')
    expect(out.text()).toBe('│  Waiting for the test dollars\n')
  })
})

describe('the three kinds of line a job run shows', () => {
  it("keeps a model's words, a tool's result and a verified fact apart", () => {
    const out = recorder()
    const rail = new Rail(still(), out.write)
    rail.said('qwen3:8b', 'The firm offer starts now, so I will book it.')
    rail.call('book_compute', 'h100x8-firm')
    rail.returned(true, 'Booked $180 with avow-demo-gpu.')
    rail.call('book_compute', 'h100x8-spot')
    rail.returned(false, 'service.over_budget: the offer costs $180 and your budget is $150.')
    rail.fact({
      text: 'The compute booking is accepted and its free cancellation has ended.',
      verifiedBy: 'service',
      block: 1204331n,
      reference: REFERENCE,
    })
    expect(out.text()).toBe(
      [
        '│  qwen3:8b › The firm offer starts now, so I will book it.',
        '│  ↳ book_compute h100x8-firm',
        '│    ✓ Booked $180 with avow-demo-gpu.',
        '│  ↳ book_compute h100x8-spot',
        '│    ✗ service.over_budget: the offer costs $180 and your budget is $150.',
        '│  ∎ At block 1204331, checked by your service.ts. The compute booking is',
        '│    accepted and its free cancellation has ended.',
        '│    chain 42431, lock 0x8684…AF31, commitment 0x9f3c…a1e2, buyer side',
        '',
      ].join('\n'),
    )
  })

  it("hangs a model's longer words under its first line, clear of its name", () => {
    const out = recorder()
    new Rail(still(40), out.write).said(
      'Claude',
      'I compared four offers and two of them start too late.',
    )
    const lines = out.text().trimEnd().split('\n')
    expect(lines[0]).toBe('│  Claude › I compared four offers and')
    for (const line of lines.slice(1)) expect(line.startsWith('│           ')).toBe(true)
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(40)
  })

  it('names the speaker in the accent where the terminal takes colour', () => {
    const out = recorder()
    new Rail({ colors: 16, live: false, width: 80 }, out.write).said('Claude', 'Booking it.')
    expect(out.text()).toContain('\u001b[35mClaude\u001b[39m')
  })

  it('shows a commitment as a receipt with the states it has reached', () => {
    const out = recorder()
    new Rail(still(), out.write).receipt({
      title: 'Job commitment 0x9f3c…a1e2',
      lines: ["$300 reserved by Avow's test customer, for a late cancellation or a no-show."],
      states: [
        { name: 'reserved', reached: true },
        { name: 'accepted', reached: true },
        { name: 'delivered', reached: false },
      ],
      evidence: {
        verifiedBy: 'service',
        block: 1204340n,
        reference: REFERENCE,
        transactionHash: `0x${'ab'.repeat(32)}`,
      },
      link: 'https://try.testnet.avow.finance/verify#abc',
    })
    expect(out.text()).toBe(
      [
        '│',
        '│  Job commitment 0x9f3c…a1e2',
        "│  $300 reserved by Avow's test customer, for a late cancellation or a no-show.",
        '│  ● reserved  ● accepted  ○ delivered',
        '│  At block 1204340, checked by your service.ts, chain 42431, lock 0x8684…AF31,',
        '│  commitment 0x9f3c…a1e2, buyer side, transaction 0xabab…abab',
        '│  https://try.testnet.avow.finance/verify#abc',
        '',
      ].join('\n'),
    )
  })
})

describe('evidence the rail will draw', () => {
  const fact = {
    text: 'The booking is accepted.',
    verifiedBy: 'service',
    block: 1n,
    reference: REFERENCE,
  } as const

  it('takes only a source, a whole block and a full chain reference, in the types', () => {
    const rail = new Rail(still(), () => {})
    // @ts-expect-error a model is never a source of evidence
    expect(() => rail.fact({ ...fact, verifiedBy: 'qwen3:8b' })).toThrow(/who verified it/)
    // @ts-expect-error a block is a whole number, so NaN can't pass
    expect(() => rail.fact({ ...fact, block: Number.NaN })).toThrow(/block/)
    // @ts-expect-error a side is buyer or supplier
    expect(() => rail.fact({ ...fact, reference: { ...REFERENCE, side: 'sideways' } })).toThrow(
      /side/,
    )
    // @ts-expect-error a lock is a 0x address
    expect(() => rail.fact({ ...fact, reference: { ...REFERENCE, lock: 'abc' } })).toThrow(/lock/)
    const noChain = { lock: LOCK, commitmentId: COMMITMENT, side: 'buyer' } as const
    // @ts-expect-error the reference names its chain
    expect(() => rail.fact({ ...fact, reference: noChain })).toThrow(/chain/)
  })

  it('refuses at run time what a cast would let past the types', () => {
    const rail = new Rail(still(), () => {})
    expect(() => rail.fact({ ...fact, reference: { ...REFERENCE, lock: '0x' } })).toThrow(/lock/)
    expect(() => rail.fact({ ...fact, reference: { ...REFERENCE, commitmentId: '0xzz' } })).toThrow(
      /commitment/,
    )
    expect(() => rail.fact({ ...fact, transactionHash: '0x12' })).toThrow(/transaction/)
  })

  it("draws the customer's check as its own statement", () => {
    const out = recorder()
    new Rail(still(100), out.write).fact({ ...fact, verifiedBy: 'customer' })
    expect(out.text()).toContain(
      "At block 1, Avow's test customer says it checked. The booking is accepted.",
    )
  })
})

describe('a table of recorded results', () => {
  const offers = {
    title: 'The offers it compared, listed at 16:02 by avow-demo-gpu',
    columns: ['offer', 'GPUs', 'starts', 'per GPU-hour', 'free cancellation'],
    rows: [
      ['h100-firm', '1 to 16', 'now', '$2.40', 'ended'],
      ['h100-flex', '1 to 16', 'now', '$1.60', 'until 17:30'],
      ['h100-later', '1 to 16', '18:30', '$1.90', 'ended'],
    ],
    marked: 0,
    notes: ['Your budget was $3.00 per GPU-hour, with $500 of authority left.'],
  }

  it('aligns its columns, marks the chosen row and puts the limits under it', () => {
    const out = recorder()
    new Rail(still(), out.write).table(offers)
    expect(out.text()).toBe(
      [
        '│',
        '│  The offers it compared, listed at 16:02 by avow-demo-gpu',
        '│    offer       GPUs     starts  per GPU-hour  free cancellation',
        '│  › h100-firm   1 to 16  now     $2.40         ended',
        '│    h100-flex   1 to 16  now     $1.60         until 17:30',
        '│    h100-later  1 to 16  18:30   $1.90         ended',
        '│  Your budget was $3.00 per GPU-hour, with $500 of authority left.',
        '',
      ].join('\n'),
    )
  })

  it('narrows its widest columns to fit a narrow terminal, so no row wraps', () => {
    const out = recorder()
    new Rail(still(44), out.write).table(offers)
    const rows = out.text().split('\n').slice(2, 6)
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(44)
    expect(out.text()).toContain('…')
  })
})

describe('a model speaking as its words arrive', () => {
  it('lays pieces onto the rail as they come, splitting words only where spaces fall', () => {
    const out = recorder()
    const rail = new Rail(still(40), out.write)
    const speech = rail.speak('qwen3:8b')
    for (const piece of [
      'The fi',
      'rm offer starts now, so I ',
      'will book it before the ',
      'deadline.',
    ]) {
      speech.write(piece)
    }
    speech.end()
    const lines = out.text().trimEnd().split('\n')
    expect(lines.join(' ').replace(/│ +/g, '').replace(/ +/g, ' ')).toBe(
      'qwen3:8b › The firm offer starts now, so I will book it before the deadline.',
    )
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(40)
    for (const line of lines.slice(1)) expect(line.startsWith('│             ')).toBe(true)
  })

  it('ends its line when anything else is drawn, so evidence never runs into speech', () => {
    const out = recorder()
    const rail = new Rail(still(), out.write)
    rail.speak('Claude').write('Booking the firm offer')
    rail.call('book_compute', 'h100x8-firm')
    expect(out.text()).toBe('│  Claude › Booking the firm offer\n│  ↳ book_compute h100x8-firm\n')
  })

  it("starts a new line under the speaker's name where the model breaks one", () => {
    const out = recorder()
    const speech = new Rail(still(), out.write).speak('Claude')
    speech.write('Two offers start too late.\nThe firm one fits.')
    speech.end()
    expect(out.text()).toBe(
      '│  Claude › Two offers start too late.\n│           The firm one fits.\n',
    )
  })

  it("draws the developer's own line and quieter lines apart from the agent's", () => {
    const out = recorder()
    const rail = new Rail(still(100), out.write)
    expect(rail.you).toBe('│  you › ')
    rail.quiet("Typing changes what the agent does next. It can't undo a booking already made.")
    expect(out.text()).toBe(
      "│  Typing changes what the agent does next. It can't undo a booking already made.\n",
    )
  })
})

describe('lines set apart', () => {
  it('puts a bar before each line, the first one bold', () => {
    expect(setApart(still(), ['Work can now begin.', 'The customer verified your compute.'])).toBe(
      '\n▌  Work can now begin.\n▌  The customer verified your compute.\n',
    )
    const colored = setApart({ ...still(), colors: 16 }, ['Work can now begin.'])
    expect(colored).toContain('\u001b[1mWork can now begin.\u001b[22m')
  })
})

describe('wrapping', () => {
  it('breaks between words and keeps a word longer than the width whole', () => {
    expect(wrap('one two three', 7)).toEqual(['one two', 'three'])
    const link = 'https://try.testnet.avow.finance/s/abcdefghijklmnop'
    expect(wrap(`Watch it at ${link}`, 20)).toEqual(['Watch it at', link])
  })
})
