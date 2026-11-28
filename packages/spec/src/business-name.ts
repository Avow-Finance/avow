import { SERVICE_NAME_MAX } from './service.js'
import { isFilled } from './text.js'

/**
 * The most characters a business's name has when it registers with Avow. It is the most an offer
 * search's result carries for a supplier, so every business that registers now is listed under the
 * name it gave.
 */
export const BUSINESS_NAME_MAX = SERVICE_NAME_MAX

/** What a business is told when the name it registers with doesn't fit `BUSINESS_NAME_MAX`. */
export const BUSINESS_NAME_RULE = `A business's name has to be 1 to ${BUSINESS_NAME_MAX} characters, and not only spaces.`

/** Whether a new business may register under a name. */
export const businessNameFits = (name: unknown): name is string => isFilled(name, BUSINESS_NAME_MAX)

/** The mark a shortened name ends with, one character long. */
const ELLIPSIS = '…'

/**
 * A registered name as a result carries it. A business that registered before names were capped
 * may hold a longer one, which is shortened to `BUSINESS_NAME_MAX` characters ending in an
 * ellipsis, so the supplier is still listed. It cuts between characters and never through one, and
 * drops spaces left before the ellipsis.
 */
export function shownBusinessName(name: string): string {
  if (name.length <= BUSINESS_NAME_MAX) return name
  let kept = ''
  for (const ch of name) {
    if (kept.length + ch.length > BUSINESS_NAME_MAX - ELLIPSIS.length) break
    kept += ch
  }
  return `${kept.trimEnd()}${ELLIPSIS}`
}
