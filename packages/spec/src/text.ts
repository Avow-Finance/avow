import { isWellFormedText } from './canonical.js'

/** Whether a value is a string of 1 to `max` characters, the text fields every template reads. */
export const isText = (v: unknown, max = Number.POSITIVE_INFINITY): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max

/** Whether a value is text of 1 to `max` characters that isn't only whitespace. */
export const isFilled = (v: unknown, max: number): v is string =>
  isText(v, max) && v.trim().length > 0

/**
 * Whether a value is filled text that is also well-formed Unicode, with no half of a character in
 * it. Text that is hashed has to be, since canonical JSON refuses any other and a signed string
 * would stand for a different one.
 */
export const isSoundText = (v: unknown, max: number): v is string =>
  isFilled(v, max) && isWellFormedText(v)

/**
 * The variation selector that asks for an emoji's colour form. A phone adds it after many emoji, so
 * right after a pictograph it changes only how that emoji shows, and anywhere else it hides.
 */
const EMOJI_PRESENTATION = 0xfe0f
const PICTOGRAPH = /^\p{Extended_Pictographic}$/u

/** Every format character, which shows nothing of its own and can hide or reorder text. */
const FORMAT = /^\p{Cf}$/u

/**
 * Whether a character changes how text reads without showing: a control, a line or paragraph break,
 * a format character, a variation selector, the combining grapheme joiner, or a mark that sets
 * direction or hides. Most are named by code point, so every runtime agrees, and every format
 * character is caught besides, such as the Arabic number signs from U+0600 and the Egyptian
 * hieroglyph format controls from U+13430.
 */
const isUnseen = (c: number) =>
  FORMAT.test(String.fromCodePoint(c)) ||
  c === 0x34f ||
  (c >= 0xfe00 && c <= 0xfe0f) ||
  (c >= 0xe0100 && c <= 0xe01ef) ||
  c <= 0x1f ||
  (c >= 0x7f && c <= 0x9f) ||
  c === 0xad ||
  c === 0x61c ||
  c === 0x180e ||
  (c >= 0x200b && c <= 0x200f) ||
  (c >= 0x2028 && c <= 0x202f) ||
  (c >= 0x2060 && c <= 0x206f) ||
  c === 0xfeff ||
  (c >= 0xfff9 && c <= 0xfffb) ||
  (c >= 0xe0000 && c <= 0xe007f) ||
  // Blanks that take up room and show nothing: the wide space, the Hangul fillers and blank Braille.
  c === 0x3000 ||
  c === 0x115f ||
  c === 0x1160 ||
  c === 0x3164 ||
  c === 0xffa0 ||
  c === 0x2800

/**
 * Marks that read as a double quote: the plain one, the curly and angled ones, and the lookalikes
 * from other scripts and widths. Two apostrophes or two backticks side by side read as one too.
 */
const QUOTE_MARK =
  /["\u00ab\u00bb\u02ba\u02dd\u02ee\u05f4\u201c-\u201f\u2033\u2036\u275d\u275e\u2e42\u3003\u301d-\u301f\uff02]/

/**
 * Whether a value is sound text that reads as it's written, on one line, with no space at either
 * end and nothing that reads as a double quote. A name one party writes and another reads on a
 * signing card has to be, or it could pose as a line the card wrote. A card shows such text in
 * double quotes, so a quote inside it would end the quoting early. The quotes keep an agent's words
 * apart from the card's, and a person still reads what the words say.
 */
export const isPlainText = (v: unknown, max: number): v is string =>
  isSoundText(v, max) && v === v.trim() && unplainMarks(v).length === 0

/** Why one character keeps text from being plain. */
export type UnplainKind = 'unseen' | 'quote' | 'pair' | 'half'

/** One character that keeps text from being plain, at its place counted in code points from 1. */
export interface UnplainMark {
  at: number
  codePoint: number
  kind: UnplainKind
}

/**
 * The characters that keep `isPlainText` from passing a value of the right length, in order. It is
 * the one form of the rule on characters, which `isPlainText` reads. U+FE0F right after a
 * pictograph is left alone, since it only asks for the emoji's colour form. Both characters of an
 * apostrophe or backtick pair are marked. It finds nothing to mark in a value that is too long,
 * empty or padded, which `isPlainText` refuses on its own.
 */
export function unplainMarks(v: string): UnplainMark[] {
  const chars = Array.from(v)
  const marks: UnplainMark[] = []
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] as string
    const codePoint = ch.codePointAt(0) as number
    const at = i + 1
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) marks.push({ at, codePoint, kind: 'half' })
    else if (codePoint === EMOJI_PRESENTATION && PICTOGRAPH.test(chars[i - 1] ?? '')) continue
    else if (isUnseen(codePoint)) marks.push({ at, codePoint, kind: 'unseen' })
    else if (QUOTE_MARK.test(ch)) marks.push({ at, codePoint, kind: 'quote' })
    else if ((ch === "'" || ch === '`') && chars[i + 1] === ch) {
      marks.push({ at, codePoint, kind: 'pair' }, { at: at + 1, codePoint, kind: 'pair' })
      i++
    }
  }
  return marks
}

/** A code point as a person reads its name, such as U+202E. */
export const codePointName = (c: number) => `U+${c.toString(16).toUpperCase().padStart(4, '0')}`

/**
 * Text with each character `unplainMarks` finds written as its code point in brackets, so a value
 * held from before a rule for plain text can neither hide nor reorder what follows it. Text that is
 * plain already comes back as it is.
 */
export function markedUnplain(v: string): string {
  const marked = new Set(unplainMarks(v).map((m) => m.at))
  if (marked.size === 0) return v
  return (Array.from(v) as string[])
    .map((ch, i) => (marked.has(i + 1) ? `[${codePointName(ch.codePointAt(0) as number)}]` : ch))
    .join('')
}

/**
 * Text another party wrote, as a line shows it, between double quotes with each character
 * `unplainMarks` finds written as its code point. A name held from before a rule for plain text
 * can then neither end the quotes early, break the line, nor reorder what follows.
 */
export const quotedText = (v: string): string => `"${markedUnplain(v)}"`
