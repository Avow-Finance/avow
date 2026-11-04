import { checkMandate, dollars, TEMPO_MODERATO, TESTNET_DEMO_PROFILE } from '@avow-finance/spec'
import { describe, expect, it } from 'vitest'
import { moderatoUsdToken } from '../moderato.js'
import { sandboxMandate } from './mandate.js'
import { sandboxTerms } from './terms.js'

const NOW = 1_800_000_000n
const TOKEN = '0x20c00000000000000000000058fbf8a39a171185'
const AGENT = '0x00000000000000000000000000000000000000a9'
const mandate = sandboxMandate({
  businessId: 'sandbox-business',
  agentId: 'agt_test',
  account: '0x00000000000000000000000000000000000000a1',
  agentKey: AGENT,
  suppliers: ['avow-demo-gpu'],
  token: TOKEN,
  capPerCommitment: dollars(500),
  capOpenReserves: dollars(500),
  expiry: NOW + 7n * 86_400n,
})

/** The mandate check Avow runs, for a reserve of `reserve` with `open` already held. */
const check = (reserve: number, open: number, supplier = 'avow-demo-gpu') =>
  checkMandate({
    mandate,
    request: {
      commitmentId: `0x${'11'.repeat(32)}`,
      agentKey: AGENT,
      supplier,
      payee: '0x00000000000000000000000000000000000000c1',
      category: 'compute',
      terms: sandboxTerms({
        deployment: {
          arbiter: '0x00000000000000000000000000000000000000a4',
          day90SupplierShareBps: 5000,
        },
        resource: { gpu: 'H100', count: 8, hours: 1 },
        reserve: dollars(reserve),
        now: NOW,
      }),
    },
    token: moderatoUsdToken(TOKEN),
    openReserves: dollars(open),
    revoked: false,
    now: NOW,
    profile: TESTNET_DEMO_PROFILE,
  })

describe('sandboxMandate', () => {
  it('lets the agent hold its authority in bookings at once, with its suppliers only', () => {
    expect(mandate).toMatchObject({
      capPerCommitment: dollars(500),
      capOpenReserves: dollars(500),
      suppliers: ['avow-demo-gpu'],
      categories: ['compute'],
      actions: ['reserve', 'cancel', 'start'],
      // The key moves $1,000 a day when the business names no daily limit.
      paymentLimits: [{ token: TOKEN, amount: dollars(1000), period: 86_400n }],
      approvalRule: { kind: 'never' },
    })
    expect(moderatoUsdToken(TOKEN).chainId).toBe(TEMPO_MODERATO)
  })

  it("passes the starter's loop as Avow checks it against what the lock holds", () => {
    expect(check(200, 0).result).toBe('approved')
    expect(check(400, 200).reason).toBe('mandate.over_open_reserves_cap')
    expect(check(250, 200).result).toBe('approved')
    // Above the whole authority, the cap per commitment refuses it, and above the key's $1,000 a
    // day, the daily limit is the first rule the booking breaks.
    expect(check(600, 0).reason).toBe('mandate.over_commitment_cap')
    expect(check(1200, 0).reason).toBe('mandate.over_payment_limit')
    expect(check(200, 0, 'another-supplier').reason).toBe('mandate.supplier_not_allowed')
  })
})
