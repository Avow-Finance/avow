/**
 * How Avow delivers commitment events to the addresses a business adds, and how a receiver checks
 * a delivery: the headers, the time window, the keys' lifetime and the retry schedule. They're
 * defined once here, for the sender and every receiver.
 */

/**
 * The headers every delivery carries. The first three are Standard Webhooks' own. The key id is
 * Avow's, since Standard Webhooks has none, and names which of the keys at `EVENT_KEYS_PATH`
 * signed the delivery.
 */
export const EVENT_DELIVERY_HEADERS = {
  id: 'webhook-id',
  timestamp: 'webhook-timestamp',
  signature: 'webhook-signature',
  keyId: 'avow-key-id',
} as const

/** Where Avow's API serves the keys it signs deliveries with. */
export const EVENT_KEYS_PATH = '/v1/events/keys'

/**
 * How far, in seconds, a delivery's timestamp may be from the receiver's clock, the window
 * Standard Webhooks and the supplier adapter use. A delivery outside it is refused as a replay.
 */
export const EVENT_DELIVERY_TOLERANCE = 300n

/** How long, in seconds, Avow keeps serving a key after a newer one replaced it. */
export const RETIRED_KEY_OVERLAP = 7n * 86_400n

/** The longest, in seconds, a receiver caches Avow's keys. */
export const EVENT_KEYS_CACHE = 300n

/** The type of the delivery that asks an address to prove Avow may send to it. */
export const CHALLENGE_TYPE = 'avow.endpoint.challenge'

/**
 * When a webhook is tried again: after each failed try the next wait, then the last wait over and
 * over, until `giveUpAfterMs` after the first try. The supplier adapter's webhook keeps to it, and
 * so do Avow's deliveries of commitment events, so a receiver of both sees retries arrive alike.
 */
export const WEBHOOK_RETRY_SCHEDULE = {
  retryAfterMs: [5_000, 30_000, 120_000, 600_000, 1_800_000, 3_600_000, 10_800_000],
  giveUpAfterMs: 3 * 24 * 3_600_000,
} as const satisfies { retryAfterMs: readonly number[]; giveUpAfterMs: number }
