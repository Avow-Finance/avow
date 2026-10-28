import { type Hex, keccak256 } from 'viem'
import { tempoModerato } from 'viem/chains'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/** A fake node behind viem's actions, so the sender's own logic runs without a chain. */
const node = vi.hoisted(() => ({
  prepareRefusals: 0,
  prepared: 0,
  signed: [] as string[],
  sendErrors: 0,
  landsDespiteError: false,
  known: new Set<string>(),
  receipts: new Map<string, { status: 'success' | 'reverted'; transactionHash: string }>(),
  /** The receipt each signing gets, in order, or null for one that never lands. */
  outcomes: [] as ('success' | 'reverted' | null)[],
  chainTime: 0n,
}))

vi.mock('viem/actions', () => ({
  prepareTransactionRequest: async () => {
    node.prepared++
    if (node.prepareRefusals > 0) {
      node.prepareRefusals--
      throw new Error('execution reverted: not due yet')
    }
    return { validBefore: 100, feePayer: true }
  },
  signTransaction: async () => {
    const bytes = `0x76${(node.signed.length + 1).toString(16).padStart(4, '0')}`
    node.signed.push(bytes)
    return bytes
  },
  getTransaction: async (_client: unknown, { hash }: { hash: string }) =>
    node.known.has(hash) ? {} : null,
  getTransactionReceipt: async (_client: unknown, { hash }: { hash: string }) => {
    const r = node.receipts.get(hash)
    if (!r) throw new Error('not found')
    return r
  },
  getBlock: async () => ({ timestamp: node.chainTime }),
}))

const { sendSponsored } = await import('./send.js')

const limits = { prepareTries: 3, signings: 3, wait: 1, receiptTimeout: 50 }
const cosigned = (signed: Hex) => `${signed}ff` as Hex

function client() {
  return {
    chain: tempoModerato,
    request: async ({ params }: { params: [Hex] }) => {
      const bytes = params[0]
      const hash = keccak256(bytes)
      const outcome = node.outcomes.shift() ?? null
      if (outcome) node.receipts.set(hash, { status: outcome, transactionHash: hash })
      if (node.sendErrors > 0) {
        node.sendErrors--
        if (node.landsDespiteError) node.known.add(hash)
        throw new Error('502 Bad Gateway')
      }
      node.known.add(hash)
      return hash
    },
  } as never
}

const send = (sponsor = async (t: Hex) => cosigned(t)) =>
  sendSponsored({
    client: client(),
    account: { address: '0x0000000000000000000000000000000000000001' } as never,
    calls: [{ to: '0x0000000000000000000000000000000000000002', data: '0x' }],
    sponsor,
    limits,
  })

beforeEach(() => {
  Object.assign(node, {
    prepareRefusals: 0,
    prepared: 0,
    signed: [],
    sendErrors: 0,
    landsDespiteError: false,
    known: new Set(),
    receipts: new Map(),
    outcomes: [],
    chainTime: 0n,
  })
})

describe('sending a transaction whose fee Avow pays', () => {
  it("sends the relay's co-signed bytes and tracks their hash to the receipt", async () => {
    node.outcomes = ['success']
    const sponsored: Hex[] = []
    const receipt = await send(async (t) => {
      sponsored.push(t)
      return cosigned(t)
    })
    expect(sponsored).toEqual(node.signed)
    expect(receipt.transactionHash).toBe(keccak256(cosigned(node.signed[0] as Hex)))
  })

  it('prepares again while the node refuses, and gives up once the refusal holds', async () => {
    node.prepareRefusals = 2
    node.outcomes = ['success']
    await send()
    expect(node.prepared).toBe(3)
    node.prepareRefusals = 5
    await expect(send()).rejects.toThrow('not due yet')
  })

  it('counts a send that errors as sent once the node knows its hash, and sends nothing twice', async () => {
    node.sendErrors = 1
    node.landsDespiteError = true
    node.outcomes = ['success']
    await send()
    expect(node.signed).toHaveLength(1)
  })

  it('signs again when a transaction expires before it lands, a few times at most', async () => {
    node.chainTime = 101n
    node.outcomes = [null, 'success']
    const receipt = await send()
    expect(node.signed).toHaveLength(2)
    expect(receipt.transactionHash).toBe(keccak256(cosigned(node.signed[1] as Hex)))
    node.receipts.clear()
    node.outcomes = [null, null, null]
    await expect(send()).rejects.toThrow('expired before it landed, 3 times')
  })

  it('throws when the transaction lands reverted', async () => {
    node.outcomes = ['reverted']
    await expect(send()).rejects.toThrow('reverted')
  })

  it("throws when the relay won't co-sign, before anything reaches the node", async () => {
    await expect(
      send(async () => {
        throw new Error('Sponsorship rejected.')
      }),
    ).rejects.toThrow('Sponsorship rejected')
    expect(node.known.size).toBe(0)
  })
})
