import { z } from 'zod'
import type { Parsed } from './wire.js'

/**
 * A check of a sandbox business's company registration and the people behind it, run by a checker
 * Avow names. The business's root key starts it and reads where it stands, and a person finishes
 * it on the checker's page. A check changes no standing of the business and no limit on its
 * agents, and a checker that runs in its own sandbox confirms nothing about a real business.
 */

/** Who checks a sandbox business. */
export const BUSINESS_CHECKERS = ['didit'] as const

const checked = {
  by: z.enum(BUSINESS_CHECKERS),
  /** The checker ran in its own sandbox, so nothing about the business was confirmed. */
  simulated: z.boolean(),
}
/** When Avow recorded the checker's decision, in unix seconds. */
const decidedAt = z.string().regex(/^\d{1,20}$/)

/**
 * Where a business's check stands. `not_available` means the deployment runs no checker, and
 * `not_started` that the business never started a check or its last one lapsed unfinished. Only
 * `started` carries the checker's page.
 */
export const businessCheckJson = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('not_available') }),
  z.strictObject({ state: z.literal('not_started') }),
  z.strictObject({
    state: z.literal('started'),
    ...checked,
    /** The checker's page, where a person finishes the check. */
    url: z.url({ protocol: /^https$/ }),
  }),
  z.strictObject({ state: z.literal('in_review'), ...checked }),
  z.strictObject({ state: z.literal('passed'), ...checked, decidedAt }),
  z.strictObject({ state: z.literal('declined'), ...checked, decidedAt }),
])

export type BusinessCheck = z.infer<typeof businessCheckJson>

/** Reads Avow's answer about a business's check. */
export function parseBusinessCheck(json: unknown): Parsed<BusinessCheck> {
  const parsed = businessCheckJson.safeParse(json)
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, reason: 'message.invalid' }
}
