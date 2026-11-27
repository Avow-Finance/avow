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
 * Whether a character changes how text reads without showing: a control, a line or paragraph break,
 * or a mark that sets direction or hides. They are named by code point, so every runtime agrees.
 */
const isUnseen = (c: number) =>
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
const QUOTE =
  /["\u00ab\u00bb\u02ba\u02dd\u02ee\u05f4\u201c-\u201f\u2033\u2036\u275d\u275e\u2e42\u3003\u301d-\u301f\uff02]|''|``/

/**
 * Whether a value is sound text that reads as it's written, on one line, with no space at either
 * end and nothing that reads as a double quote. A name one party writes and another reads on a
 * signing card has to be, or it could pose as a line the card wrote. A card shows such text in
 * double quotes, so a quote inside it would end the quoting early. The quotes keep an agent's words
 * apart from the card's, and a person still reads what the words say.
 */
export const isPlainText = (v: unknown, max: number): v is string =>
  isSoundText(v, max) &&
  v === v.trim() &&
  !QUOTE.test(v) &&
  !Array.from(v).some((ch) => isUnseen(ch.codePointAt(0) as number))
