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
  (c >= 0xe0000 && c <= 0xe007f)

/**
 * Whether a value is sound text that reads as it's written, on one line, with no space at either
 * end. A name one party writes and another reads on a signing card has to be, or it could pose as
 * a line the card wrote.
 */
export const isPlainText = (v: unknown, max: number): v is string =>
  isSoundText(v, max) &&
  v === v.trim() &&
  !Array.from(v).some((ch) => isUnseen(ch.codePointAt(0) as number))
