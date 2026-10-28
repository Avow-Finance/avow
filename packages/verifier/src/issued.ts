/**
 * The prepared messages this library built. A signing call signs only one of these, as it was
 * built, so a copy or an edit can't carry a message past the checks or past the disclosure the
 * person confirmed.
 */
const issued = new WeakSet<object>()

function freeze(value: unknown): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return
  for (const inner of Object.values(value)) freeze(inner)
  Object.freeze(value)
}

/** Freezes a prepared result all the way down and records it as one this library built. */
export function issue<T extends object>(value: T): T {
  freeze(value)
  issued.add(value)
  return value
}

/** Whether this library built the value and nothing has replaced it. */
export function wasIssued(value: unknown): boolean {
  return typeof value === 'object' && value !== null && issued.has(value)
}
