/** Whether a value is a string of 1 to `max` characters, the text fields every template reads. */
export const isText = (v: unknown, max = Number.POSITIVE_INFINITY): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max

/** Whether a value is text of 1 to `max` characters that isn't only whitespace. */
export const isFilled = (v: unknown, max: number): v is string =>
  isText(v, max) && v.trim().length > 0
