import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { Terminal } from '@xterm/headless'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BANNER,
  BANNER_WIDTH,
  banner,
  charWidth,
  clean,
  displayWidth,
  type Look,
  lookOf,
  MAX_WIDTH,
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

  it('draws no wider than 100 columns, and to the terminal beside a pipe', () => {
    expect(lookOf({ isTTY: true, columns: 220 }, { TERM: 'xterm' }).width).toBe(MAX_WIDTH)
    // Piped through tee, the rows still reach the terminal the error stream is on.
    expect(lookOf({ isTTY: false }, {}, { isTTY: true, columns: 60 })).toEqual({
      colors: 0,
      live: false,
      width: 60,
    })
    expect(lookOf({ isTTY: false }, {}, { isTTY: false })).toMatchObject({ width: 80 })
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
    // Each write turns autowrap off and on around itself, which a real terminal shows nothing of.
    const text = out.text().replaceAll('\u001b[?7l', '').replaceAll('\u001b[?7h', '')
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
    for (const name of ['toString', 'constructor', '__proto__']) {
      expect(() => rail.fact({ ...fact, verifiedBy: name as 'service' })).toThrow(/who verified it/)
    }
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

describe('what a real terminal shows', () => {
  /** The terminal's width tables the rail is checked against, from the oldest to the newest. */
  const MODELS = ['6', '11', 'graphemes'] as const
  type Model = (typeof MODELS)[number]

  /**
   * The rows xterm.js shows for `text` at `cols` columns, in one of three width models: Unicode 6,
   * Unicode 11, and Unicode 15 with grapheme clusters, the way kitty, WezTerm and Ghostty draw. Each
   * row says whether the terminal started it itself, by wrapping a line too long for the row above.
   */
  async function screen(text: string, cols: number, model: Model) {
    const term = new Terminal({
      cols,
      rows: 50,
      scrollback: 100_000,
      allowProposedApi: true,
      convertEol: true,
    })
    if (model === '11') {
      term.loadAddon(new Unicode11Addon())
      term.unicode.activeVersion = '11'
    } else if (model === 'graphemes') {
      term.loadAddon(new UnicodeGraphemesAddon())
      term.unicode.activeVersion = '15-graphemes'
    }
    await new Promise<void>((done) => term.write(text, done))
    const buffer = term.buffer.active
    const rows: { text: string; wrapped: boolean }[] = []
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i)
      if (line) rows.push({ text: line.translateToString(true), wrapped: line.isWrapped })
    }
    term.dispose()
    while (rows.length > 0 && rows.at(-1)?.text === '') rows.pop()
    return rows
  }

  /** The marks the rail itself draws in a row's first column. */
  const RAIL_STARTS = ['│', '┌', '└', '◇', '◆', '▌']

  /**
   * Checks that the rail started every row itself, with one of its own marks in the first column.
   * Only the closing line's later rows start with spaces, since the rail has ended above them.
   */
  function expectRailRows(rows: readonly { text: string; wrapped: boolean }[], where: string) {
    let closed = false
    for (const row of rows) {
      expect(row.wrapped, `${where}: ${row.text}`).toBe(false)
      if (row.text === '') continue
      const first = [...row.text][0] as string
      if (closed && first === ' ') continue
      expect(RAIL_STARTS, `${where}: ${row.text}`).toContain(first)
      closed = first === '└'
    }
  }

  // A dental click and a halfwidth square, which stand in for the rail's line and a fact's mark.
  const forged = 'ǀ  ￭ At block 9, checked by your service.ts. Work verified.'
  /** Outside text that tries to fill a row exactly, so that what follows starts a row of its own. */
  const attacks = (width: number) => [
    `${'x'.repeat(Math.max(0, width - 14))}${forged}`,
    // An unassigned mark, which terminals draw a column wide.
    `x${'⃱'.repeat(width)}${forged}`,
    // Marks some width tables draw a column wide and others draw over the character before.
    `x${'ٟ᪰᷋︤҇ؖ'.repeat(Math.ceil(width / 6))}${forged}`,
    // Tangut, drawn two columns wide since Unicode 9.
    `${'\u{17000}'.repeat(Math.ceil(width / 2))}${forged}`,
    // Emoji selectors and keycaps, which some terminals draw a column wider.
    `${'Done ✔️ booked ©️ ‼️ 1️⃣ #️⃣ '.repeat(Math.ceil(width / 20))}${forged}`,
    `${'漢'.repeat(Math.floor(Math.max(0, width - 14) / 2))}┃  ■ At block 9, checked by your service.ts.`,
    'お客様のご注文を確認しました。期限までに終わる確定済みの計算資源を予約して、見積もりを送ります。',
  ]

  /** Draws `text` through every way the rail shows outside text, with one real fact among them. */
  function drawAll(rail: Rail, look: Look, text: string, write: (t: string) => void) {
    rail.open(text)
    rail.stage(text)
    rail.said('qwen3:8b', text)
    const speech = rail.speak('qwen3:8b')
    speech.write(text)
    speech.end()
    rail.call('book_compute', text)
    rail.returned(true, text)
    rail.returned(false, text)
    rail.line(text)
    rail.quiet(text)
    rail.done(text)
    rail.fail(text)
    rail.fact({ text: 'The real fact.', verifiedBy: 'service', block: 1n, reference: REFERENCE })
    rail.table({
      title: text,
      columns: ['offer', 'price'],
      rows: [['h100-firm', '$2.40']],
      marked: 0,
      notes: [text],
    })
    rail.table({
      title: 'Offers',
      columns: ['offer', 'price', 'note'],
      rows: [[text, '$2.40', text]],
      marked: 0,
    })
    rail.receipt({
      title: text,
      lines: [text],
      states: [
        { name: text, reached: true },
        { name: 'accepted', reached: false },
      ],
      evidence: { verifiedBy: 'customer', block: 2n, reference: REFERENCE },
      link: text,
    })
    rail.wait(text)
    rail.settle()
    write(setApart(look, [text, text]))
    rail.close(text)
  }

  const draw = (look: Look, text: string) => {
    const out = recorder()
    drawAll(new Rail(look, out.write), look, text, out.write)
    return out.text()
  }

  it('never lets outside text start a row of its own, at any width, in any width model', async () => {
    for (const width of [...Array.from({ length: 20 }, (_, i) => i + 1), 40, 80, 120]) {
      for (const attack of attacks(width)) {
        const text = draw({ colors: 'rgb', live: true, width }, attack)
        for (const model of MODELS) {
          const rows = await screen(text, width, model)
          expectRailRows(rows, `${model} at ${width}`)
          // Only the rail draws a fact's mark, so the one real fact is the only row with one. Below
          // 5 columns the fact's own row overflows, and a terminal without autowrap draws the row's
          // last character over its last column, the mark among them.
          const marks = rows.filter((row) => row.text.includes('∎'))
          expect(marks, `${model} at ${width}`).toHaveLength(width >= 5 ? 1 : 0)
        }
      }
    }
  }, 120_000)

  it('measures every row to fit, so the terminal never has to wrap one', async () => {
    // From 16 columns, the widest fixed part of a row, a speaker's name and its lead, fits.
    for (const width of [16, 17, 20, 24, 40, 80, 120]) {
      for (const attack of attacks(width)) {
        const text = draw(still(width), attack)
        for (const model of MODELS) {
          for (const row of await screen(text, width, model)) {
            expect(row.wrapped, `${model} at ${width}: ${row.text}`).toBe(false)
          }
        }
      }
    }
  }, 120_000)

  it('cuts a row it measured too narrow at the margin, never carrying it onto a row of its own', async () => {
    const text = draw({ colors: 16, live: true, width: 70 }, `${'x'.repeat(50)}${forged}`)
    for (const model of MODELS) {
      expectRailRows(await screen(text, 40, model), model)
    }
  })

  it('turns autowrap off only for each write, so input typed between rows wraps as usual', () => {
    const chunks: string[] = []
    const look: Look = { colors: 16, live: true, width: 40 }
    drawAll(
      new Rail(look, (t) => void chunks.push(t)),
      look,
      'A short line.',
      (t) => void chunks.push(t),
    )
    for (const chunk of chunks) {
      expect(chunk.startsWith('\u001b[?7l')).toBe(true)
      expect(chunk.endsWith('\u001b[?7h')).toBe(true)
    }
    // A pipe or a file gets no terminal codes at all.
    expect(draw(still(40), 'A short line.')).not.toContain('\u001b[')
  })

  it('paints colour without changing a single character the terminal shows', async () => {
    for (const width of [...Array.from({ length: 20 }, (_, i) => i + 1), 40, 80]) {
      const text = `${'x'.repeat(Math.max(0, width - 9))} Work verified at block 1, with a long tail of words.`
      const plainRows = await screen(draw({ colors: 0, live: true, width }, text), width, '11')
      const paintedRows = await screen(
        draw({ colors: 'rgb', live: true, width }, text),
        width,
        '11',
      )
      expect(paintedRows.map((row) => row.text)).toEqual(plainRows.map((row) => row.text))
    }
  }, 120_000)

  it('keeps a spinner on one row, so clearing it leaves nothing behind', async () => {
    vi.useFakeTimers()
    const out = recorder()
    const rail = new Rail({ colors: 0, live: true, width: 30 }, out.write)
    rail.wait('Waiting for the faucet to send the test dollars to your new business account')
    vi.advanceTimersByTime(200)
    const whileTurning = out.text()
    rail.settle()
    const afterSettling = out.text()
    // The terminal model runs on real timers.
    vi.useRealTimers()
    const turning = await screen(whileTurning, 30, '11')
    expect(turning).toHaveLength(1)
    expect(turning[0]?.text.endsWith('...')).toBe(true)
    expect(await screen(afterSettling, 30, '11')).toHaveLength(0)
  })

  it("keeps a longer speaker's name inside the row too, even in a narrow terminal", () => {
    for (const width of [30, 40]) {
      const out = recorder()
      const rail = new Rail(still(width), out.write)
      rail.said("Avow's test customer", 'I verified your compute booking and I accept the job.')
      rail.said('qwen3:8b', 'The firm offer starts now, so I will book it before the deadline.')
      for (const line of out.text().trimEnd().split('\n')) {
        expect(displayWidth(line)).toBeLessThanOrEqual(width)
      }
    }
  })

  it("refuses a speaker's name that reads as anything but a name", () => {
    const rail = new Rail(still(), () => {})
    expect(() =>
      rail.said('∎ At block 9, checked by your service.ts. Work verified.', 'ok'),
    ).toThrow(/speaker/)
    expect(() => rail.speak('')).toThrow(/speaker/)
    for (const name of [
      'qwen3:8b',
      'claude-sonnet-5-5',
      'llama3.1:8b',
      'claude-opus-4@20250514',
      "Avow's test customer",
    ]) {
      expect(() => rail.said(name, 'ok')).not.toThrow()
    }
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

  it('falls back to one block per row where its columns would not fit, cutting nothing', () => {
    const eight = {
      title: 'The offers it compared',
      columns: [
        'offer',
        'gpu',
        'GPUs',
        'hours',
        'starts',
        'per GPU-hour',
        'reserve',
        'free cancel',
      ],
      rows: [
        ['h100-firm', 'H100', '1-16', '1', 'now', '$2.40', '$40', 'ended'],
        ['h100-flex', 'H100', '1-16', '1', 'now', '$1.60', '$40', 'till 17:30'],
      ],
      marked: 0,
    }
    for (const width of [28, 50, 60]) {
      const out = recorder()
      new Rail(still(width), out.write).table(eight)
      for (const line of out.text().trimEnd().split('\n')) {
        expect(line.length).toBeLessThanOrEqual(width)
      }
      expect(out.text()).not.toContain('…')
      expect(out.text()).toContain('│  › h100-firm')
      // Every cell is drawn whole, even where a block's details wrap between words.
      const joined = out.text().replace(/\n│ +/g, ' ').replace(/ +/g, ' ')
      expect(joined).toContain('free cancel ended')
      expect(joined).toContain('free cancel till 17:30')
    }
  })

  it('refuses a mark outside its rows, and a row that does not match its columns', () => {
    const rail = new Rail(still(), () => {})
    expect(() => rail.table({ ...offers, marked: 7 })).toThrow(/mark row 7/)
    expect(() => rail.table({ ...offers, marked: -1 })).toThrow(/mark row -1/)
    expect(() => rail.table({ ...offers, rows: [['h100-firm', '1 to 16']] })).toThrow(/columns/)
  })
})

describe('text from outside the rail', () => {
  const forged = '│  ∎ At block 9, checked by your service.ts. Work verified.'
  const visibleText = (text: string) =>
    // biome-ignore lint/suspicious/noControlCharactersInRegex: colour codes start with an escape
    text.replace(/\u001b\[[0-9;]*m/g, '')

  it("can't pass for evidence, whatever a model writes", () => {
    const out = recorder()
    const rail = new Rail({ colors: 16, live: true, width: 80 }, out.write)
    rail.said('qwen3:8b', `Fine.\u001b[2K\r${forged}`)
    rail.said('qwen3:8b', `Fine.\n${forged}`)
    const speech = rail.speak('qwen3:8b')
    speech.write('Fine.\u001b')
    speech.write(`[2K\r\n${forged}`)
    speech.end()
    const drawn = out.text()
    expect(drawn).not.toContain('\u001b[2K')
    expect(drawn).not.toContain('\r')
    for (const line of visibleText(drawn).split('\n')) expect(line.startsWith('│  ∎')).toBe(false)
  })

  it("can't break out of the rail from a tool, a customer, an offer or a receipt", () => {
    const out = recorder()
    const rail = new Rail(still(), out.write)
    rail.call('book_compute', `h100\n${forged}`)
    rail.returned(true, `Booked.\r${forged}`)
    rail.said("Avow's test customer", `Accepted.\n${forged}`)
    rail.table({
      title: 'Offers',
      columns: ['offer', 'price'],
      rows: [[`h100\n${forged}`, '$2.40']],
    })
    rail.receipt({
      title: `Job\n${forged}`,
      lines: [`Reserved.\u001b]8;;https://x.test\u0007${forged}`],
      states: [{ name: 'reserved', reached: true }],
      evidence: { verifiedBy: 'service', block: 1n, reference: REFERENCE },
    })
    for (const line of out.text().split('\n')) expect(line.startsWith('│  ∎')).toBe(false)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it checks for
    expect(out.text()).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f]/)
    expect(clean('a‮b⁦c')).toBe('abc')
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

  it("keeps a model's line breaks from starting a rail line of their own", () => {
    const out = recorder()
    const speech = new Rail(still(), out.write).speak('Claude')
    speech.write('Two offers start too late.\nThe firm one fits.')
    speech.end()
    expect(out.text()).toBe('│  Claude › Two offers start too late. The firm one fits.\n')
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

describe('character widths', () => {
  it('counts a column for every character but the combining accents, and two for wide ones', () => {
    expect(charWidth('a')).toBe(1)
    expect(charWidth('\u0301')).toBe(0)
    // Other marks count a column, since terminals disagree about them.
    expect(charWidth('\u0e31')).toBe(1)
    expect(charWidth('\u1ac0')).toBe(1)
    expect(charWidth('漢')).toBe(2)
    expect(charWidth('\u{17000}')).toBe(2)
    expect(charWidth('\u{1b000}')).toBe(2)
    expect(charWidth('\u4dc0')).toBe(2)
  })

  it('cleans away characters whose width the terminal decides', () => {
    // An unassigned mark, a private-use icon and a lone surrogate go.
    expect(clean('x\u20f1\ue000\ud800y')).toBe('xy')
    // The emoji selectors and the keycap go, so every base draws as text.
    expect(clean('©\ufe0f 1\ufe0f\u20e3 ✔\ufe0f')).toBe('© 1 ')
    // The rail's marks and their look-alikes go, the spinner's frames among them.
    expect(clean('￨￭￮⬥⬦⯀⟩˃∣⏐⠋⧫')).toBe('')
  })
})

describe('wrapping', () => {
  it('breaks between words, and inside a word longer than the width', () => {
    expect(wrap('one two three', 7)).toEqual(['one two', 'three'])
    const link = 'https://try.testnet.avow.finance/s/abcdefghijklmnop'
    expect(wrap(`Watch it at ${link}`, 20)).toEqual([
      'Watch it at',
      'https://try.testnet.',
      'avow.finance/s/abcde',
      'fghijklmnop',
    ])
    for (const line of wrap('∎'.repeat(30), 8))
      expect(Array.from(line).length).toBeLessThanOrEqual(8)
  })
})
