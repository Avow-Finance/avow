import type { Mandate } from './types.js'
import { mandateJson, type Parsed } from './wire.js'

/**
 * AP2's intent mandate, version 0.1, as its A2A extension at ap2-protocol.org shows it. The
 * reference implementation spells the refundability field `requires_refundability`, while the
 * extension page's example spells it `required_refundability`. This follows the implementation.
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

/** The parts of an Avow mandate AP2 has no field for, carried beside the intent mandate. */
export interface AvowMandateExtension {
  mandate_id: string
  business_id: string
  agent_id: string
  /** The business's account, whose root key signs the Avow mandate. */
  account: string
  agent_key: string
  actions: string[]
  categories: string[]
  currency: string
  cap_per_commitment: string
  cap_open_reserves: string
  payment_limits: { token: string; amount: string; period_seconds: string }[]
  approval_rule: 'never' | 'always' | { above: string }
  /** A decimal string. */
  nonce: string
}

/**
 * Maps an Avow mandate onto AP2. Supplier business ids become AP2 merchants. AP2 can't say
 * "confirm above an amount", so any mandate that ever asks the administrator maps to cart
 * confirmation required, which is stricter than the Avow mandate and never looser. Caps, limits
 * and categories have no AP2 field, so they travel in the `avow` extension. Amounts there are
 * decimal strings, in micros for caps and in token base units for payment limits.
 */
export function toAp2IntentMandate(
  m: Mandate,
  description: string,
): { intent_mandate: Ap2IntentMandate; avow: AvowMandateExtension } {
  const rule = m.approvalRule
  return {
    intent_mandate: {
      user_cart_confirmation_required: rule.kind !== 'never',
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
  }
}

/**
 * Reads an Avow mandate back from an AP2 intent mandate and the extension it travels with, as an
 * adapter that accepts AP2 would. The suppliers come from AP2's merchants and the expiry from its
 * intent expiry, and everything else from the extension, through the same parser as any mandate.
 * Where both carry a meaning they have to agree: confirmation is required exactly when the
 * approval rule ever asks, so the intent mandate can't loosen the rule. AP2's SKUs and
 * refundability have no Avow meaning, and a pair that sets either is refused, as is an expiry
 * that isn't a whole second.
 */
export function fromAp2IntentMandate(pair: {
  intent_mandate: Ap2IntentMandate
  avow: AvowMandateExtension
}): Parsed<Mandate> {
  const { intent_mandate: intent, avow } = pair
  const rule = avow.approval_rule
  const expiryMs = Date.parse(intent.intent_expiry)
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
    expiry: Number.isInteger(expiryMs / 1000) ? String(expiryMs / 1000) : 'not a whole second',
    nonce: avow.nonce,
  })
  if (!parsed.success) return { ok: false, reason: 'message.invalid' }
  const mandate = parsed.data
  const agrees =
    intent.skus === null &&
    !intent.requires_refundability &&
    intent.merchants?.length !== 0 &&
    intent.user_cart_confirmation_required === (mandate.approvalRule.kind !== 'never')
  return agrees ? { ok: true, value: mandate } : { ok: false, reason: 'mandate.ap2_mismatch' }
}
