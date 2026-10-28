import { type Address, encodeAbiParameters, keccak256 } from 'viem'
import { describe, expect, it } from 'vitest'
import { canonicalJson } from './canonical.js'
import {
  type Attribution,
  type CommitmentReference,
  checkAttributions,
  checkPaymentReference,
  type ObservedTransfer,
  type PaymentReference,
  paymentId,
  referenceHash,
} from './references.js'
import { CHAIN_ID, id, LOCK, PAYEE, TOKEN } from './test-helpers.js'

const PAYER: Address = '0x00000000000000000000000000000000000000a1'
const OTHER: Address = '0x00000000000000000000000000000000000000a2'

const payment: PaymentReference = {
  kind: 'payment',
  chainId: CHAIN_ID,
  transactionHash: id('payment tx'),
  logIndex: 4,
  token: TOKEN.token,
  from: PAYER,
  to: PAYEE,
  amount: 24_000_000n,
  memo: id('booking memo'),
}

const seen: ObservedTransfer = {
  chainId: CHAIN_ID,
  transactionHash: payment.transactionHash,
  logIndex: 4,
  succeeded: true,
  finalized: true,
  emitter: TOKEN.token,
  event: { from: PAYER, to: PAYEE, amount: 24_000_000n, memo: id('booking memo') },
}

const commitment = (n: number): CommitmentReference => ({
  kind: 'commitment',
  chainId: CHAIN_ID,
  lock: LOCK,
  commitmentId: id(`commitment ${n}`),
  side: 'buyer',
  termsHash: id(`terms ${n}`),
})

describe('payment ids', () => {
  it('are the chain, transaction hash and log index, in any letter case', () => {
    expect(paymentId(payment)).toBe(`${CHAIN_ID}:${payment.transactionHash}:4`)
    expect(
      paymentId({
        ...payment,
        transactionHash: payment.transactionHash.toUpperCase().replace('0X', '0x') as `0x${string}`,
      }),
    ).toBe(paymentId(payment))
    expect(paymentId({ ...payment, logIndex: 5 })).not.toBe(paymentId(payment))
  })
})

describe('referenceHash', () => {
  it('hashes the label and canonical JSON, with hex in lower case', () => {
    const c = commitment(1)
    const expected = keccak256(
      encodeAbiParameters(
        [{ type: 'string' }, { type: 'string' }],
        ['avow:reference:v1', canonicalJson({ ...c, lock: c.lock.toLowerCase() })],
      ),
    )
    expect(referenceHash(c)).toBe(expected)
    const shouting = { ...payment, to: '0x000000000000000000000000000000000000BEEF' as Address }
    expect(referenceHash(shouting)).toBe(referenceHash(payment))
  })

  it('differs for every field and between the two kinds', () => {
    const hashes = new Set([
      referenceHash(payment),
      referenceHash({ ...payment, logIndex: 5 }),
      referenceHash({ ...payment, amount: 1n }),
      referenceHash({ ...payment, memo: id('other memo') }),
      referenceHash(commitment(1)),
      referenceHash(commitment(2)),
      referenceHash({ ...commitment(1), side: 'supplier' }),
    ])
    expect(hashes.size).toBe(7)
  })
})

describe('checkPaymentReference', () => {
  const accepted = [{ chainId: CHAIN_ID, token: TOKEN.token }]
  const check = (ref: PaymentReference, observed: ObservedTransfer | null) =>
    checkPaymentReference(ref, observed, accepted)

  it("passes when the token's own TransferWithMemo event matches in a finalized, successful transaction", () => {
    expect(check(payment, seen)).toBeNull()
  })

  it('refuses a token the reader does not accept, even when that contract emitted the event', () => {
    // Any contract can emit an event shaped like a token's, with any amount it likes.
    const lookalike = { ...payment, token: OTHER, amount: 10n ** 30n }
    const event = seen.event
    if (!event) throw new Error('the fixture has an event')
    const emitted = { ...seen, emitter: OTHER, event: { ...event, amount: 10n ** 30n } }
    expect(check(lookalike, emitted)).toBe('payment.token_not_accepted')
    expect(checkPaymentReference(payment, seen, [])).toBe('payment.token_not_accepted')
    expect(checkPaymentReference(payment, seen, [{ chainId: 1, token: TOKEN.token }])).toBe(
      'payment.token_not_accepted',
    )
  })

  it('refuses a transfer it cannot find at that chain, transaction and log index', () => {
    expect(check(payment, null)).toBe('payment.not_found')
    expect(check(payment, { ...seen, logIndex: 5 })).toBe('payment.not_found')
    expect(check(payment, { ...seen, chainId: 1 })).toBe('payment.not_found')
    expect(check(payment, { ...seen, transactionHash: id('other tx') })).toBe('payment.not_found')
  })

  it('refuses a failed or unfinalized transaction', () => {
    expect(check(payment, { ...seen, succeeded: false })).toBe('payment.failed')
    expect(check(payment, { ...seen, finalized: false })).toBe('payment.not_final')
  })

  it('refuses any log but a TransferWithMemo event, so a plain transfer or calldata never counts', () => {
    expect(check(payment, { ...seen, event: null })).toBe('payment.not_memo_transfer')
  })

  it("refuses an event whose token, sender, recipient, amount or memo differs from the reference's", () => {
    const e = seen.event
    if (!e) throw new Error('the fixture has an event')
    const cases: [ObservedTransfer, string][] = [
      [{ ...seen, emitter: OTHER }, 'payment.token_mismatch'],
      [{ ...seen, event: { ...e, from: OTHER } }, 'payment.sender_mismatch'],
      [{ ...seen, event: { ...e, to: OTHER } }, 'payment.recipient_mismatch'],
      [{ ...seen, event: { ...e, amount: e.amount - 1n } }, 'payment.amount_mismatch'],
      [{ ...seen, event: { ...e, memo: id('another commitment') } }, 'payment.memo_mismatch'],
    ]
    for (const [observed, reason] of cases) expect(check(payment, observed)).toBe(reason)
  })
})

describe('checkAttributions, within the set it is given', () => {
  const evidence = (n: number): Attribution => ({
    payment,
    obligation: commitment(n),
    use: 'evidence',
  })
  const value = (n: number): Attribution => ({ payment, obligation: commitment(n), use: 'value' })

  it('lets any number of records cite the same payment as evidence', () => {
    expect(checkAttributions([evidence(1), evidence(2), evidence(1), value(3)])).toBeNull()
  })

  it("refuses a payment's value attributed twice, to the same obligation or another", () => {
    expect(checkAttributions([value(1), value(2)])).toBe('payment.attributed_twice')
    expect(checkAttributions([value(1), evidence(2), value(1)])).toBe('payment.attributed_twice')
  })

  it('treats two transfers in one transaction as two payments', () => {
    const second: Attribution = { ...value(2), payment: { ...payment, logIndex: 5 } }
    expect(checkAttributions([value(1), second])).toBeNull()
  })
})
