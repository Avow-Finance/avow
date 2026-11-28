import type { Address, Hex } from 'viem'
import { describe, expect, it } from 'vitest'
import { dollars } from './demo.js'
import type { NegotiationMove } from './eip712.js'
import type { NegotiationThread, SignedMove } from './negotiation.js'
import { TESTNET_DEMO_PROFILE } from './profiles.js'
import type { SellerMandate } from './seller-mandate.js'
import { type ServiceOfferVersion, serviceOfferProblem } from './service.js'
import { ARBITER, demoMandate, demoSellerMandate, NOW, PAYEE, TOKEN } from './test-helpers.js'
import { buyerMoveCheck, sellerMoveCheck } from './thread-authority.js'

const HOUR = 3600n
const DAY = 24n * HOUR
const ACCOUNT: Address = '0x00000000000000000000000000000000000a11ce'
const AGENT: Address = '0x0000000000000000000000000000000000000a91'
const KEY: Address = '0x0000000000000000000000000000000000005e11'
const settlement = { arbiter: ARBITER, day90SupplierShareBps: 5000 }

/** Fine-tuning runs at $50 a unit, open to bargaining on price and quantity. */
const base: ServiceOfferVersion = {
  supplier: 'biz_supplier',
  item: { name: 'Fine-tuning run', summary: 'One fine-tuning run on the dataset the buyer sends' },
  currency: 'USD',
  unitPrice: dollars(50),
  rules: {
    evidence: 'The tuned weights are delivered to the buyer',
    leadTime: 2n * DAY,
    maxPerBooking: 4,
    dailyCapacity: 5,
    freeCancelWindow: 2n * HOUR,
    lateCancellationBps: 2_000,
    noShowBps: 5_000,
    payment: { route: 'transfer', dueAfterDelivery: 7n * DAY },
  },
  negotiation: { open: ['unitPrice', 'quantity'], leadTime: null },
}

const opening: NegotiationMove = {
  thread: `0x${'aa'.repeat(32)}`,
  commitmentId: `0x${'56'.repeat(32)}`,
  seq: 0,
  previous: `0x${'00'.repeat(32)}`,
  side: 'buyer',
  kind: 'propose',
  baseOffer: `0x${'00'.repeat(32)}`,
  quantity: 2,
  unitPrice: dollars(42),
  leadTime: base.rules.leadTime,
  builtAt: NOW,
  termsHash: `0x${'00'.repeat(32)}`,
  reason: '',
  retryAt: 0n,
  available: 0,
  currentOffer: `0x${'00'.repeat(32)}`,
  expiry: NOW + 120n,
}
const signed = (move: NegotiationMove): SignedMove => ({
  move,
  signature: '0x01' as Hex,
  quote: null,
  current: null,
})
const thread: NegotiationThread = {
  base,
  buyer: { businessId: 'biz_buyer', mandateHash: `0x${'cd'.repeat(32)}` },
  settlement,
  moves: [signed(opening)],
}
const proposal = (change: Partial<NegotiationMove> = {}) => ({ ...opening, ...change })

describe('the buyer’s mandate at each move', () => {
  const mandate = {
    ...demoMandate(ACCOUNT, AGENT),
    categories: ['service'],
    capPerCommitment: dollars(1000),
  }
  const check = (change: Partial<NegotiationMove> = {}, m = mandate) =>
    buyerMoveCheck({
      thread,
      proposal: proposal(change),
      mandate: m,
      agentKey: AGENT,
      payee: PAYEE,
      token: TOKEN,
      openReserves: 0n,
      revoked: false,
      now: NOW,
      profile: TESTNET_DEMO_PROFILE,
    })

  it('passes a proposal whose terms the mandate allows', () => {
    expect(check()).toEqual({ result: 'approved', reason: 'approved' })
  })

  it('reads the terms the proposal builds, so a limit holds at the move as at the reserve', () => {
    // Two units at $42 reserve $42 for a no-show, which a cap of $40 a commitment refuses.
    expect(check({}, { ...mandate, capPerCommitment: dollars(40) }).result).toBe('denied')
    expect(check({}, { ...mandate, suppliers: ['biz_other'] })).toEqual({
      result: 'denied',
      reason: 'mandate.supplier_not_allowed',
    })
  })

  it('refuses terms the template can’t build, and never throws', () => {
    expect(check({ quantity: 9 })).toEqual({ result: 'denied', reason: 'terms.template_invalid' })
    expect(check({}, null as never)).toEqual({ result: 'denied', reason: 'message.invalid' })
  })
})

describe('the seller’s mandate at each move', () => {
  const mandate = demoSellerMandate(ACCOUNT, KEY)
  const check = (change: Partial<NegotiationMove> = {}, m: SellerMandate = mandate) =>
    sellerMoveCheck({
      thread,
      proposal: proposal(change),
      mandate: m,
      signingKey: KEY,
      revoked: false,
      now: NOW,
      buyer: { businessId: 'biz_buyer', country: 'JP', passedBusinessCheck: true },
      ledger: { unitsToday: 0, outstanding: 0n },
      approvedSale: null,
      profile: TESTNET_DEMO_PROFILE,
    })

  it('passes the offer’s own price for what the buyer asked', () => {
    expect(check({ unitPrice: base.unitPrice })).toEqual({ result: 'approved', reason: 'approved' })
  })

  it('holds a bargained price to the floor, as the seller’s own reason', () => {
    // The demo mandate's floor for any service is $40 a unit.
    expect(check({ unitPrice: dollars(39) })).toEqual({
      result: 'denied',
      reason: 'seller_mandate.under_price_floor',
    })
  })

  it('refuses a term the mandate doesn’t let the agent move, after every limit', () => {
    expect(check({ unitPrice: dollars(45) })).toEqual({
      result: 'denied',
      reason: 'seller_mandate.term_not_negotiable',
    })
    // The quantity moves from what the buyer's opening proposal asked.
    expect(check({ unitPrice: base.unitPrice, quantity: 3 })).toEqual({
      result: 'denied',
      reason: 'seller_mandate.term_not_negotiable',
    })
  })

  it('checks the sale against the version the agreement makes, which opens nothing', () => {
    expect(serviceOfferProblem(base)).toBeNull()
    // Four units fit the offer, and moving to them is still a move. Five fit no version of it.
    expect(check({ unitPrice: base.unitPrice, quantity: 4 }).reason).toBe(
      'seller_mandate.term_not_negotiable',
    )
    expect(check({ unitPrice: base.unitPrice, quantity: 5 })).toEqual({
      result: 'denied',
      reason: 'terms.template_invalid',
    })
  })
})
