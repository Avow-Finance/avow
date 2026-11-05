/** What a terminal can show: how many colours, whether a line can be drawn again, and its width. */
export interface Look {
  /** The colours it takes: none, the 16 basic ones, 256, or any. */
  readonly colors: 0 | 16 | 256 | 'rgb'
  /** Whether a line can be drawn again in place, as a spinner needs. */
  readonly live: boolean
  /** Its width in columns. */
  readonly width: number
}

/** The parts of an output stream a look reads. */
export interface Screen {
  readonly isTTY?: boolean
  readonly columns?: number
}

type Env = Readonly<Record<string, string | undefined>>

/**
 * The look of an output stream. Colour follows the usual settings: NO_COLOR turns it off,
 * FORCE_COLOR turns it on at a level, and otherwise a terminal gets it and a pipe or a file doesn't.
 */
export function lookOf(screen: Screen, env: Env = process.env): Look {
  const tty = screen.isTTY === true && env.TERM !== 'dumb'
  const width = screen.columns !== undefined && screen.columns > 0 ? screen.columns : 80
  return { colors: colorsOf(tty, env), live: tty, width }
}

function colorsOf(tty: boolean, env: Env): Look['colors'] {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return 0
  const forced = env.FORCE_COLOR
  if (forced === '0' || forced === 'false') return 0
  if (forced === undefined && !tty) return 0
  if (forced === '3' || env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit') return 'rgb'
  if (forced === '2' || /256/.test(env.TERM ?? '')) return 256
  return 16
}

/** A way to paint text, which leaves it as it is where the terminal takes no colour. */
export type Paint = (text: string) => string

/** The styles Avow's tools use: weight, a quieter tone, the brand's violet, and two outcomes. */
export interface Styles {
  readonly bold: Paint
  readonly dim: Paint
  readonly accent: Paint
  readonly ok: Paint
  readonly bad: Paint
}

const plain: Paint = (text) => text

const sgr =
  (open: string, close: string): Paint =>
  (text) =>
    `\u001b[${open}m${text}\u001b[${close}m`

/** A colour from avow.finance's palette, at the nearest the terminal can show. */
function color(look: Look, rgb: readonly [number, number, number], at256: number, at16: number) {
  if (look.colors === 'rgb') return sgr(`38;2;${rgb.join(';')}`, '39')
  if (look.colors === 256) return sgr(`38;5;${at256}`, '39')
  return sgr(String(at16), '39')
}

/** The styles a look can show, all plain where it takes no colour. */
export function stylesOf(look: Look): Styles {
  if (look.colors === 0) return { bold: plain, dim: plain, accent: plain, ok: plain, bad: plain }
  return {
    bold: sgr('1', '22'),
    dim: sgr('2', '22'),
    // The site's focus violet, which reads on a light terminal and on a dark one.
    accent: color(look, [120, 86, 240], 99, 35),
    // The site's tick green.
    ok: color(look, [63, 203, 149], 79, 32),
    bad: color(look, [229, 72, 77], 167, 31),
  }
}

/** Text without its colour codes, as it shows on the screen. */
export function visible(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: colour codes start with an escape
  return text.replace(/\u001b\[[0-9;]*m/g, '')
}

/**
 * The combining diacritical marks, the one range every terminal draws over the character before
 * it. Every other mark counts as a column of its own, since terminals disagree about them, and a
 * row measured too wide only wraps a little early, while one measured too narrow runs past the
 * terminal.
 */
const ZERO: readonly (readonly [number, number])[] = [[0x0300, 0x036f]]

/**
 * Ranges of characters a terminal draws two columns wide: East Asian wide and fullwidth
 * characters, the historic scripts some tables draw wide, and emoji. Where a range is uncertain it
 * counts as wide, for the same reason.
 */
const WIDE: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23f3],
  [0x2600, 0x27bf],
  [0x2b00, 0x2bff],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x16fe0, 0x16fff],
  [0x17000, 0x18d8f],
  [0x1aff0, 0x1b2ff],
  [0x1f000, 0x1faff],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
]

const within = (cp: number, ranges: readonly (readonly [number, number])[]) =>
  ranges.some(([from, to]) => cp >= from && cp <= to)

/** How many columns a terminal draws one character in: 0, 1 or 2. */
export function charWidth(char: string): number {
  const cp = char.codePointAt(0) ?? 0
  if (within(cp, ZERO)) return 0
  return within(cp, WIDE) ? 2 : 1
}

/** How many columns a terminal draws `text` in, counting wide characters as two. */
export function displayWidth(text: string): number {
  let width = 0
  for (const char of text) width += charWidth(char)
  return width
}

/** A word cut into pieces no wider than `room` columns, never inside a character. */
function pieces(word: string, room: number): string[] {
  const out: string[] = []
  let piece = ''
  let used = 0
  for (const char of word) {
    const w = charWidth(char)
    if (piece !== '' && used + w > room) {
      out.push(piece)
      piece = ''
      used = 0
    }
    piece += char
    used += w
  }
  out.push(piece)
  return out
}

/**
 * Plain text laid into lines no wider than `width` columns, broken between words, with wide
 * characters counted as two. A word longer than the width is broken inside itself. So no line
 * ever runs past the terminal and gets wrapped by the terminal instead, where it would start a
 * row without the rail's own prefix.
 */
export function wrap(text: string, width: number): string[] {
  const room = Math.max(1, Math.floor(width))
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    let used = 0
    for (const whole of paragraph.split(' ')) {
      for (const word of pieces(whole, room)) {
        const w = displayWidth(word)
        if (line === '') {
          line = word
          used = w
        } else if (used + 1 + w <= room) {
          line += ` ${word}`
          used += 1 + w
        } else {
          lines.push(line)
          line = word
          used = w
        }
      }
    }
    lines.push(line)
  }
  return lines
}
