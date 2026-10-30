import { z } from 'zod'
import type { Mandate } from './types.js'
import { mandateJson, type Parsed } from './wire.js'

/**
 * AP2's intent mandate, version 0.1, as `toAp2IntentMandate` writes it. Version 0.2 replaced the
 * intent mandate with checkout and payment mandates, which this package doesn't map yet.
 */
export interface Ap2IntentMandate {
  user_cart_confirmation_required: boolean
  natural_language_description: string
  merchants: string[] | null
  skus: string[] | null
  requires_refundability: boolean
  /** ISO 8601 */
  intent_expiry: string
}

/**
 * The cart confirmation flag every pair carries. AP2 0.1 requires it on any intent mandate the
 * user hasn't signed, and its intent mandate has no field for a signature, so a pair never carries
 * one. Asking the user to confirm every cart is at least as strict as any approval rule.
 */
const CART_CONFIRMATION_REQUIRED = true

/** The last moment an ISO 8601 time with a four-digit year can write, 9999-12-31T23:59:59Z. */
const LAST_ISO_SECOND = 253_402_300_799n

/**
 * AP2 0.1's intent mandate as a reader takes it. A field AP2 leaves optional reads as AP2 defines
 * it when it's left out. Merchants and SKUs read as null, which allows any, refundability as not
 * required, and the confirmation flag as true. AP2's reference implementation spells refundability
 * `requires_refundability`, and the example on its A2A extension spells it
 * `required_refundability`, so the reader takes both.
 */
const intentMandateJson = z.strictObject({
  user_cart_confirmation_required: z.boolean().default(true),
  natural_language_description: z.string(),
  merchants: z.array(z.string()).nullable().default(null),
  skus: z.array(z.string()).nullable().default(null),
  requires_refundability: z.boolean().nullable().default(null),
  required_refundability: z.boolean().nullable().default(null),
  intent_expiry: z.iso.datetime({ offset: true }),
})

/**
 * The parts of an Avow mandate AP2 0.1 has no field for, carried beside the intent mandate. Actions
 * and currency use the mandate's own schemas, and every other value stays a string here and parses
 * through the mandate's schema once it's mapped. Caps are micros and payment limits are the token's
 * base units, as decimal strings.
 */
const avowExtensionJson = z.strictObject({
  mandate_id: z.string(),
  business_id: z.string(),
  agent_id: z.string(),
  /** The business's account, whose root key signs the Avow mandate. */
  account: z.string(),
  agent_key: z.string(),
  actions: mandateJson.shape.actions,
  categories: z.array(z.string()),
  currency: mandateJson.shape.currency,
  cap_per_commitment: z.string(),
  cap_open_reserves: z.string(),
  payment_limits: z.array(
    z.strictObject({ token: z.string(), amount: z.string(), period_seconds: z.string() }),
  ),
  approval_rule: z.union([z.enum(['never', 'always']), z.strictObject({ above: z.string() })]),
  nonce: z.string(),
})
export type AvowMandateExtension = z.input<typeof avowExtensionJson>

const ap2PairJson = z.strictObject({ intent_mandate: intentMandateJson, avow: avowExtensionJson })

/**
 * Maps an Avow mandate onto AP2 0.1. Supplier business ids become AP2 merchants and the expiry
 * becomes the intent expiry. Every pair requires cart confirmation, whatever the approval rule.
 * Caps, limits, categories and the approval rule have no AP2 field, so they travel in the `avow`
 * extension. A mandate that expires after the year 9999, which an ISO 8601 time can't write, is
 * refused as `message.validity_too_long`.
 */
export function toAp2IntentMandate(
  m: Mandate,
  description: string,
): Parsed<{ intent_mandate: Ap2IntentMandate; avow: AvowMandateExtension }> {
  if (m.expiry > LAST_ISO_SECOND) return { ok: false, reason: 'message.validity_too_long' }
  const rule = m.approvalRule
  return {
    ok: true,
    value: {
      intent_mandate: {
        user_cart_confirmation_required: CART_CONFIRMATION_REQUIRED,
        natural_language_description: description,
        merchants: m.suppliers.length > 0 ? [...m.suppliers] : null,
        skus: null,
        requires_refundability: false,
        intent_expiry: new Date(Number(m.expiry) * 1000).toISOString(),
      },
      avow: {
        mandate_id: m.mandateId,
        business_id: m.businessId,
        agent_id: m.agentId,
        account: m.account,
        agent_key: m.agentKey,
        actions: [...m.actions],
        categories: [...m.categories],
        currency: m.currency,
        cap_per_commitment: m.capPerCommitment.toString(),
        cap_open_reserves: m.capOpenReserves.toString(),
        payment_limits: m.paymentLimits.map((l) => ({
          token: l.token,
          amount: l.amount.toString(),
          period_seconds: l.period.toString(),
        })),
        approval_rule: rule.kind === 'above' ? { above: rule.amount.toString() } : rule.kind,
        nonce: m.nonce.toString(),
      },
    },
  }
}

/** An ISO 8601 time as Unix seconds in a decimal string, or null when it has a part of a second. */
function wholeSeconds(iso: string): string | null {
  if (/\.\d*[1-9]/.test(iso)) return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? String(ms / 1000) : null
}

/**
 * Reads an Avow mandate back from a JSON value holding an AP2 0.1 intent mandate and the extension
 * it travels with, as an adapter that accepts AP2 would. The suppliers come from AP2's merchants
 * and the expiry from its intent expiry, and everything else from the extension, through the same
 * parser as any mandate. A shape either schema doesn't define, a time without an offset or with a
 * part of a second, and a value no mandate can hold are refused as `message.invalid`. A pair whose
 * intent mandate waives cart confirmation, names SKUs, requires refundability in either spelling
 * or allows no merchant says something the mandate doesn't, and is refused as
 * `mandate.ap2_mismatch`. The pair carries no signature, so the mandate it returns binds nobody
 * until the administrator's signature over it checks out.
 */
export function fromAp2IntentMandate(json: unknown): Parsed<Mandate> {
  const pair = ap2PairJson.safeParse(json)
  if (!pair.success) return { ok: false, reason: 'message.invalid' }
  const { intent_mandate: intent, avow } = pair.data
  const expiry = wholeSeconds(intent.intent_expiry)
  if (expiry === null) return { ok: false, reason: 'message.invalid' }
  const rule = avow.approval_rule
  const parsed = mandateJson.safeParse({
    mandateId: avow.mandate_id,
    businessId: avow.business_id,
    agentId: avow.agent_id,
    account: avow.account,
    agentKey: avow.agent_key,
    actions: avow.actions,
    currency: avow.currency,
    capPerCommitment: avow.cap_per_commitment,
    capOpenReserves: avow.cap_open_reserves,
    suppliers: intent.merchants ?? [],
    categories: avow.categories,
    paymentLimits: avow.payment_limits.map((l) => ({
      token: l.token,
      amount: l.amount,
      period: l.period_seconds,
    })),
    approvalRule: typeof rule === 'string' ? { kind: rule } : { kind: 'above', amount: rule.above },
    expiry,
    nonce: avow.nonce,
  } satisfies z.input<typeof mandateJson>)
  if (!parsed.success) return { ok: false, reason: 'message.invalid' }
  const agrees =
    intent.user_cart_confirmation_required === CART_CONFIRMATION_REQUIRED &&
    intent.skus === null &&
    !intent.requires_refundability &&
    !intent.required_refundability &&
    intent.merchants?.length !== 0
  return agrees ? { ok: true, value: parsed.data } : { ok: false, reason: 'mandate.ap2_mismatch' }
}
