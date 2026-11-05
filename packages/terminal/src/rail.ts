import { type Look, type Paint, type Styles, stylesOf, wrap } from './look.js'

/** Where a rail draws, which in the tools is the terminal's output. */
export type Write = (text: string) => void

/** The frames of the spinner a step turns while it takes time, and how long each shows. */
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const
const FRAME_MS = 80

/** The narrowest the rail lays its text, however narrow the terminal. */
const MIN_TEXT = 24

const plain: Paint = (text) => text

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
    this.#write(`${lines}\n`)
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
