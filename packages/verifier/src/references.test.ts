import {
  type AnyTerms,
  type CommitmentReference,
  lockTerms,
  type ObservedTransfer,
  type PaymentReference,
  type RailToken,
  termsHash,
  testnetDemoTermsV1,
} from '@avow-finance/spec'
import {
  type Address,
  createClient,
  custom,
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  type Hex,
} from 'viem'
import { Abis } from 'viem/tempo'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ChainReader, MemoryChain } from './chain.js'
import {
  verifyCommitmentReference,
  verifyCommitmentTerms,
  verifyPaymentReference,
} from './references.js'
import { readTransfer } from './tempo.js'
import {
  ARBITER,
  approval,
  CHAIN_ID,
  COMMITMENT,
  id,
  LOCK,
  lockedBacking,
  lockInfo,
  PAYEE,
  reservedChain,
  SALT,
  START,
  TERMS_HASH,
  TOKEN,
  terms,
} from './test-helpers.js'

const PAYER: Address = '0x00000000000000000000000000000000000000a1'
const OTHER: Address = '0x00000000000000000000000000000000000000a2'
/** Starts like a TIP-20 token's address, but a token's next ten bytes are zero. */
const LOOKALIKE: Address = '0x20c03012000000000000000000000000000d7d75'
const TX = id('payment transaction')
const MEMO = id('the commitment this pays toward')

const payment: PaymentReference = {
  kind: 'payment',
  chainId: CHAIN_ID,
  transactionHash: TX,
  logIndex: 7,
  token: TOKEN.token,
  from: PAYER,
  to: PAYEE,
  amount: 24_000_000n,
  memo: MEMO,
}

const seen: ObservedTransfer = {
  chainId: CHAIN_ID,
  transactionHash: TX,
  logIndex: 7,
  succeeded: true,
  finalized: true,
  emitter: TOKEN.token,
  event: { from: PAYER, to: PAYEE, amount: 24_000_000n, memo: MEMO },
}

let chain: MemoryChain
beforeEach(() => {
  chain = reservedChain()
  chain.setTransfer(seen)
})

/** The payment check with the one token these tests accept. */
const verifyPayment = (ref: PaymentReference, on: ChainReader = chain) =>
  verifyPaymentReference(ref, on, [TOKEN])

describe('verifyPaymentReference', () => {
  it('passes a payment the chain shows exactly, in a finalized, successful transaction', async () => {
    expect(await verifyPayment(payment)).toEqual({ ok: true })
  })

  it('refuses a token it does not accept before reading the chain, whatever that contract emitted', async () => {
    // Any contract can emit an event shaped like a token's, for any amount it likes.
    const lookalike = { ...payment, token: OTHER, amount: 10n ** 30n }
    const event = seen.event
    if (!event) throw new Error('the fixture has an event')
    chain.setTransfer({ ...seen, emitter: OTHER, event: { ...event, amount: 10n ** 30n } })
    let reads = 0
    const counted = {
      chainId: CHAIN_ID,
      transfer: (hash: Hex, logIndex: number) => {
        reads += 1
        return chain.transfer(hash, logIndex)
      },
    } as ChainReader
    expect(await verifyPayment(lookalike, counted)).toEqual({
      ok: false,
      reason: 'payment.token_not_accepted',
    })
    expect(reads).toBe(0)
    const elsewhere: RailToken = { ...TOKEN, chainId: 1 }
    expect(await verifyPaymentReference(payment, chain, [elsewhere])).toEqual({
      ok: false,
      reason: 'payment.token_not_accepted',
    })
  })

  it('refuses a payment on another chain, at another index or that the chain never saw', async () => {
    const anotherChain: RailToken = { ...TOKEN, chainId: 1 }
    expect(
      await verifyPaymentReference({ ...payment, chainId: 1 }, chain, [TOKEN, anotherChain]),
    ).toEqual({ ok: false, reason: 'payment.not_found' })
    expect(await verifyPayment({ ...payment, logIndex: 8 })).toEqual({
      ok: false,
      reason: 'payment.not_found',
    })
  })

  it('refuses whatever differs from what the chain shows', async () => {
    const event = seen.event
    if (!event) throw new Error('the fixture has an event')
    const cases: [ObservedTransfer, string][] = [
      [{ ...seen, succeeded: false }, 'payment.failed'],
      [{ ...seen, finalized: false }, 'payment.not_final'],
      [{ ...seen, event: null }, 'payment.not_memo_transfer'],
      [{ ...seen, emitter: OTHER }, 'payment.token_mismatch'],
      [{ ...seen, event: { ...event, from: OTHER } }, 'payment.sender_mismatch'],
      [{ ...seen, event: { ...event, to: OTHER } }, 'payment.recipient_mismatch'],
      [{ ...seen, event: { ...event, amount: 1n } }, 'payment.amount_mismatch'],
      [{ ...seen, event: { ...event, memo: id('another commitment') } }, 'payment.memo_mismatch'],
    ]
    for (const [observed, reason] of cases) {
      chain.setTransfer(observed)
      expect(await verifyPayment(payment)).toEqual({ ok: false, reason })
    }
  })
})

describe('verifyCommitmentReference and verifyCommitmentTerms', () => {
  const reference: CommitmentReference = {
    kind: 'commitment',
    chainId: CHAIN_ID,
    lock: LOCK,
    commitmentId: COMMITMENT,
    side: 'buyer',
    termsHash: TERMS_HASH,
  }

  const check = (
    change: { reference?: CommitmentReference; terms?: AnyTerms; tokens?: RailToken[] } = {},
  ) =>
    verifyCommitmentTerms(
      {
        reference: change.reference ?? reference,
        terms: change.terms ?? terms,
        salt: SALT,
        acceptedTokens: change.tokens ?? [TOKEN],
      },
      chain,
    )

  it('find the commitment under its terms hash, and the lock enforcing what the terms say', async () => {
    expect(await verifyCommitmentReference(reference, chain)).toEqual({ ok: true })
    expect(await check()).toEqual({ ok: true })
  })

  it("read the amounts in the lock's own token, which has to be one accepted for the terms' currency", async () => {
    const OTHER_TOKEN: Address = '0x20c0000000000000000000000000000000000002'
    // A lock holding another token, which the caller doesn't accept.
    chain.setLock(LOCK, lockInfo({ token: OTHER_TOKEN }))
    chain.setBacking(LOCK, COMMITMENT, 'buyer', lockedBacking({ token: OTHER_TOKEN }))
    expect(await check()).toEqual({ ok: false, reason: 'authorization.token_not_accepted' })
    // The same token accepted for another currency.
    const otherCurrency = { ...TOKEN, token: OTHER_TOKEN, currency: 'EUR' as 'USD' }
    expect(await check({ tokens: [TOKEN, otherCurrency] })).toEqual({
      ok: false,
      reason: 'authorization.token_not_accepted',
    })
    // Accepted with 18 decimals, it passes only when the lock holds amounts in 18 decimals.
    const eighteen = { ...TOKEN, token: OTHER_TOKEN, decimals: 18 }
    expect(await check({ tokens: [eighteen] })).toEqual({
      ok: false,
      reason: 'chain.reserve_mismatch',
    })
    const in18 = lockTerms(terms, 18)
    chain.setBacking(
      LOCK,
      COMMITMENT,
      'buyer',
      lockedBacking({ token: OTHER_TOKEN, amount: in18.amount, charges: in18.charges }),
    )
    expect(await check({ tokens: [eighteen] })).toEqual({ ok: true })
  })

  it("refuse a reference to the side the terms' backing doesn't secure", async () => {
    // The lock holds a supplier-side record under the same terms hash, and the terms back the buyer.
    chain.setBacking(LOCK, COMMITMENT, 'supplier', lockedBacking())
    expect(await check({ reference: { ...reference, side: 'supplier' } })).toEqual({
      ok: false,
      reason: 'reference.commitment_mismatch',
    })
  })

  it('refuse terms that are incomplete or carry a field the hash leaves out, without throwing', async () => {
    const { dispute: _, ...noDispute } = testnetDemoTermsV1(START, ARBITER)
    expect(await check({ terms: noDispute as AnyTerms })).toEqual({
      ok: false,
      reason: 'terms.incomplete',
    })
    const { resolution: __, ...noResolution } = terms
    expect(await check({ terms: noResolution as AnyTerms })).toEqual({
      ok: false,
      reason: 'terms.incomplete',
    })
    expect(await check({ terms: { ...terms, gracePeriod: 60n } as AnyTerms })).toEqual({
      ok: false,
      reason: 'terms.invalid',
    })
  })

  it('refuse a lock the factory never made, another terms hash, or no commitment', async () => {
    chain.setLock(LOCK, lockInfo({ fromFactory: false }))
    expect(await verifyCommitmentReference(reference, chain)).toEqual({
      ok: false,
      reason: 'chain.lock_unknown',
    })
    chain.setLock(LOCK, lockInfo())
    expect(
      await verifyCommitmentReference({ ...reference, termsHash: id('other') }, chain),
    ).toEqual({ ok: false, reason: 'reference.commitment_mismatch' })
    expect(await verifyCommitmentReference({ ...reference, side: 'supplier' }, chain)).toEqual({
      ok: false,
      reason: 'reference.commitment_mismatch',
    })
  })

  it('refuse a salt the hash refuses, as terms that give another hash, without throwing', async () => {
    for (const salt of [`0x${'00'.repeat(32)}`, '0x1234'] as const) {
      expect(
        await verifyCommitmentTerms({ reference, terms, salt, acceptedTokens: [TOKEN] }, chain),
      ).toEqual({ ok: false, reason: 'terms.hash_mismatch' })
    }
  })

  it('refuse terms that hash to something else, or a lock enforcing other values', async () => {
    expect(
      await verifyCommitmentTerms(
        { reference, terms, salt: `0x${'66'.repeat(32)}`, acceptedTokens: [TOKEN] },
        chain,
      ),
    ).toEqual({ ok: false, reason: 'terms.hash_mismatch' })
    chain.setBacking(LOCK, COMMITMENT, 'buyer', lockedBacking({ contestWindow: 1n }))
    expect(await check()).toEqual({ ok: false, reason: 'chain.reserve_mismatch' })
  })

  it('check a commitment made under version 1 terms by its version 1 hash', async () => {
    const v1 = testnetDemoTermsV1(START, ARBITER)
    const v1Hash = termsHash(v1, SALT)
    chain.setBacking(LOCK, COMMITMENT, 'buyer', lockedBacking({}, approval({ termsHash: v1Hash })))
    const v1Reference = { ...reference, termsHash: v1Hash }
    expect(await check({ reference: v1Reference, terms: v1 })).toEqual({ ok: true })
    expect(await check({ reference: v1Reference })).toEqual({
      ok: false,
      reason: 'terms.hash_mismatch',
    })
  })
})

/**
 * A node with one receipt in block 100, the finalized block a test names, and the chain's block at
 * each height. Every method it's asked for is recorded in `calls`.
 */
function node(
  opts: { status?: '0x0' | '0x1'; finalized?: bigint; canonical?: Hex; behind?: boolean } = {},
  calls: string[] = [],
) {
  const block = 100n
  const receiptBlock = id('block 100')
  const log = (index: number, topics: Hex[], data: Hex, address: Address = TOKEN.token) => ({
    address,
    blockHash: receiptBlock,
    blockNumber: `0x${block.toString(16)}`,
    logIndex: `0x${index.toString(16)}`,
    transactionHash: TX,
    transactionIndex: '0x0',
    removed: false,
    topics,
    data,
  })
  const amount = encodeAbiParameters([{ type: 'uint256' }], [24_000_000n])
  const withMemo = encodeEventTopics({
    abi: Abis.tip20,
    eventName: 'TransferWithMemo',
    args: { from: PAYER, to: PAYEE, memo: MEMO },
  }) as Hex[]
  const logs = [
    log(
      6,
      encodeEventTopics({
        abi: Abis.tip20,
        eventName: 'Transfer',
        args: { from: PAYER, to: PAYEE },
      }) as Hex[],
      amount,
    ),
    log(7, withMemo, amount),
    // The same event from a contract that isn't a TIP-20 token.
    log(8, withMemo, amount, OTHER),
    // And from an address with a TIP-20 token's first two bytes, ground out to look like one.
    log(10, withMemo, amount, LOOKALIKE),
  ]
  const blockAt = (n: bigint, hash: Hex) => ({
    number: `0x${n.toString(16)}`,
    hash,
    parentHash: id(`block ${n - 1n}`),
    timestamp: '0x1',
    transactions: [],
  })
  return createClient({
    transport: custom({
      async request({ method, params }) {
        calls.push(`${method} ${String(params?.[0])}`)
        if (method === 'eth_getTransactionReceipt') {
          if (params[0] !== TX) return null
          return {
            transactionHash: TX,
            blockHash: receiptBlock,
            blockNumber: `0x${block.toString(16)}`,
            transactionIndex: '0x0',
            from: PAYER,
            to: TOKEN.token,
            cumulativeGasUsed: '0x1',
            gasUsed: '0x1',
            effectiveGasPrice: '0x1',
            contractAddress: null,
            logs,
            logsBloom: `0x${'00'.repeat(256)}`,
            status: opts.status ?? '0x1',
            type: '0x2',
          }
        }
        if (method === 'eth_getBlockByNumber' && params[0] === 'finalized') {
          const n = opts.finalized ?? block
          return blockAt(n, id(`block ${n}`))
        }
        if (method === 'eth_getBlockByNumber' && params[0] === `0x${block.toString(16)}`) {
          // A node a block behind hasn't seen the block yet.
          return opts.behind ? null : blockAt(block, opts.canonical ?? receiptBlock)
        }
        throw new Error(`unexpected ${method}`)
      },
    }),
  })
}

describe('readTransfer', () => {
  it("decodes the token's TransferWithMemo event at the index, in a finalized block", async () => {
    expect(await readTransfer(node(), CHAIN_ID, TX, 7)).toEqual({
      chainId: CHAIN_ID,
      transactionHash: TX,
      logIndex: 7,
      succeeded: true,
      finalized: true,
      emitter: TOKEN.token,
      // The node decodes addresses in checksum case, and every check compares them in any case.
      event: { from: getAddress(PAYER), to: getAddress(PAYEE), amount: 24_000_000n, memo: MEMO },
    })
  })

  it('reads a plain Transfer with no memo, or the event from a contract that is no TIP-20 token, as no payment', async () => {
    expect((await readTransfer(node(), CHAIN_ID, TX, 6))?.event).toBeNull()
    for (const [index, emitter] of [
      [8, OTHER],
      [10, LOOKALIKE],
    ] as const) {
      const lookalike = await readTransfer(node(), CHAIN_ID, TX, index)
      expect(lookalike?.emitter).toBe(emitter)
      expect(lookalike?.event).toBeNull()
    }
  })

  it('reports a failed transaction and a block past the finalized one', async () => {
    expect((await readTransfer(node({ status: '0x0' }), CHAIN_ID, TX, 7))?.succeeded).toBe(false)
    expect((await readTransfer(node({ finalized: 99n }), CHAIN_ID, TX, 7))?.finalized).toBe(false)
  })

  it('reads a receipt from a block the chain no longer holds at that height as not final', async () => {
    const orphaned = node({ finalized: 105n, canonical: id('the block that won at 100') })
    expect((await readTransfer(orphaned, CHAIN_ID, TX, 7))?.finalized).toBe(false)
  })

  it('reads a receipt as not final, without throwing, when the node has no block at its height', async () => {
    const behind = node({ finalized: 101n, behind: true })
    expect((await readTransfer(behind, CHAIN_ID, TX, 7))?.finalized).toBe(false)
  })

  it('reads the finalized block before the receipt, then the block at the receipt height', async () => {
    const calls: string[] = []
    await readTransfer(node({ finalized: 105n }, calls), CHAIN_ID, TX, 7)
    expect(calls).toEqual([
      'eth_getBlockByNumber finalized',
      `eth_getTransactionReceipt ${TX}`,
      'eth_getBlockByNumber 0x64',
    ])
  })

  it('finds nothing at an index the receipt has no log for, or for a transaction it never saw', async () => {
    expect(await readTransfer(node(), CHAIN_ID, TX, 9)).toBeNull()
    expect(await readTransfer(node(), CHAIN_ID, id('unknown transaction'), 7)).toBeNull()
  })
})
