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
 * Plain text laid into lines no wider than `width`, broken between words. A word longer than the
 * width, such as a link, keeps a line of its own whole, so it still works when copied.
 */
export function wrap(text: string, width: number): string[] {
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const word of paragraph.split(' ')) {
      if (line === '') line = word
      else if (line.length + 1 + word.length <= width) line += ` ${word}`
      else {
        lines.push(line)
        line = word
      }
    }
    lines.push(line)
  }
  return lines
}
