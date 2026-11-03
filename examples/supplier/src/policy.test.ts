import { TESTNET_DEMO_PROFILE } from '@avow-finance/spec'
import { describe, expect, it } from 'vitest'
import { acceptancePolicy, dollars } from './policy.js'
import { CHAIN_ID } from './test/fixtures.js'

const rules = {
  chainId: CHAIN_ID,
  businessId: 'biz_supplier',
  maxReserve: 250_000_000n,
  profile: TESTNET_DEMO_PROFILE,
  minTimeToAccept: 60n,
}

describe('the acceptance policy', () => {
  it('publishes the limits the supplier enforces, in sentences and as numbers', () => {
    const policy = acceptancePolicy(rules, { perBuyer: 4, total: 40 })
    expect(policy.limits).toEqual({
      chainId: CHAIN_ID,
      template: 'gpu-reservation/1',
      profile: TESTNET_DEMO_PROFILE.name,
      maxReserve: '250000000',
      minTimeToAccept: '60',
      openPerBuyer: 4,
      openInAll: 40,
    })
    const text = policy.rules.join(' ')
    expect(text).toContain('a reserve of at most $250.')
    expect(text).toContain('at least 60 seconds')
    expect(text).toContain('at most 4 open bookings')
    expect(policy.summary).toContain('only when an Avow commitment backs it')
  })

  it('writes amounts as dollars and cents', () => {
    expect(dollars(1_000_000_000n)).toBe('$1,000')
    expect(dollars(12_500_000n)).toBe('$12.50')
    expect(dollars(5_000n)).toBe('$0')
  })
})
