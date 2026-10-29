import { type AgreementOffer, TESTNET_DEMO_PROFILE } from '@avow-finance/spec'
import { describe, expect, it } from 'vitest'
import { agreementProblem, type OfferRules } from './offer.js'
import { agreement, CHAIN_ID, DOMAIN, NOW, SALT, terms } from './test/fixtures.js'

const rules: OfferRules = {
  chainId: CHAIN_ID,
  businessId: 'biz_supplier',
  maxReserve: 1_000_000_000n,
  profile: TESTNET_DEMO_PROFILE,
  minTimeToAccept: 60n,
}
const offer: AgreementOffer = { agreement, terms, salt: SALT, domain: DOMAIN }

describe('what the supplier signs', () => {
  it('signs GPU reservation terms that meet its rules', () => {
    expect(agreementProblem(offer, rules, NOW)).toBeNull()
  })

  it('refuses every offer that breaks one', () => {
    const refusals: [Partial<AgreementOffer>, Partial<OfferRules>, bigint, string][] = [
      [{ domain: { ...DOMAIN, chainId: 1 } }, {}, NOW, 'chain 1'],
      [{ agreement: { ...agreement, supplierBusinessId: 'biz_other' } }, {}, NOW, 'another'],
      [{}, {}, agreement.expiry, 'expired'],
      [{ salt: `0x${'66'.repeat(32)}` }, {}, NOW, 'terms hash'],
      [{}, { maxReserve: 1n }, NOW, 'over what'],
      [{}, { minTimeToAccept: 100_000n }, NOW, 'too little time'],
      [
        { terms: { ...terms, remedies: { ...terms.remedies, chargeDeadline: 0n } } },
        {},
        NOW,
        'profile',
      ],
    ]
    for (const [change, ruleChange, now, says] of refusals) {
      expect(agreementProblem({ ...offer, ...change }, { ...rules, ...ruleChange }, now)).toContain(
        says,
      )
    }
  })
})
