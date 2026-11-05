import { type Look, type Paint, type Styles, stylesOf, wrap } from './look.js'

/** Where a rail draws, which in the tools is the terminal's output. */
export type Write = (text: string) => void

/**
 * Text from outside the rail, made safe to draw. Escape sequences go, line breaks and tabs become
 * spaces, and every other control character and bidirectional override is dropped. So nothing a
 * model, a customer or a supplier writes can move the cursor, clear a line, reorder what shows or
 * start a line of its own that passes for evidence.
 */
export function clean(text: string): string {
  return (
    String(text)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are what it removes
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are what it removes
      .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, '')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are what it removes
      .replace(/\u001b[@-_]/g, '')
      .replace(/[\r\n\t\v\f]+/g, ' ')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes
      .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '')
  )
}

/** An address, an id or a hash as the chain writes it. */
export type Hex = `0x${string}`

/** Who verified a fact, of the three sources a fact can have. A model is never one. */
export type VerifiedBy = 'service' | 'customer' | 'avow'

/**
 * Where a fact or a receipt comes from, since a signed line only says who published it. It names
 * who verified it, the commitment read on which chain, the block, and the transaction if any.
 */
export interface Evidence {
  readonly verifiedBy: VerifiedBy
  readonly block: bigint
  readonly reference: {
    readonly chain: number
    readonly lock: Hex
    readonly commitmentId: Hex
    readonly side: 'buyer' | 'supplier'
  }
  readonly transactionHash?: Hex
}

/** How each source's check reads on the rail. The customer's is its own statement. */
const VERIFIED: Record<VerifiedBy, string> = {
  service: 'checked by your service.ts',
  avow: "checked by Avow's API",
  customer: "Avow's test customer says it checked",
}

/**
 * Refuses evidence the types would let through from a cast or plain JavaScript: an unknown
 * source, a block that isn't a whole number, or a reference that isn't a lock, a commitment id and
 * a side on a chain.
 */
function checkEvidence(e: Evidence): void {
  const hex = (value: unknown, length: number) =>
    typeof value === 'string' && new RegExp(`^0x[0-9a-fA-F]{${length}}$`).test(value)
  const r = e.reference
  const problem = !Object.hasOwn(VERIFIED, e.verifiedBy)
    ? `who verified it, ${String(e.verifiedBy)}, isn't one of ${Object.keys(VERIFIED).join(', ')}`
    : typeof e.block !== 'bigint' || e.block < 0n
      ? 'its block is not a whole number'
      : !r || !Number.isInteger(r.chain) || r.chain <= 0
        ? 'its reference names no chain'
        : !hex(r.lock, 40)
          ? 'its reference names no lock address'
          : !hex(r.commitmentId, 64)
            ? 'its reference names no commitment id'
            : r.side !== 'buyer' && r.side !== 'supplier'
              ? 'its reference names no side'
              : e.transactionHash !== undefined && !hex(e.transactionHash, 64)
                ? 'its transaction hash is malformed'
                : null
  if (problem) throw new TypeError(`The rail won't draw this as evidence, because ${problem}.`)
}

/** A fact code outside the model checked, with where it comes from. */
export interface Fact extends Evidence {
  readonly text: string
}

/** A commitment as the terminal shows it. */
export interface Receipt {
  /** What it is, such as the job commitment and its id. */
  readonly title: string
  /** A sentence or two on who reserved what for whom, and what the reserve covers. */
  readonly lines: readonly string[]
  /** Its states in order, each reached or not yet. */
  readonly states: readonly { readonly name: string; readonly reached: boolean }[]
  /** Where its states were read. */
  readonly evidence: Evidence
  /** Where anyone can check it. */
  readonly link?: string
}

/**
 * A small table of recorded results, such as the offers a model compared, with the row it chose
 * marked and quiet notes under it, such as the limits that applied then. Cells are plain text.
 */
export interface Table {
  readonly title: string
  readonly columns: readonly string[]
  readonly rows: readonly (readonly string[])[]
  /** The row to mark, such as the offer booked. */
  readonly marked?: number
  readonly notes?: readonly string[]
}

/** An address or a hash as the terminal shortens it, with enough of each end to tell it apart. */
const short = (hex: string) => (hex.length > 14 ? `${hex.slice(0, 6)}…${hex.slice(-4)}` : hex)

/** The chain reference under a fact or a receipt, in one quiet line. */
const referenceLine = (e: Evidence) =>
  [
    `chain ${e.reference.chain}`,
    `lock ${short(e.reference.lock)}`,
    `commitment ${short(e.reference.commitmentId)}`,
    `${e.reference.side} side`,
    ...(e.transactionHash ? [`transaction ${short(e.transactionHash)}`] : []),
  ].join(', ')

/** The frames of the spinner a step turns while it takes time, and how long each shows. */
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const
const FRAME_MS = 80

/** The narrowest the rail lays its text, however narrow the terminal. */
const MIN_TEXT = 24

const plain: Paint = (text) => text

/** A model's words still arriving: the indent under its name, the column reached and a part word. */
interface Speech {
  hang: string
  column: number
  pending: string
  started: boolean
}

/**
 * A run of steps drawn down one line at the left, the way a setup reads. It opens on a title, each
 * stage starts on it, what's done is ticked, a question waits on it in the brand's violet, and it
 * closes on the outcome. While something takes time, a spinner turns on its own line, and whatever
 * is drawn next takes that line's place. A rail another process opened carries on without opening
 * again, so one flow reads as one rail across the commands that draw it.
 */
export class Rail {
  readonly #look: Look
  readonly #write: Write
  readonly #s: Styles
  #spinner: { timer: ReturnType<typeof setInterval>; frame: number; text: string } | null = null
  /** Whether the last line drawn was the rail alone, so two stages never draw two of them. */
  #spaced = false
  /** Words still arriving from a model, and where the line they're on has got to. */
  #speech: Speech | null = null

  constructor(look: Look, write: Write = (text) => void process.stdout.write(text)) {
    this.#look = look
    this.#write = write
    this.#s = stylesOf(look)
  }

  /** What goes before anything typed on the rail. */
  get prefix(): string {
    return `${this.#s.dim('│')}  `
  }

  /** The rail's first line. */
  open(title: string): void {
    this.#block(this.#s.dim('┌'), clean(title), this.#s.bold)
  }

  /** A stage starting. */
  stage(title: string): void {
    this.#space()
    this.#block(this.#s.dim('◇'), clean(title), this.#s.bold)
  }

  /** A question, whose answer is typed on the line after it. */
  ask(question: string): void {
    this.#space()
    this.#block(this.#s.accent('◆'), clean(question), this.#s.bold)
  }

  /** A sentence to read. */
  line(text: string): void {
    this.#block(this.#s.dim('│'), clean(text), plain)
  }

  /** Something done. */
  done(text: string): void {
    this.#item(this.#s.ok('✓'), clean(text))
  }

  /** Something that failed. */
  fail(text: string): void {
    this.#item(this.#s.bad('✗'), clean(text))
  }

  /**
   * Something under way, with a spinner turning beside it until the next thing is drawn. Where the
   * terminal can't draw a line again, it shows once, still.
   */
  wait(text: string): void {
    this.settle()
    if (!this.#look.live) {
      this.#emit(`${this.prefix}${clean(text)}`)
      return
    }
    const spinner = {
      timer: setInterval(() => this.#turn(), FRAME_MS),
      frame: 0,
      text: clean(text),
    }
    spinner.timer.unref?.()
    this.#spinner = spinner
    this.#turn()
  }

  /**
   * Puts `text` on the line just typed on, such as to say a passphrase was set where nothing was
   * shown as it was typed, quiet or as a refusal. Where the terminal can't draw a line again, the
   * line stays as typed.
   */
  answered(text: string, tone: 'plain' | 'quiet' | 'bad' = 'plain'): void {
    this.settle()
    const paint = tone === 'quiet' ? this.#s.dim : tone === 'bad' ? this.#s.bad : plain
    if (this.#look.live) this.#write(`\u001b[1A\r\u001b[2K${this.prefix}${paint(clean(text))}\n`)
    this.#spaced = false
  }

  /** The rail's last line, with the outcome. */
  close(text: string): void {
    this.#space()
    this.#block(this.#s.dim('└'), clean(text), this.#s.bold, '   ')
  }

  /**
   * Words a model or an agent said, in its own name, with the name in the brand's violet so they
   * never read as something a tool did or a check proved.
   */
  said(who: string, words: string): void {
    const speaker = clean(who)
    const text = clean(words)
    const lead = `${speaker} › `
    const [first = '', ...more] = wrap(text, Math.max(MIN_TEXT, this.#look.width - 3 - lead.length))
    const hang = ' '.repeat(lead.length)
    this.#emit(
      [
        `${this.prefix}${this.#s.accent(speaker)} ${this.#s.dim('›')} ${first}`,
        ...more.map((line) => `${this.prefix}${hang}${line}`),
      ].join('\n'),
    )
    this.#spaced = false
  }

  /**
   * Starts a model's words that arrive a piece at a time, as a local model or an API streams them.
   * Each piece is laid onto the rail as it comes, wrapped at the terminal's width under the
   * speaker's name, and the line ends when `end` is called or anything else is drawn.
   */
  speak(who: string): { write: (piece: string) => void; end: () => void } {
    const speaker = clean(who)
    this.settle()
    this.#endSpeech()
    const lead = `${speaker} › `
    this.#write(`${this.prefix}${this.#s.accent(speaker)} ${this.#s.dim('›')} `)
    this.#spaced = false
    this.#speech = {
      hang: ' '.repeat(lead.length),
      column: 3 + lead.length,
      pending: '',
      started: false,
    }
    return {
      write: (piece) => this.#speakPiece(clean(piece)),
      end: () => this.#endSpeech(),
    }
  }

  /** What goes before a message the developer types to the agent. */
  get you(): string {
    return `${this.prefix}${this.#s.dim('you ›')} `
  }

  /** A quieter line, such as what typing to the agent can and can't change. */
  quiet(text: string): void {
    this.#block(this.#s.dim('│'), clean(text), this.#s.dim)
  }

  /** A tool the model called, by name, with what it was called on. */
  call(name: string, about = ''): void {
    const tool = clean(name)
    const detail = clean(about)
    const words =
      detail === '' ? this.#s.bold(tool) : `${this.#s.bold(tool)} ${this.#s.dim(detail)}`
    this.#emit(`${this.prefix}${this.#s.dim('↳')} ${words}`)
    this.#spaced = false
  }

  /** What the tool just called gave back, under it, ticked or refused. */
  returned(ok: boolean, result: string): void {
    const mark = ok ? this.#s.ok('✓') : this.#s.bad('✗')
    const [first = '', ...more] = wrap(clean(result), Math.max(MIN_TEXT, this.#look.width - 7))
    this.#emit(
      [`${this.prefix}  ${mark} ${first}`, ...more.map((line) => `${this.prefix}    ${line}`)].join(
        '\n',
      ),
    )
    this.#spaced = false
  }

  /**
   * A fact code outside the model verified. It says who checked and at which block, since a check
   * proves the state at that block and nothing after it, with the chain reference under it.
   */
  fact(fact: Fact): void {
    checkEvidence(fact)
    this.#item(
      this.#s.ok('∎'),
      `${this.#s.dim(`At block ${fact.block}, ${VERIFIED[fact.verifiedBy]}.`)} ${clean(fact.text)}`,
    )
    this.#emit(`${this.prefix}  ${this.#s.dim(referenceLine(fact))}`)
    this.#spaced = false
  }

  /**
   * A table of recorded results under the rail. When its columns fit the terminal it draws them
   * aligned, and when they don't it draws one block per row, so no cell is ever cut and no row
   * wraps. The marked row, such as the offer booked, is always drawn whole.
   */
  table(table: Table): void {
    const columns = table.columns.map(clean)
    const rows = table.rows.map((row) => row.map(clean))
    if (rows.some((row) => row.length !== columns.length)) {
      throw new TypeError("The rail won't draw a table whose rows don't match its columns.")
    }
    const { marked } = table
    if (
      marked !== undefined &&
      !(Number.isInteger(marked) && marked >= 0 && marked < rows.length)
    ) {
      throw new TypeError(`The rail won't mark row ${marked} of a table with ${rows.length} rows.`)
    }
    const gap = 2
    const widths = columns.map((name, i) =>
      Math.max(name.length, ...rows.map((row) => (row[i] as string).length)),
    )
    const room = Math.max(MIN_TEXT, this.#look.width - 5)
    const fits = widths.reduce((sum, w) => sum + w, 0) + gap * (widths.length - 1) <= room
    const aligned = (cells: readonly string[]) =>
      cells
        .map((cell, i) => cell.padEnd(widths[i] as number))
        .join(' '.repeat(gap))
        .trimEnd()
    const mark = (i: number) => (i === marked ? `${this.#s.accent('›')} ` : '  ')
    const body = fits
      ? [
          `${this.prefix}  ${this.#s.dim(aligned(columns))}`,
          ...rows.map((row, i) => {
            const line = aligned(row)
            return `${this.prefix}${mark(i)}${i === marked ? this.#s.bold(line) : line}`
          }),
        ]
      : rows.flatMap((row, i) => {
          const [key = '', ...rest] = row
          const details = rest.map((cell, j) => `${columns[j + 1]} ${cell}`).join(', ')
          return [
            `${this.prefix}${mark(i)}${i === marked ? this.#s.bold(key) : key}`,
            ...wrap(details, Math.max(10, this.#look.width - 7)).map(
              (part) => `${this.prefix}    ${part}`,
            ),
          ]
        })
    this.#space()
    this.#emit(
      [
        ...wrap(clean(table.title), Math.max(MIN_TEXT, this.#look.width - 3)).map(
          (part) => `${this.prefix}${this.#s.bold(part)}`,
        ),
        ...body,
        ...(table.notes ?? []).flatMap((note) =>
          wrap(clean(note), Math.max(MIN_TEXT, this.#look.width - 3)).map(
            (part) => `${this.prefix}${this.#s.dim(part)}`,
          ),
        ),
      ].join('\n'),
    )
    this.#spaced = false
  }

  /** A commitment as a compact receipt: what it is, its states so far, and where to check it. */
  receipt(receipt: Receipt): void {
    checkEvidence(receipt.evidence)
    const states = receipt.states
      .map((s) =>
        s.reached ? `${this.#s.ok('●')} ${clean(s.name)}` : this.#s.dim(`○ ${clean(s.name)}`),
      )
      .join('  ')
    this.#space()
    this.#emit(
      [
        `${this.prefix}${this.#s.bold(clean(receipt.title))}`,
        ...receipt.lines.flatMap((line) =>
          wrap(clean(line), Math.max(MIN_TEXT, this.#look.width - 3)).map(
            (part) => `${this.prefix}${part}`,
          ),
        ),
        `${this.prefix}${states}`,
        ...wrap(
          `At block ${receipt.evidence.block}, ${VERIFIED[receipt.evidence.verifiedBy]}, ${referenceLine(receipt.evidence)}`,
          Math.max(MIN_TEXT, this.#look.width - 3),
        ).map((part) => `${this.prefix}${this.#s.dim(part)}`),
        ...(receipt.link ? [`${this.prefix}${this.#s.dim(clean(receipt.link))}`] : []),
      ].join('\n'),
    )
    this.#spaced = false
  }

  /** Stops a spinner and clears its line, before anything else draws on the terminal. */
  settle(): void {
    if (!this.#spinner) return
    clearInterval(this.#spinner.timer)
    this.#spinner = null
    this.#write('\r\u001b[2K')
  }

  #turn(): void {
    const spinner = this.#spinner
    if (!spinner) return
    const frame = FRAMES[spinner.frame % FRAMES.length] as string
    spinner.frame += 1
    this.#write(`\r\u001b[2K${this.prefix}${this.#s.accent(frame)} ${spinner.text}`)
  }

  #space(): void {
    if (this.#spaced) return
    this.#emit(this.#s.dim('│'))
    this.#spaced = true
  }

  /** Text after a mark, laid to the terminal's width, its later lines carrying the rail on. */
  #block(mark: string, text: string, paint: Paint, rest: string = this.prefix): void {
    const [first = '', ...more] = wrap(text, Math.max(MIN_TEXT, this.#look.width - 3))
    this.#emit(
      [`${mark}  ${paint(first)}`, ...more.map((line) => `${rest}${paint(line)}`)].join('\n'),
    )
    this.#spaced = false
  }

  /** A ticked or failed item on the rail, its later lines hanging under its text. */
  #item(mark: string, text: string): void {
    const [first = '', ...more] = wrap(text, Math.max(MIN_TEXT, this.#look.width - 5))
    this.#emit(
      [`${this.prefix}${mark} ${first}`, ...more.map((line) => `${this.prefix}  ${line}`)].join(
        '\n',
      ),
    )
    this.#spaced = false
  }

  #emit(lines: string): void {
    this.settle()
    this.#endSpeech()
    this.#write(`${lines}\n`)
  }

  #speakPiece(piece: string): void {
    const speech = this.#speech
    if (!speech) return
    speech.pending += piece
    // Whole words go down as soon as the space after them arrives.
    for (let at = speech.pending.indexOf(' '); at >= 0; at = speech.pending.indexOf(' ')) {
      const word = speech.pending.slice(0, at)
      speech.pending = speech.pending.slice(at + 1)
      if (word !== '') this.#placeWord(speech, word)
    }
  }

  #placeWord(speech: Speech, word: string): void {
    const width = Math.max(MIN_TEXT + 3, this.#look.width)
    const room = speech.column + (speech.started ? 1 : 0) + word.length <= width
    if (speech.started && !room) {
      this.#write(`\n${this.prefix}${speech.hang}${word}`)
      speech.column = 3 + speech.hang.length + word.length
    } else {
      this.#write(`${speech.started ? ' ' : ''}${word}`)
      speech.column += (speech.started ? 1 : 0) + word.length
    }
    speech.started = true
  }

  #endSpeech(): void {
    const speech = this.#speech
    if (!speech) return
    if (speech.pending !== '') this.#placeWord(speech, speech.pending)
    this.#speech = null
    this.#write('\n')
  }
}

/**
 * Lines set apart from everything around them behind a bar in the brand's violet, the first in
 * bold, for the one moment a run is about, so it never reads as one more line of output.
 */
export function setApart(look: Look, lines: readonly string[]): string {
  const s = stylesOf(look)
  const bar = s.accent('▌')
  const width = Math.max(MIN_TEXT, look.width - 4)
  const body = lines.flatMap((line, i) =>
    wrap(clean(line), width).map((part) => `${bar}  ${i === 0 ? s.bold(part) : part}`),
  )
  return ['', ...body, ''].join('\n')
}
