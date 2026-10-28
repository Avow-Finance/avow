import { Signature } from 'ox'
import { TxEnvelopeTempo } from 'ox/tempo'
import { type Address, createClient, custom, type Hex, keccak256, maxUint256 } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { tempoModerato } from 'viem/chains'
import { Account, Relay, Transaction } from 'viem/tempo'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A fake chain behind viem's actions, so the sender's own logic runs without a node. Its blocks
 * come ten seconds apart, and the next one is made when someone reads it. A transaction lands in
 * the next block while it's valid, with the status its outcome says, or never lands.
 */
const node = vi.hoisted(() => {
  const state = {
    prepareRefusals: 0,
    prepared: 0,
    signings: 0,
    sent: [] as string[],
    sendErrors: 0,
    takesDespiteError: false,
    answer: null as string | null,
    known: new Set<string>(),
    pending: [] as { hash: string; status: 'success' | 'reverted'; validBefore: number }[],
    receipts: new Map<string, { status: string; transactionHash: string; blockNumber: bigint }>(),
    /** The receipt each newly sent transaction gets, in order, or null for one that never lands. */
    outcomes: [] as ('success' | 'reverted' | null)[],
    receiptErrors: 0,
    blockErrors: 0,
    blockNumberErrors: 0,
    blocks: [{ number: 100n, timestamp: 0n, transactions: [] as string[] }],
    validBefore: new Map<string, number>(),
    lock: null as unknown,
  }
  const head = () => state.blocks[state.blocks.length - 1] as (typeof state.blocks)[number]
  function mine() {
    const last = head()
    const timestamp = last.timestamp + 10n
    const included = state.pending.filter((p) => BigInt(p.validBefore) >= timestamp)
    state.pending = []
    const block = { number: last.number + 1n, timestamp, transactions: included.map((p) => p.hash) }
    state.blocks.push(block)
    for (const p of included) {
      state.receipts.set(p.hash, {
        status: p.status,
        transactionHash: p.hash,
        blockNumber: block.number,
      })
    }
    return block
  }
  return { state, head, mine }
})

vi.mock('viem/actions', () => ({
  prepareTransactionRequest: async (_client: unknown, args: { calls: unknown }) => {
    const s = node.state
    s.prepared++
    if (s.prepareRefusals > 0) {
      s.prepareRefusals--
      throw new Error('execution reverted: not due yet')
    }
    return {
      type: 'tempo',
      chainId: 42431,
      calls: args.calls,
      gas: 100_000n,
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 0n,
      nonceKey: 2n ** 256n - 1n,
      nonce: 0,
      validBefore: Number(node.head().timestamp) + 25,
      feePayer: true,
    }
  },
  signTransaction: async (
    _client: unknown,
    { account, ...request }: { account: { signTransaction: (r: unknown) => Promise<string> } },
  ) => {
    node.state.signings++
    return account.signTransaction(request)
  },
  getBlockNumber: async () => {
    if (node.state.blockNumberErrors > 0) {
      node.state.blockNumberErrors--
      throw new Error('503 Service Unavailable')
    }
    return node.head().number
  },
  getBlock: async (_client: unknown, { blockNumber }: { blockNumber: bigint }) => {
    const s = node.state
    if (s.blockErrors > 0) {
      s.blockErrors--
      throw new Error('429 Too Many Requests')
    }
    const found = s.blocks.find((b) => b.number === blockNumber)
    if (found) return found
    if (blockNumber === node.head().number + 1n) return node.mine()
    throw new Error(`Block at number "${blockNumber}" could not be found.`)
  },
  getTransaction: async (_client: unknown, { hash }: { hash: string }) => {
    if (!node.state.known.has(hash)) throw new Error('Transaction not found')
    return { hash }
  },
  getTransactionReceipt: async (_client: unknown, { hash }: { hash: string }) => {
    const s = node.state
    if (s.receiptErrors > 0) {
      s.receiptErrors--
      throw new Error('502 Bad Gateway')
    }
    const r = s.receipts.get(hash)
    if (!r) throw new Error(`Transaction receipt with hash "${hash}" could not be found.`)
    return r
  },
  readContract: async (_client: unknown, { functionName }: { functionName: string }) => {
    if (functionName === 'token') return '0x20c0000000000000000000000000000000000001'
    if (functionName === 'commitment') return node.state.lock
    throw new Error(`a read of ${functionName}`)
  },
}))

const { SendError, sendSponsored } = await import('./send.js')

const limits = { prepareTries: 3, sendTries: 3, signings: 3, wait: 1, receiptTimeout: 200 }
const ALPHA = '0x20c0000000000000000000000000000000000001'
const CALLS = [{ to: '0x00000000000000000000000000000000000010c4', data: '0x1234' }] as const

/** A node that takes raw transactions, refusing or answering as the fake chain says. */
const client = createClient({
  chain: tempoModerato,
  transport: custom(
    {
      async request({ method, params }) {
        if (method !== 'eth_sendRawTransaction') throw new Error(`the test sent ${method}`)
        const s = node.state
        const [bytes] = params as [Hex]
        const hash = keccak256(bytes)
        s.sent.push(bytes)
        const take = () => {
          if (s.known.has(hash)) return
          s.known.add(hash)
          const outcome = s.outcomes.shift() ?? null
          const validBefore = s.validBefore.get(hash) ?? 0
          if (outcome) s.pending.push({ hash, status: outcome, validBefore })
        }
        if (s.sendErrors > 0) {
          s.sendErrors--
          if (s.takesDespiteError) take()
          throw new Error('502 Bad Gateway')
        }
        take()
        return s.answer ?? hash
      },
    },
    { retryCount: 0 },
  ),
})

/** Avow's relay, as viem's fee payer builds it. It co-signs and never sends. */
const relayKey = privateKeyToAccount(generatePrivateKey())
const relay = Relay.create({
  client: createClient({
    chain: tempoModerato,
    transport: custom({
      async request({ method }) {
        throw new Error(`the relay sent ${method}`)
      },
    }),
  }),
  plugins: [Relay.feePayer({ account: relayKey, feeToken: ALPHA })],
})
const cosign = async (signed: Hex): Promise<Hex> => {
  const bytes = (await relay.request(
    { method: 'eth_signRawTransaction', params: [signed] },
    { chainId: tempoModerato.id },
  )) as Hex
  // The fake chain needs to know when each transaction stops being valid.
  const tx = Transaction.deserialize(bytes as `0x76${string}`) as { validBefore?: number }
  node.state.validBefore.set(keccak256(bytes), Number(tx.validBefore))
  return bytes
}

/**
 * Co-signs as the relay does once it has recovered the sender. viem's relay reads the chain to
 * recover an access key's sender, which the fake chain can't answer, so this takes the sender.
 */
async function cosignFor(senderAddress: Address, signed: Hex): Promise<Hex> {
  const tx = Transaction.deserialize(signed as `0x76${string}`) as Record<string, unknown>
  const envelope = TxEnvelopeTempo.from({ ...tx, from: senderAddress, feeToken: ALPHA } as never)
  const payload = TxEnvelopeTempo.getFeePayerSignPayload(envelope, { sender: senderAddress })
  const feePayerSignature = Signature.from(await relayKey.sign({ hash: payload }))
  const bytes = TxEnvelopeTempo.serialize(envelope, {
    feePayerSignature,
    signature: tx.signature,
  } as never) as Hex
  node.state.validBefore.set(keccak256(bytes), Number(tx.validBefore))
  return bytes
}

const sender = Account.fromSecp256k1(generatePrivateKey())
const send = (sponsor = cosign, l = limits) =>
  sendSponsored({ client, account: sender as never, calls: CALLS, sponsor, limits: l })

beforeEach(() => {
  Object.assign(node.state, {
    prepareRefusals: 0,
    prepared: 0,
    signings: 0,
    sent: [],
    sendErrors: 0,
    takesDespiteError: false,
    answer: null,
    known: new Set(),
    pending: [],
    receipts: new Map(),
    outcomes: [],
    receiptErrors: 0,
    blockErrors: 0,
    blockNumberErrors: 0,
    // The relay holds a transaction's expiry to the real clock, so the chain starts at it.
    blocks: [{ number: 100n, timestamp: BigInt(Math.floor(Date.now() / 1000)), transactions: [] }],
    validBefore: new Map(),
    lock: null,
  })
})

const failure = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error('the send succeeded')
    },
    (e: unknown) => {
      if (!(e instanceof SendError)) throw e
      return e
    },
  )

describe('sending a transaction whose fee Avow pays', () => {
  it("sends the relay's co-signed bytes and tracks their hash to the receipt", async () => {
    node.state.outcomes = ['success']
    const signed: Hex[] = []
    const receipt = await send(async (t) => {
      signed.push(t)
      return cosign(t)
    })
    expect(signed).toHaveLength(1)
    expect(node.state.sent).toHaveLength(1)
    expect(receipt.transactionHash).toBe(keccak256(node.state.sent[0] as Hex))
  })

  it('prepares again while the node refuses, and gives up once the refusal holds', async () => {
    node.state.prepareRefusals = 2
    node.state.outcomes = ['success']
    await send()
    expect(node.state.prepared).toBe(3)
    node.state.prepareRefusals = 5
    const e = await failure(send())
    expect(e.outcome).toBe('failed')
    expect(e.message).toContain('not due yet')
  })

  it('sends the same bytes again while the node errs, and only until it has them', async () => {
    node.state.sendErrors = 1
    node.state.takesDespiteError = true
    node.state.outcomes = ['success']
    await send()
    expect(node.state.signings).toBe(1)
    expect(node.state.sent).toHaveLength(1)

    node.state.sendErrors = 2
    node.state.takesDespiteError = false
    node.state.outcomes = ['success']
    await send()
    const [, again, third] = node.state.sent
    expect(again).toBe(third)
  })

  it('keeps reading while the node errs on receipts and blocks, and never signs again for it', async () => {
    node.state.outcomes = ['success']
    node.state.receiptErrors = 6
    node.state.blockErrors = 3
    node.state.blockNumberErrors = 2
    const receipt = await send()
    expect(node.state.signings).toBe(1)
    expect(receipt.status).toBe('success')
  })

  it("doesn't take a lagging node's missing receipt for a transaction that never landed", async () => {
    // The transaction lands in the next block, but the receipt doesn't come before its expiry.
    node.state.outcomes = ['success']
    node.state.receiptErrors = 8
    const receipt = await send(cosign, { ...limits, receiptTimeout: 2_000 })
    expect(node.state.signings).toBe(1)
    expect(receipt.blockNumber).toBe(101n)
  })

  it('signs again once every block past its expiry is read and none holds it', async () => {
    node.state.outcomes = [null, 'success']
    const receipt = await send()
    expect(node.state.signings).toBe(2)
    expect(receipt.transactionHash).toBe(keccak256(node.state.sent[1] as Hex))
  })

  it('gives up after the last signing expires, with every hash it sent', async () => {
    node.state.outcomes = [null, null, null]
    const e = await failure(send())
    expect(e.outcome).toBe('failed')
    expect(e.message).toContain('expired in no block, 3 times')
    expect(e.hashes).toEqual(node.state.sent.map((b) => keccak256(b as Hex)))
  })

  it("says the outcome is unknown when the receipt doesn't come in time", async () => {
    node.state.outcomes = ['success']
    node.state.receiptErrors = 10_000
    const e = await failure(send())
    expect(e.outcome).toBe('unknown')
    expect(e.message).toContain('landed in block 101')
  })

  it('gives up without signing again when the node never took the bytes', async () => {
    node.state.sendErrors = 10_000
    const e = await failure(send())
    expect(e.outcome).toBe('failed')
    expect(e.message).toContain('never took')
    expect(node.state.signings).toBe(1)
  })

  it('throws when the transaction lands reverted', async () => {
    node.state.outcomes = ['reverted']
    const e = await failure(send())
    expect(e.outcome).toBe('failed')
    expect(e.message).toContain('reverted')
  })

  it("sends nothing when the relay won't co-sign or returns another transaction", async () => {
    const refused = await failure(
      send(async () => {
        throw new Error('Sponsorship rejected.')
      }),
    )
    expect(refused.outcome).toBe('failed')
    expect(refused.message).toContain('Sponsorship rejected')

    // The relay's bytes have to be the transaction the key signed, with the relay's signature.
    const other = Account.fromSecp256k1(generatePrivateKey())
    const swapped = await failure(
      send(async () =>
        cosign(
          await other.signTransaction({
            type: 'tempo',
            chainId: 42431,
            calls: CALLS,
            gas: 100_000n,
            maxFeePerGas: 1_000_000_000n,
            maxPriorityFeePerGas: 0n,
            nonceKey: maxUint256,
            nonce: 0,
            validBefore: Math.floor(Date.now() / 1000) + 25,
            feePayer: true,
          } as never),
        ),
      ),
    )
    expect(swapped.message).toContain("aren't the transaction the key signed")
    const unsigned = await failure(send(async (t) => t))
    expect(unsigned.message).toContain('no fee payer signature')
    expect(node.state.sent).toEqual([])
  })

  it('says the outcome is unknown when the node answers with another hash', async () => {
    node.state.outcomes = ['success']
    node.state.answer = `0x${'ab'.repeat(32)}`
    const e = await failure(send())
    expect(e.outcome).toBe('unknown')
    expect(e.hashes).toContain(node.state.answer)
  })

  it('refuses limits under one try', async () => {
    await expect(send(cosign, { ...limits, sendTries: 0 })).rejects.toThrow(RangeError)
    expect(node.state.prepared).toBe(0)
  })
})

describe('an agent sending through the relay by default', () => {
  it('signs, has Avow co-sign, sends and checks the lock holds its reserve', async () => {
    const { createAgent } = await import('./agent.js')
    const { bookingFixture, gpuBooking, lockRecord } = await import('./test/fixture.js')
    const { TESTNET_DEMO_PROFILE } = await import('@avow-finance/spec')
    const f = await bookingFixture()
    const sponsored: Hex[] = []
    node.state.outcomes = ['success']
    const agent = createAgent({
      client,
      key: f.key,
      mandate: f.signedMandate,
      token: {
        rail: 'tempo',
        chainId: 42431,
        token: ALPHA,
        currency: 'USD',
        decimals: 6,
      },
      profile: TESTNET_DEMO_PROFILE,
      avow: {
        ...f.avow,
        async sponsor(t) {
          sponsored.push(t)
          const bytes = await cosignFor(f.key.address, t)
          // Once it lands, the lock holds the reserve under the approval it carried.
          node.state.lock = lockRecord(f.approvals.at(-1)?.message ?? null)
          return bytes
        },
      },
      now: () => BigInt(1_800_000_000),
      limits,
    })
    const result = await agent.book({
      supplier: f.connection,
      booking: gpuBooking(),
      category: 'compute',
    })
    if (!result.ok) throw new Error(result.reason)
    expect(sponsored).toHaveLength(1)
    expect(result.commitment.reservedIn).toBe(keccak256(node.state.sent[0] as Hex))
  })
})
