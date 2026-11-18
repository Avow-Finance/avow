import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

// Signing follows the Standard Webhooks specification, so a receiver in any language can check a
// delivery with that project's libraries. The secret is `whsec_` and base64, and the signature is
// HMAC-SHA256 over `${id}.${timestamp}.${body}`, sent as `v1,` and base64.

const SECRET = /^whsec_([A-Za-z0-9+/]{32,}={0,2})$/
const TIMESTAMP = /^[0-9]{1,15}$/

/** Whether a string is a webhook secret this adapter can sign with. */
export const isWebhookSecret = (secret: string) => SECRET.test(secret)

/** A new webhook secret, 32 random bytes. */
export const makeWebhookSecret = () => `whsec_${randomBytes(32).toString('base64')}`

function keyOf(secret: string): Buffer {
  const match = SECRET.exec(secret)
  if (!match?.[1]) throw new Error('A webhook secret is whsec_ followed by base64')
  return Buffer.from(match[1], 'base64')
}

/**
 * The `webhook-signature` header value for a delivery. The timestamp is signed as the header
 * carries it, whole seconds in decimal.
 */
export function signWebhook(secret: string, id: string, timestamp: string, body: string): string {
  const mac = createHmac('sha256', keyOf(secret)).update(`${id}.${timestamp}.${body}`).digest()
  return `v1,${mac.toString('base64')}`
}

/**
 * Whether a delivery came from this adapter: its signature matches the body under the secret and
 * its timestamp is within five minutes of now, so an old delivery can't be replayed. It checks a
 * delivery the way a Standard Webhooks library does, and the tests check deliveries with it.
 */
export function verifyWebhook(
  secret: string,
  headers: { id: string; timestamp: string; signature: string },
  body: string,
  nowSeconds: number,
  toleranceSeconds = 300,
): boolean {
  if (!TIMESTAMP.test(headers.timestamp)) return false
  if (Math.abs(nowSeconds - Number(headers.timestamp)) > toleranceSeconds) return false
  const expected = Buffer.from(signWebhook(secret, headers.id, headers.timestamp, body))
  return headers.signature.split(' ').some((given) => {
    const g = Buffer.from(given)
    return g.length === expected.length && timingSafeEqual(g, expected)
  })
}
