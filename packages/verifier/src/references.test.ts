import {
  type CommitmentReference,
  type ObservedTransfer,
  type PaymentReference,
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
import type { MemoryChain } from './chain.js'
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

describe('verifyPaymentReference', () => {
  it('passes a payment the chain shows exactly, in a finalized, successful transaction', async () => {
    expect(await verifyPaymentReference(payment, chain)).toEqual({ ok: true })
  })

  it('refuses a payment on another chain, at another index or that the chain never saw', async () => {
    expect(await verifyPaymentReference({ ...payment, chainId: 1 }, chain)).toEqual({
      ok: false,
      reason: 'payment.not_found',
    })
    expect(await verifyPaymentReference({ ...payment, logIndex: 8 }, chain)).toEqual({
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
      expect(await verifyPaymentReference(payment, chain)).toEqual({ ok: false, reason })
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

  it('find the commitment under its terms hash, and the lock enforcing what the terms say', async () => {
    expect(await verifyCommitmentReference(reference, chain)).toEqual({ ok: true })
    expect(
      await verifyCommitmentTerms({ reference, terms, salt: SALT, decimals: 6 }, chain),
    ).toEqual({ ok: true })
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

  it('refuse terms that hash to something else, or a lock enforcing other values', async () => {
    expect(
      await verifyCommitmentTerms(
        { reference, terms, salt: `0x${'66'.repeat(32)}`, decimals: 6 },
        chain,
      ),
    ).toEqual({ ok: false, reason: 'terms.hash_mismatch' })
    chain.setBacking(LOCK, COMMITMENT, 'buyer', lockedBacking({ contestWindow: 1n }))
    expect(
      await verifyCommitmentTerms({ reference, terms, salt: SALT, decimals: 6 }, chain),
    ).toEqual({ ok: false, reason: 'chain.reserve_mismatch' })
  })

  it('check a commitment made under version 1 terms by its version 1 hash', async () => {
    const v1 = testnetDemoTermsV1(START, ARBITER)
    const v1Hash = termsHash(v1, SALT)
    chain.setBacking(LOCK, COMMITMENT, 'buyer', lockedBacking({}, approval({ termsHash: v1Hash })))
    const v1Reference = { ...reference, termsHash: v1Hash }
    expect(
      await verifyCommitmentTerms(
        { reference: v1Reference, terms: v1, salt: SALT, decimals: 6 },
        chain,
      ),
    ).toEqual({ ok: true })
    expect(
      await verifyCommitmentTerms(
        { reference: v1Reference, terms, salt: SALT, decimals: 6 },
        chain,
      ),
    ).toEqual({ ok: false, reason: 'terms.hash_mismatch' })
  })
})

/** A node with one receipt whose logs a test sets, and a finalized block it names. */
function node(opts: { status?: '0x0' | '0x1'; blockNumber?: bigint; finalized?: bigint } = {}) {
  const block = opts.blockNumber ?? 100n
  const log = (index: number, topics: Hex[], data: Hex, address: Address = TOKEN.token) => ({
    address,
    blockHash: id('block'),
    blockNumber: `0x${block.toString(16)}`,
    logIndex: `0x${index.toString(16)}`,
    transactionHash: TX,
    transactionIndex: '0x0',
    removed: false,
    topics,
    data,
  })
  const amount = encodeAbiParameters([{ type: 'uint256' }], [24_000_000n])
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
    log(
      7,
      encodeEventTopics({
        abi: Abis.tip20,
        eventName: 'TransferWithMemo',
        args: { from: PAYER, to: PAYEE, memo: MEMO },
      }) as Hex[],
      amount,
    ),
  ]
  return createClient({
    transport: custom({
      async request({ method, params }) {
        if (method === 'eth_getTransactionReceipt') {
          if (params[0] !== TX) return null
          return {
            transactionHash: TX,
            blockHash: id('block'),
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
          return {
            number: `0x${n.toString(16)}`,
            hash: id(`block ${n}`),
            parentHash: id(`block ${n - 1n}`),
            timestamp: '0x1',
            transactions: [],
          }
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

  it('reads a plain Transfer with no memo as no payment event', async () => {
    expect((await readTransfer(node(), CHAIN_ID, TX, 6))?.event).toBeNull()
  })

  it('reports a failed transaction and a block past the finalized one', async () => {
    expect((await readTransfer(node({ status: '0x0' }), CHAIN_ID, TX, 7))?.succeeded).toBe(false)
    expect((await readTransfer(node({ finalized: 99n }), CHAIN_ID, TX, 7))?.finalized).toBe(false)
  })

  it('finds nothing at an index the receipt has no log for, or for a transaction it never saw', async () => {
    expect(await readTransfer(node(), CHAIN_ID, TX, 9)).toBeNull()
    expect(await readTransfer(node(), CHAIN_ID, id('unknown transaction'), 7)).toBeNull()
  })
})
