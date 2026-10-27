import type { Mandate } from './types.js'

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
  agent_key: string
  categories: string[]
  currency: string
  cap_per_commitment: string
  cap_open_reserves: string
  payment_limits: { token: string; amount: string; period_seconds: string }[]
  approval_rule: 'never' | 'always' | { above: string }
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
      agent_key: m.agentKey,
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
    },
  }
}
