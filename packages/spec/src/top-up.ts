import { z } from 'zod'
import type { Parsed } from './wire.js'

/**
 * A top-up of a sandbox business's test dollars. Avow's sandbox faucet sends them to the
 * business's own account on Tempo, never to its lock, so a top-up changes no mandate and no limit:
 * an agent still reserves only what its mandate allows. The business's root key or any agent it
 * approved and hasn't revoked asks for one, and a business gets at most one a day.
 */

/** How long after one top-up the next can be asked for, in seconds. */
export const TOP_UP_EVERY = 86_400

const unixSeconds = z.string().regex(/^\d{1,20}$/)

/**
 * Avow's answer to a top-up. `sent` means the faucet signed a transfer of `amount`, in the reserve
 * token's base units, which is `pending` until it lands on Tempo. `not_yet` means the business had
 * its top-up for the day, and nothing was sent. Both say in `nextAt` when the business can ask
 * again.
 */
export const topUpJson = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('sent'),
    amount: z.string().regex(/^[1-9]\d{0,29}$/),
    transactionHash: z.string().regex(/^0x[0-9a-f]{64}$/),
    outcome: z.enum(['pending', 'landed']),
    nextAt: unixSeconds,
  }),
  z.strictObject({ state: z.literal('not_yet'), nextAt: unixSeconds }),
])

export type TopUp = z.infer<typeof topUpJson>

/** Reads Avow's answer to a top-up. */
export function parseTopUp(json: unknown): Parsed<TopUp> {
  const parsed = topUpJson.safeParse(json)
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, reason: 'message.invalid' }
}
