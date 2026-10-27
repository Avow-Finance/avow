import { describe, expect, it } from 'vitest'
import { toAp2IntentMandate } from './ap2.js'
import { dollars } from './demo.js'
import { demoMandate, newKey, TOKEN } from './test-helpers.js'

const mandate = demoMandate(newKey().address, newKey().address)

describe('toAp2IntentMandate', () => {
  it("maps suppliers onto AP2's merchants and the expiry onto an ISO date", () => {
    const { intent_mandate } = toAp2IntentMandate(mandate, 'Book GPUs for training runs')
    expect(intent_mandate.merchants).toEqual(['biz_supplier'])
    expect(intent_mandate.natural_language_description).toBe('Book GPUs for training runs')
    expect(intent_mandate.intent_expiry).toBe(new Date(Number(mandate.expiry) * 1000).toISOString())
    expect(intent_mandate.skus).toBeNull()
    expect(intent_mandate.requires_refundability).toBe(false)
  })

  it('leaves merchants open when the mandate limits categories only', () => {
    const { intent_mandate } = toAp2IntentMandate({ ...mandate, suppliers: [] }, 'Any GPU supplier')
    expect(intent_mandate.merchants).toBeNull()
  })

  it('asks for confirmation whenever the mandate ever asks the administrator', () => {
    const confirm = (rule: typeof mandate.approvalRule) =>
      toAp2IntentMandate({ ...mandate, approvalRule: rule }, 'x').intent_mandate
        .user_cart_confirmation_required
    expect(confirm({ kind: 'never' })).toBe(false)
    expect(confirm({ kind: 'always' })).toBe(true)
    expect(confirm({ kind: 'above', amount: dollars(800) })).toBe(true)
  })

  it('carries what AP2 has no field for in the avow extension', () => {
    const { avow } = toAp2IntentMandate(mandate, 'x')
    expect(avow).toEqual({
      mandate_id: mandate.mandateId,
      business_id: 'biz_buyer',
      agent_id: 'agt_1',
      agent_key: mandate.agentKey,
      categories: ['compute'],
      currency: 'USD',
      cap_per_commitment: '1000000000',
      cap_open_reserves: '2000000000',
      payment_limits: [{ token: TOKEN.token, amount: '5000000000', period_seconds: '86400' }],
      approval_rule: { above: '800000000' },
    })
  })
})
