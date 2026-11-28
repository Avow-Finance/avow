import { SERVICE_NAME_MAX } from './service.js'
import { isPlainText, markedUnplain } from './text.js'

/**
 * The most characters a business's name has when it registers with Avow. It is the most an offer
 * search's result carries for a supplier, so every business that registers now is listed under the
 * name it gave.
 */
export const BUSINESS_NAME_MAX = SERVICE_NAME_MAX

/**
 * The most characters a registration may carry, which is the cap names had before
 * `BUSINESS_NAME_MAX`. A business Avow registered then can send its setup again under the name it
 * holds, and Avow answers it under that name. A new business is held to `businessNameFits`.
 */
export const HELD_BUSINESS_NAME_MAX = 200

/** What a business is told when the name it registers with doesn't fit `businessNameFits`. */
export const BUSINESS_NAME_RULE = `A business's name has to be 1 to ${BUSINESS_NAME_MAX} characters on one line, with no space at either end, nothing that reads as a double quote, and no character that hides or changes how the text around it reads.`

/**
 * Whether a new business may register under a name. Other businesses' agents read it in search
 * results and people read it on cards, so it has to be plain text by `isPlainText`, which keeps it
 * from posing as a line a card wrote or reordering the words after it.
 */
export const businessNameFits = (name: unknown): name is string =>
  isPlainText(name, BUSINESS_NAME_MAX)

/** The mark a shortened name ends with, one character long. */
const ELLIPSIS = '…'

/**
 * A registered name as a result carries it, which `businessNameFits` passes unless it's blank. A
 * business that registered before names were capped may hold a name that isn't plain text, and
 * each character that fails shows as its code point in brackets, the way a card quotes an agent's
 * label. A name still longer than `BUSINESS_NAME_MAX` is shortened to it, ending in an ellipsis, so
 * the supplier is still listed. It cuts between characters and never through one, and drops
 * spaces left before the ellipsis. A blank name comes back empty, which no result carries.
 */
export function shownBusinessName(name: string): string {
  const marked = markedUnplain(name.trim())
  if (marked.length <= BUSINESS_NAME_MAX) return marked
  let kept = ''
  for (const ch of marked) {
    if (kept.length + ch.length > BUSINESS_NAME_MAX - ELLIPSIS.length) break
    kept += ch
  }
  return `${kept.trimEnd()}${ELLIPSIS}`
}
