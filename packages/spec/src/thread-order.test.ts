import type { Address, Hex } from 'viem'
import { describe, expect, it } from 'vitest'
import type { AvowDomain } from './eip712.js'
import {
  type NegotiationThread,
  proposalTerms,
  type SignedMove,
  threadProblem,
  threadStateAt,
} from './negotiation.js'
import { offerVersionId, SERVICE_CATEGORY, type ServiceOfferVersion } from './service.js'
import { termsHash } from './terms.js'
import {
  acceptanceOf,
  agreedQuote,
  declineOf,
  openingProposal,
  parseThreadOrder,
  parseThreadOrderRequest,
  type ThreadOrder,
  threadOrderProblem,
} from './thread-order.js'
import { toWire } from './wire.js'

const id = (byte: string) => `0x${byte.repeat(32)}` as Hex
const HOUR = 3600n
const NOW = 1_800_000_000n
const DOMAIN: AvowDomain = {
  chainId: 42431,
  verifyingContract: '0x00000000000000000000000000000000000000b2',
}
const settlement = {
  arbiter: '0x7b7b7e93b9de1b9cba5123f0570b56eb66c53173' as Address,
  day90SupplierShareBps: 5_000,
}
const buyer = { businessId: 'sandbox-buyer', mandateHash: id('cd') }
const base: ServiceOfferVersion = {
  supplier: 'sandbox-seller',
  item: { name: 'Transcript', summary: 'One hour of audio transcribed into English text' },
  currency: 'USD',
  unitPrice: 50_000_000n,
  rules: {
    evidence: 'The transcript is delivered to the buyer as a text file',
    leadTime: 24n * HOUR,
    maxPerBooking: 10,
    dailyCapacity: 20,
    freeCancelWindow: 2n * HOUR,
    lateCancellationBps: 2_000,
    noShowBps: 5_000,
    payment: { route: 'transfer', dueAfterDelivery: 7n * 24n * HOUR },
  },
}

const signed = (move: SignedMove['move'], quote: SignedMove['quote'] = null): SignedMove => ({
  move,
  signature: '0x01',
  quote,
  current: null,
})

function opened(): NegotiationThread {
  const proposal = openingProposal({
    thread: id('aa'),
    commitmentId: id('56'),
    base,
    quantity: 2,
    builtAt: NOW,
    expiry: NOW + 120n,
  })
  return { base, buyer, settlement, moves: [signed(proposal)] }
}

function agreed(): NegotiationThread {
  const thread = opened()
  const head = thread.moves[0]?.move
  if (!head) throw new Error('no proposal')
  const salt = id('01')
  const hash = termsHash(proposalTerms(base, head, settlement), salt)
  const quote = {
    salt,
    agreement: {
      commitmentId: head.commitmentId,
      termsHash: hash,
      category: SERVICE_CATEGORY,
      buyerBusinessId: buyer.businessId,
      supplierBusinessId: base.supplier,
      mandateHash: buyer.mandateHash,
      nonce: 1n,
      expiry: NOW + 120n,
    },
    supplierSignature: '0xab' as Hex,
  }
  const accept = acceptanceOf(thread, DOMAIN, {
    side: 'supplier',
    termsHash: hash,
    expiry: NOW + 120n,
  })
  return { ...thread, moves: [...thread.moves, signed(accept, quote)] }
}

describe('a fixed-price order carried as a thread', () => {
  it('opens with a proposal at the offer’s own price and lead time, which replays', () => {
    const thread = opened()
    expect(threadProblem(thread, DOMAIN)).toBeNull()
    expect(threadStateAt(thread, NOW)).toMatchObject({ status: 'open', turn: 'supplier' })
  })

  it('is agreed once the supplier accepts, and its quote builds the terms the hash names', () => {
    const thread = agreed()
    expect(threadProblem(thread, DOMAIN)).toBeNull()
    const quote = agreedQuote(thread, NOW)
    expect(quote).not.toBeNull()
    expect(termsHash(quote?.terms as never, quote?.salt as Hex)).toBe(quote?.agreement.termsHash)
    expect(agreedQuote(opened(), NOW)).toBeNull()
    // Once the agreement lapses there's nothing to fund.
    expect(agreedQuote(thread, NOW + 120n)).toBeNull()
  })

  it('lets the buyer withdraw it, open or agreed', () => {
    for (const thread of [opened(), agreed()]) {
      const withdrawn = declineOf(thread, DOMAIN, { side: 'buyer', reason: 'order.withdrawn' })
      const closed = { ...thread, moves: [...thread.moves, signed(withdrawn)] }
      expect(threadProblem(closed, DOMAIN)).toBeNull()
      expect(threadStateAt(closed, NOW)).toEqual({
        status: 'closed',
        why: 'declined',
        reason: 'order.withdrawn',
        by: 'buyer',
      })
    }
  })

  it('lets the supplier decline with what its reason allows', () => {
    const thread = opened()
    const full = declineOf(thread, DOMAIN, {
      side: 'supplier',
      reason: 'capacity.exhausted',
      retryAt: NOW + HOUR,
      available: 1,
    })
    expect(threadProblem({ ...thread, moves: [...thread.moves, signed(full)] }, DOMAIN)).toBeNull()
    const refused = declineOf(thread, DOMAIN, {
      side: 'supplier',
      reason: 'supplier.not_authorized',
    })
    expect(
      threadProblem({ ...thread, moves: [...thread.moves, signed(refused)] }, DOMAIN),
    ).toBeNull()
  })
})

describe('a request to open a thread', () => {
  const request = () => ({
    orderId: 'ab'.repeat(16),
    base,
    proposal: opened().moves[0] as SignedMove,
  })

  it('carries a buyer’s first proposal about the base it travels with', () => {
    expect(threadOrderProblem(request())).toBeNull()
    const other = { ...base, unitPrice: 1n }
    expect(threadOrderProblem({ ...request(), base: other })).toBe('message.invalid')
    const accept = agreed().moves[1] as SignedMove
    expect(threadOrderProblem({ ...request(), proposal: accept })).toBe('message.invalid')
  })

  it('reads from JSON as it was written, and refuses a field it doesn’t know', () => {
    const wire = JSON.parse(JSON.stringify(toWire(request()))) as Record<string, unknown>
    expect(parseThreadOrderRequest(wire)).toEqual(request())
    expect(parseThreadOrderRequest({ ...wire, note: 'hello' })).toBeNull()
    expect(offerVersionId(parseThreadOrderRequest(wire)?.base as ServiceOfferVersion)).toBe(
      offerVersionId(base),
    )
  })
})

describe('a thread order as the mailbox answers it', () => {
  it('reads back each stage', () => {
    const order: ThreadOrder = {
      orderId: 'ab'.repeat(16),
      thread: agreed(),
      buyer: {
        ...buyer,
        account: '0x00000000000000000000000000000000000000a1',
        lock: DOMAIN.verifyingContract,
        chainId: DOMAIN.chainId,
      },
      requestedAt: NOW,
      status: 'reserved',
      reserve: { fundedIn: null, amount: 25_000_000n, acceptBy: NOW + 900n },
    }
    const wire = JSON.parse(JSON.stringify(toWire(order)))
    expect(parseThreadOrder(wire)).toEqual(order)
    expect(parseThreadOrder({ ...wire, status: 'agreed' })).toBeNull()
  })
})
