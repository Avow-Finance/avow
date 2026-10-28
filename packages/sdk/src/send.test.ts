import { Signature } from 'ox'
import { TxEnvelopeTempo } from 'ox/tempo'
import { type Address, createClient, custom, type Hex, keccak256, maxUint256 } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { tempoModerato } from 'viem/chains'
import { Account, Relay } from 'viem/tempo'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A fake chain behind viem's actions, so the sender's own logic runs without a node. It moves on
 * its own: every call to the node makes a block, two seconds after the last unless a test sets the
 * times. A transaction lands in a block while it's valid, with the status its outcome says, or
 * never lands. Tests can hide blocks and receipts, make the finalized block trail the head, and
 * rewrite a block that isn't final yet.
 */
const node = vi.hoisted(() => {
  interface Block {
    number: bigint
    timestamp: bigint
    transactions: string[]
  }
  interface Pending {
    hash: string
    status: 'success' | 'reverted'
    validBefore: bigint
    /** How many more blocks it waits in the mempool. */
    hold: number
    /** Whether its first block leaves it out, and a rewrite of that block adds it later. */
    reorgIn: boolean
  }
  const fresh = () => ({
    prepareRefusals: 0,
    prepared: 0,
    signings: 0,
    lastValidBefore: 0n,
    sent: [] as string[],
    sendErrors: 0,
    takesDespiteError: false,
    lookupErrors: 0,
    answer: null as string | null,
    known: new Set<string>(),
    pending: [] as Pending[],
    receipts: new Map<string, { status: string; transactionHash: string; blockNumber: bigint }>(),
    /** The receipt each newly sent transaction gets, in order, or null for one that never lands. */
    outcomes: [] as ('success' | 'reverted' | null)[],
    /** Settings for the next transaction sent. */
    hold: 0,
    reorgIn: false,
    /** How many calls after its block is made a rewrite adds the transaction to it. */
    reorgDelay: 2,
    receiptErrors: 0,
    blockErrors: 0,
    blockNumberErrors: 0,
    /** Reads of a block the node fails, by number, counting down. */
    hidden: new Map<bigint, number>(),
    /** How many reads the block a transaction lands in stays hidden for. */
    hideLanding: 0,
    finalizedLag: 0n,
    /** Whether a block at exactly a transaction's expiry can still include it. */
    inclusive: false,
    times: [] as bigint[],
    rewrites: [] as { at: number; number: bigint; hash: string }[],
    calls: 0,
    blocks: [] as Block[],
    validBefore: new Map<string, bigint>(),
    lock: null as unknown,
  })
  const state = fresh()
  const head = () => state.blocks[state.blocks.length - 1] as Block
  function mine() {
    const last = head()
    const timestamp = state.times.shift() ?? last.timestamp + 2n
    const fits = (p: Pending) =>
      state.inclusive ? p.validBefore >= timestamp : p.validBefore > timestamp
    const block: Block = { number: last.number + 1n, timestamp, transactions: [] }
    const waiting: Pending[] = []
    for (const p of state.pending) {
      if (!fits(p)) continue
      if (p.hold > 0) {
        waiting.push({ ...p, hold: p.hold - 1 })
        continue
      }
      if (p.reorgIn) {
        state.rewrites.push({
          at: state.calls + state.reorgDelay,
          number: block.number,
          hash: p.hash,
        })
        continue
      }
      block.transactions.push(p.hash)
      state.receipts.set(p.hash, {
        status: p.status,
        transactionHash: p.hash,
        blockNumber: block.number,
      })
      if (state.hideLanding > 0) state.hidden.set(block.number, state.hideLanding)
    }
    state.pending = waiting
    state.blocks.push(block)
    return block
  }
  /** Every call to the node makes a block, and applies a rewrite that's due. */
  function tick() {
    state.calls++
    for (const r of state.rewrites.filter((w) => w.at <= state.calls)) {
      const block = state.blocks.find((b) => b.number === r.number)
      if (block && !block.transactions.includes(r.hash)) {
        block.transactions.push(r.hash)
        state.receipts.set(r.hash, {
          status: 'success',
          transactionHash: r.hash,
          blockNumber: r.number,
        })
      }
    }
    state.rewrites = state.rewrites.filter((w) => w.at > state.calls)
    mine()
  }
  return { state, fresh, head, mine, tick }
})

vi.mock('viem/actions', () => ({
  prepareTransactionRequest: async (_client: unknown, args: { calls: unknown }) => {
    node.tick()
    const s = node.state
    s.prepared++
    if (s.prepareRefusals > 0) {
      s.prepareRefusals--
      throw new Error('execution reverted: not due yet')
    }
    s.lastValidBefore = node.head().timestamp + 25n
    return {
      type: 'tempo',
      chainId: 42431,
      calls: args.calls,
      gas: 100_000n,
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 0n,
      nonceKey: 2n ** 256n - 1n,
      nonce: 0,
      validBefore: Number(s.lastValidBefore),
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
    node.tick()
    if (node.state.blockNumberErrors > 0) {
      node.state.blockNumberErrors--
      throw new Error('503 Service Unavailable')
    }
    return node.head().number
  },
  getBlock: async (
    _client: unknown,
    { blockNumber, blockTag }: { blockNumber?: bigint; blockTag?: string },
  ) => {
    node.tick()
    const s = node.state
    if (s.blockErrors > 0) {
      s.blockErrors--
      throw new Error('429 Too Many Requests')
    }
    if (blockTag === 'finalized') {
      const final = node.head().number - s.finalizedLag
      return s.blocks.find((b) => b.number === final) ?? s.blocks[0]
    }
    const n = blockNumber as bigint
    const hidden = s.hidden.get(n) ?? 0
    if (hidden > 0) {
      s.hidden.set(n, hidden - 1)
      throw new Error(`Block at number "${n}" could not be found.`)
    }
    const found = s.blocks.find((b) => b.number === n)
    if (!found) throw new Error(`Block at number "${n}" could not be found.`)
    return { ...found, transactions: [...found.transactions] }
  },
  getTransaction: async (_client: unknown, { hash }: { hash: string }) => {
    node.tick()
    if (node.state.lookupErrors > 0) {
      node.state.lookupErrors--
      throw new Error('502 Bad Gateway')
    }
    if (!node.state.known.has(hash)) throw new Error('Transaction not found')
    return { hash }
  },
  getTransactionReceipt: async (_client: unknown, { hash }: { hash: string }) => {
    node.tick()
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

const limits = { prepareTries: 3, sendTries: 3, signings: 3, wait: 1, receiptTimeout: 300 }
const ALPHA = '0x20c0000000000000000000000000000000000001'
const LOCK = '0x00000000000000000000000000000000000010c4'
const CALLS = [{ to: LOCK, data: '0x1234' }] as const

/** Puts a transaction the node took in its mempool, with the outcome the test set for it. */
function take(hash: string) {
  const s = node.state
  if (s.known.has(hash)) return
  s.known.add(hash)
  const outcome = s.outcomes.shift() ?? null
  if (!outcome) return
  s.pending.push({
    hash,
    status: outcome,
    validBefore: s.validBefore.get(hash) ?? 0n,
    hold: s.hold,
    reorgIn: s.reorgIn,
  })
}

/** A node that takes raw transactions, refusing or answering as the fake chain says. */
const client = createClient({
  chain: tempoModerato,
  transport: custom(
    {
      async request({ method, params }) {
        if (method !== 'eth_sendRawTransaction') throw new Error(`the test sent ${method}`)
        node.tick()
        const s = node.state
        const [bytes] = params as [Hex]
        const hash = keccak256(bytes)
        s.sent.push(bytes)
        if (s.sendErrors > 0) {
          s.sendErrors--
          if (s.takesDespiteError) take(hash)
          throw new Error('502 Bad Gateway')
        }
        take(hash)
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

/** Records when a co-signed transaction stops being valid, which the fake chain needs. */
function remember(bytes: Hex) {
  const tx = TxEnvelopeTempo.deserialize(bytes as TxEnvelopeTempo.Serialized)
  node.state.validBefore.set(keccak256(bytes), BigInt(tx.validBefore ?? 0))
  return bytes
}

const cosign = async (signed: Hex): Promise<Hex> =>
  remember(
    (await relay.request(
      { method: 'eth_signRawTransaction', params: [signed] },
      { chainId: tempoModerato.id },
    )) as Hex,
  )

/**
 * Co-signs as the relay does once it has recovered the sender. viem's relay reads the chain to
 * recover an access key's sender, which the fake chain can't answer, so this takes the sender.
 */
async function cosignFor(senderAddress: Address, signed: Hex): Promise<Hex> {
  const tx = TxEnvelopeTempo.deserialize(signed as TxEnvelopeTempo.Serialized)
  const envelope = TxEnvelopeTempo.from({ ...tx, feeToken: ALPHA } as never)
  const payload = TxEnvelopeTempo.getFeePayerSignPayload(envelope, { sender: senderAddress })
  const feePayerSignature = Signature.from(await relayKey.sign({ hash: payload }))
  return remember(
    TxEnvelopeTempo.serialize(envelope, { feePayerSignature, signature: tx.signature } as never),
  )
}

/** The relay's bytes with one signed field changed and both signatures kept, as a bad relay would. */
async function altered(signed: Hex, change: Record<string, unknown>): Promise<Hex> {
  const tx = TxEnvelopeTempo.deserialize((await cosign(signed)) as TxEnvelopeTempo.Serialized)
  return TxEnvelopeTempo.serialize(
    { ...tx, ...change } as never,
    {
      feePayerSignature: tx.feePayerSignature,
      signature: tx.signature,
    } as never,
  )
}

const sender = Account.fromSecp256k1(generatePrivateKey())
const send = (sponsor = cosign, l = limits) =>
  sendSponsored({ client, account: sender as never, calls: CALLS, sponsor, limits: l })

beforeEach(() => {
  Object.assign(node.state, node.fresh())
  // The relay holds a transaction's expiry to the real clock, so the chain starts at it.
  node.state.blocks = [
    { number: 100n, timestamp: BigInt(Math.floor(Date.now() / 1000)), transactions: [] },
  ]
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
    expect(e.signings).toBe(0)
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

  it('lands once when every send errs but the node took the bytes', async () => {
    node.state.sendErrors = 99
    node.state.takesDespiteError = true
    node.state.lookupErrors = 99
    node.state.outcomes = ['success']
    const receipt = await send()
    expect(receipt.status).toBe('success')
    expect(node.state.signings).toBe(1)
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

  it('throws when the transaction lands reverted', async () => {
    node.state.outcomes = ['reverted']
    const e = await failure(send())
    expect(e.outcome).toBe('failed')
    expect(e.message).toContain('reverted')
  })

  it('refuses limits under one try', async () => {
    await expect(send(cosign, { ...limits, sendTries: 0 })).rejects.toThrow(RangeError)
    expect(node.state.prepared).toBe(0)
  })
})

describe('deciding a transaction expired', () => {
  it('finds a transaction that landed while its receipts were unavailable past its expiry', async () => {
    node.state.outcomes = ['success']
    // The receipt stays out of reach until long after the transaction's expiry.
    node.state.receiptErrors = 40
    const receipt = await send()
    expect(node.state.signings).toBe(1)
    expect(receipt.status).toBe('success')
  })

  it("stops at a block it can't read, and never skips it", async () => {
    node.state.outcomes = ['success']
    node.state.receiptErrors = 40
    // The block the transaction landed in fails twenty reads before the node gives it.
    node.state.hideLanding = 20
    const receipt = await send()
    expect(node.state.signings).toBe(1)
    expect(receipt.status).toBe('success')
  })

  it('reads only finalized blocks, so a block rewritten before it was final is read as final', async () => {
    node.state.outcomes = ['success']
    // The block the transaction lands in first comes without it, and gains it eight calls later,
    // while it's still ten blocks short of final.
    node.state.reorgIn = true
    node.state.reorgDelay = 8
    node.state.finalizedLag = 10n
    node.state.receiptErrors = 60
    const receipt = await send()
    expect(node.state.signings).toBe(1)
    expect(receipt.status).toBe('success')
  })

  it('scans from before the key signed, so a transaction the relay sent itself is still found', async () => {
    node.state.outcomes = ['success']
    node.state.receiptErrors = 40
    const receipt = await send(async (t) => {
      const bytes = await cosign(t)
      // The relay breaks its promise and lands the transaction before answering.
      take(keccak256(bytes))
      node.mine()
      node.mine()
      node.mine()
      return bytes
    })
    expect(node.state.signings).toBe(1)
    expect(receipt.status).toBe('success')
  })

  it('takes a block at exactly the expiry as one that could still include the transaction', async () => {
    node.state.outcomes = ['success']
    node.state.inclusive = true
    node.state.receiptErrors = 40
    // The next two blocks come at exactly its expiry, and the transaction lands in the second.
    const receipt = await send(async (t) => {
      const bytes = await cosign(t)
      const at = node.state.lastValidBefore
      node.state.times = [at, at]
      return bytes
    })
    expect(node.state.signings).toBe(1)
    expect(receipt.status).toBe('success')
  })

  it('signs again only once a finalized block past its expiry is read and none holds it', async () => {
    node.state.outcomes = [null, 'success']
    node.state.finalizedLag = 2n
    const receipt = await send()
    expect(node.state.signings).toBe(2)
    expect(receipt.transactionHash).toBe(keccak256(node.state.sent[1] as Hex))
  })

  it('gives up after the last signing expires, with every hash it sent', async () => {
    node.state.outcomes = [null, null, null]
    const e = await failure(send())
    expect(e.outcome).toBe('failed')
    expect(e.signings).toBe(3)
    expect(e.message).toContain('expired in no block, 3 times')
    expect(e.hashes).toEqual(node.state.sent.map((b) => keccak256(b as Hex)))
  })

  it("says the outcome is unknown when the receipt doesn't come in time", async () => {
    node.state.outcomes = ['success']
    node.state.receiptErrors = 1_000_000
    const e = await failure(send())
    expect(e.outcome).toBe('unknown')
    expect(e.message).toMatch(/landed in block \d+/)
    expect(node.state.signings).toBe(1)
  })

  it("says the outcome is unknown when the scan can't read on in time", async () => {
    node.state.outcomes = [null]
    node.state.blockErrors = 1_000_000
    const e = await failure(send())
    expect(e.outcome).toBe('unknown')
    expect(node.state.signings).toBe(1)
  })

  it('gives up without signing again when the node never took the bytes', async () => {
    node.state.sendErrors = 1_000_000
    const e = await failure(send())
    expect(e.outcome).toBe('failed')
    expect(e.message).toContain('never took')
    expect(node.state.signings).toBe(1)
  })
})

describe("checking the relay's bytes", () => {
  it("sends nothing when the relay won't co-sign or returns another transaction", async () => {
    const refused = await failure(
      send(async () => {
        throw new Error('Sponsorship rejected.')
      }),
    )
    expect(refused.outcome).toBe('failed')
    expect(refused.signings).toBe(1)
    expect(refused.message).toContain('Sponsorship rejected')

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
            validBefore: Number(node.state.lastValidBefore),
            feePayer: true,
          } as never),
        ),
      ),
    )
    expect(swapped.message).toContain("change the key's signature")
    const unsigned = await failure(send(async (t) => t))
    expect(unsigned.message).toContain('no fee payer signature')
    expect(node.state.sent).toEqual([])
  })

  it('refuses bytes that change anything the key signed, and sends nothing', async () => {
    const changes: [Record<string, unknown>, string][] = [
      [{ calls: [{ to: '0x00000000000000000000000000000000000010c5', data: '0x1234' }] }, 'calls'],
      [{ calls: [{ to: LOCK, data: '0x1235' }] }, 'calls'],
      [{ calls: [{ to: LOCK, data: '0x1234', value: 1n }] }, 'calls'],
      [{ nonceKey: 7n }, 'nonceKey'],
      [{ nonce: 1n }, 'nonce'],
      [{ validBefore: 2_000_000_000 }, 'validBefore'],
      [{ gas: 100_001n }, 'gas'],
      [{ maxFeePerGas: 1_000_000_001n }, 'maxFeePerGas'],
    ]
    for (const [change, field] of changes) {
      const e = await failure(send(async (t) => altered(t, change)))
      expect(e.outcome, field).toBe('failed')
      expect(e.message, field).toContain(`change what the key signed, its ${field}`)
    }
    expect(node.state.sent).toEqual([])
  })

  it('says the outcome is unknown when the node answers with another hash', async () => {
    node.state.outcomes = ['success']
    node.state.answer = `0x${'ab'.repeat(32)}`
    const e = await failure(send())
    expect(e.outcome).toBe('unknown')
    expect(e.hashes).toContain(node.state.answer)
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
