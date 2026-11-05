import { type Look, type Paint, type Styles, stylesOf, wrap } from './look.js'

/** Where a rail draws, which in the tools is the terminal's output. */
export type Write = (text: string) => void

/** A commitment as the terminal shows it. */
export interface Receipt {
  /** What it is, such as the job commitment and its id. */
  readonly title: string
  /** A sentence or two on who reserved what for whom, and what the reserve covers. */
  readonly lines: readonly string[]
  /** Its states in order, each reached or not yet. */
  readonly states: readonly { readonly name: string; readonly reached: boolean }[]
  /** Where anyone can check it. */
  readonly link?: string
}

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
    this.#block(this.#s.dim('┌'), title, this.#s.bold)
  }

  /** A stage starting. */
  stage(title: string): void {
    this.#space()
    this.#block(this.#s.dim('◇'), title, this.#s.bold)
  }

  /** A question, whose answer is typed on the line after it. */
  ask(question: string): void {
    this.#space()
    this.#block(this.#s.accent('◆'), question, this.#s.bold)
  }

  /** A sentence to read. */
  line(text: string): void {
    this.#block(this.#s.dim('│'), text, plain)
  }

  /** Something done. */
  done(text: string): void {
    this.#item(this.#s.ok('✓'), text)
  }

  /** Something that failed. */
  fail(text: string): void {
    this.#item(this.#s.bad('✗'), text)
  }

  /**
   * Something under way, with a spinner turning beside it until the next thing is drawn. Where the
   * terminal can't draw a line again, it shows once, still.
   */
  wait(text: string): void {
    this.settle()
    if (!this.#look.live) {
      this.#emit(`${this.prefix}${text}`)
      return
    }
    const spinner = { timer: setInterval(() => this.#turn(), FRAME_MS), frame: 0, text }
    spinner.timer.unref?.()
    this.#spinner = spinner
    this.#turn()
  }

  /**
   * Puts `text` on the line just typed on, such as to say a passphrase was set where nothing was
   * shown as it was typed. Where the terminal can't draw a line again, the line stays as typed.
   */
  answered(text: string): void {
    this.settle()
    if (this.#look.live) this.#write(`\u001b[1A\r\u001b[2K${this.prefix}${text}\n`)
    this.#spaced = false
  }

  /** The rail's last line, with the outcome. */
  close(text: string): void {
    this.#space()
    this.#block(this.#s.dim('└'), text, this.#s.bold, '   ')
  }

  /**
   * Words a model or an agent said, in its own name, with the name in the brand's violet so they
   * never read as something a tool did or a check proved.
   */
  said(speaker: string, text: string): void {
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
  speak(speaker: string): { write: (piece: string) => void; end: () => void } {
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
      write: (piece) => this.#speakPiece(piece),
      end: () => this.#endSpeech(),
    }
  }

  /** What goes before a message the developer types to the agent. */
  get you(): string {
    return `${this.prefix}${this.#s.dim('you ›')} `
  }

  /** A quieter line, such as what typing to the agent can and can't change. */
  quiet(text: string): void {
    this.#block(this.#s.dim('│'), text, this.#s.dim)
  }

  /** A tool the model called, by name, with what it was called on. */
  call(tool: string, detail = ''): void {
    const words =
      detail === '' ? this.#s.bold(tool) : `${this.#s.bold(tool)} ${this.#s.dim(detail)}`
    this.#emit(`${this.prefix}${this.#s.dim('↳')} ${words}`)
    this.#spaced = false
  }

  /** What the tool just called gave back, under it, ticked or refused. */
  returned(ok: boolean, text: string): void {
    const mark = ok ? this.#s.ok('✓') : this.#s.bad('✗')
    const [first = '', ...more] = wrap(text, Math.max(MIN_TEXT, this.#look.width - 7))
    this.#emit(
      [`${this.prefix}  ${mark} ${first}`, ...more.map((line) => `${this.prefix}    ${line}`)].join(
        '\n',
      ),
    )
    this.#spaced = false
  }

  /**
   * A fact code outside the model verified, with the block it was read at, since a check proves
   * the state at that block and nothing after it.
   */
  fact(block: bigint | number, text: string): void {
    this.#item(this.#s.ok('∎'), `${this.#s.dim(`At block ${block},`)} ${text}`)
  }

  /** A commitment as a compact receipt: what it is, its states so far, and where to check it. */
  receipt(receipt: Receipt): void {
    const states = receipt.states
      .map((s) => (s.reached ? `${this.#s.ok('●')} ${s.name}` : this.#s.dim(`○ ${s.name}`)))
      .join('  ')
    this.#space()
    this.#emit(
      [
        `${this.prefix}${this.#s.bold(receipt.title)}`,
        ...receipt.lines.flatMap((line) =>
          wrap(line, Math.max(MIN_TEXT, this.#look.width - 3)).map(
            (part) => `${this.prefix}${part}`,
          ),
        ),
        `${this.prefix}${states}`,
        ...(receipt.link ? [`${this.prefix}${this.#s.dim(receipt.link)}`] : []),
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
    // Whole words go down as soon as the space or line break after them arrives.
    for (let at = speech.pending.search(/[ \n]/); at >= 0; at = speech.pending.search(/[ \n]/)) {
      const word = speech.pending.slice(0, at)
      const breaks = speech.pending[at] === '\n'
      speech.pending = speech.pending.slice(at + 1)
      if (word !== '') this.#placeWord(speech, word)
      if (breaks && speech.started) {
        this.#write(`\n${this.prefix}${speech.hang}`)
        speech.column = 3 + speech.hang.length
        speech.started = false
      }
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
    wrap(line, width).map((part) => `${bar}  ${i === 0 ? s.bold(part) : part}`),
  )
  return ['', ...body, ''].join('\n')
}
