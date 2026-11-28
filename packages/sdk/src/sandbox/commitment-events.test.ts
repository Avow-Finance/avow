import type { CommitmentReference } from '@avow-finance/spec'
import type { LockEventSource } from '@avow-finance/verifier'
import type { Address, Hex } from 'viem'
import { describe, expect, it } from 'vitest'
import {
  type EventChain,
  readCommitmentEvents,
  UnknownCommitment,
  UntrustedLock,
} from './commitment-events.js'
import { addCommitment, memoryStore } from './store.js'

const h = (byte: string): Hex => `0x${byte.repeat(32)}`
const LOCK = '0x00000000000000000000000000000000000010c4' as Address
const reference: CommitmentReference = {
  kind: 'commitment',
  chainId: 42431,
  lock: LOCK,
  commitmentId: h('c1'),
  side: 'buyer',
  termsHash: h('7e'),
}

/** A chain of blocks a second apart from time 1,000, with no logs, that notes each query. */
function emptyChain(final: bigint) {
  const queries: { lock: Address; commitmentId: Hex; from: bigint }[] = []
  const source: LockEventSource = {
    chainId: 42431,
    finalBlock: async () => ({ number: final, at: 1_000n + final }),
    blockTime: async (n) => 1_000n + n,
    async transactions(lock, commitmentId, from) {
      queries.push({ lock, commitmentId, from })
      return []
    },
    receipt: async () => {
      throw new Error('no receipts')
    },
  }
  return { source, queries }
}

/** The chain as a trusted reader sees it, with the lock made by a trusted factory or not. */
const on =
  (source: LockEventSource, fromFactory = true) =>
  (chainId: number): EventChain | null =>
    chainId === 42431 ? { source, reader: { lock: async () => ({ fromFactory }) as never } } : null

describe('readCommitmentEvents', () => {
  it('reads the lock of a commitment made from this folder, from a little before it was made', async () => {
    const store = memoryStore()
    await addCommitment(store, {
      reference,
      amount: 500_000_000n,
      supplier: 'sandbox-supplier',
      mandateHash: h('3a'),
      madeAt: 1_900n,
    })
    const { source, queries } = emptyChain(2_000n)
    const read = await readCommitmentEvents(on(source), store, h('c1'))
    expect(read.reference).toEqual(reference)
    expect(read.events).toEqual([])
    expect(queries[0]).toEqual({ lock: LOCK, commitmentId: h('c1'), from: 600n })
  })

  it('starts where the last read said to carry on', async () => {
    const store = memoryStore()
    await addCommitment(store, {
      reference,
      amount: 1n,
      supplier: 'sandbox-supplier',
      mandateHash: h('3a'),
      madeAt: 1_900n,
    })
    const { source, queries } = emptyChain(2_000n)
    await readCommitmentEvents(on(source), store, h('C1'), 1_500n)
    expect(queries[0]?.from).toBe(1_500n)
  })

  it('reads nothing from a lock no trusted factory made, or on a chain it trusts none on', async () => {
    const store = memoryStore()
    await addCommitment(store, {
      reference,
      amount: 1n,
      supplier: 'sandbox-supplier',
      mandateHash: h('3a'),
      madeAt: 1_900n,
    })
    const { source, queries } = emptyChain(2_000n)
    await expect(readCommitmentEvents(on(source, false), store, h('c1'))).rejects.toThrow(
      UntrustedLock,
    )
    await expect(readCommitmentEvents(() => null, store, h('c1'))).rejects.toThrow(UntrustedLock)
    expect(queries).toEqual([])
  })

  it('refuses a commitment this folder never made, and reads nothing', async () => {
    const { source, queries } = emptyChain(2_000n)
    await expect(readCommitmentEvents(on(source), memoryStore(), h('c9'))).rejects.toThrow(
      UnknownCommitment,
    )
    expect(queries).toEqual([])
  })
})
