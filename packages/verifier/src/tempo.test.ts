import {
  type Address,
  createClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  type Hex,
  keccak256,
  stringToHex,
  toHex,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { Abis, Addresses } from 'viem/tempo'
import { describe, expect, it } from 'vitest'
import { MemoryChain } from './chain.js'
import { LOCK_ABI, LOCK_PAUSED_EVENT_ABI, PAUSE_CAUSES } from './lock-abi.js'
import { readAgentKey, readContest } from './tempo.js'

// A node stand-in that answers getKey and returns one receipt with the logs a test gives it.
const id = (label: string): Hex => keccak256(stringToHex(label))
const newAddress = () => privateKeyToAccount(generatePrivateKey()).address
const TX = id('the transaction')
const MAX_U64 = 2n ** 64n - 1n

type KeychainLog = { event: 'KeyAuthorized'; key: Address } | { event: 'Witness'; witness: Hex }

function node(account: Address, entries: KeychainLog[], revoked = false) {
  const logs = entries.map((e, i) => {
    const base = {
      address: Addresses.accountKeychain,
      blockHash: id('block'),
      blockNumber: '0x1',
      logIndex: `0x${i.toString(16)}`,
      transactionHash: TX,
      transactionIndex: '0x0',
      removed: false,
    }
    return e.event === 'KeyAuthorized'
      ? {
          ...base,
          topics: encodeEventTopics({
            abi: Abis.accountKeychain,
            eventName: 'KeyAuthorized',
            args: { account, publicKey: e.key },
          }),
          data: encodeAbiParameters([{ type: 'uint8' }, { type: 'uint64' }], [0, MAX_U64]),
        }
      : {
          ...base,
          topics: encodeEventTopics({
            abi: Abis.accountKeychain,
            eventName: 'KeyAuthorizationWitness',
            args: { account, witness: e.witness },
          }),
          data: '0x',
        }
  })
  return createClient({
    transport: custom({
      async request({ method, params }) {
        if (method === 'eth_call') {
          const { args } = decodeFunctionData({ abi: Abis.accountKeychain, data: params[0].data })
          return encodeFunctionResult({
            abi: Abis.accountKeychain,
            functionName: 'getKey',
            result: {
              signatureType: 0,
              keyId: args?.[1] as Address,
              expiry: MAX_U64,
              enforceLimits: true,
              isRevoked: revoked,
            },
          })
        }
        if (method === 'eth_getTransactionReceipt') {
          return {
            transactionHash: TX,
            blockHash: id('block'),
            blockNumber: '0x1',
            transactionIndex: '0x0',
            from: account,
            to: null,
            cumulativeGasUsed: '0x1',
            gasUsed: '0x1',
            effectiveGasPrice: '0x1',
            contractAddress: null,
            logs,
            logsBloom: `0x${'00'.repeat(256)}`,
            status: '0x1',
            type: '0x2',
          }
        }
        throw new Error(`unexpected ${method}`)
      },
    }),
  })
}

describe('readAgentKey', () => {
  const account = newAddress()
  const key = newAddress()
  const mandate = id('mandate')

  it('reads the mandate hash from the transaction that authorized the key', async () => {
    const client = node(account, [
      { event: 'KeyAuthorized', key },
      { event: 'Witness', witness: mandate },
    ])
    expect(await readAgentKey(client, account, key, TX)).toEqual({
      active: true,
      expiry: null,
      witness: mandate,
    })
  })

  it('reads a revoked key as inactive', async () => {
    const client = node(
      account,
      [
        { event: 'KeyAuthorized', key },
        { event: 'Witness', witness: mandate },
      ],
      true,
    )
    expect((await readAgentKey(client, account, key, TX))?.active).toBe(false)
  })

  it("won't credit a mandate to a key when the transaction authorized two keys", async () => {
    const other = newAddress()
    const client = node(account, [
      { event: 'KeyAuthorized', key: other },
      { event: 'Witness', witness: mandate },
      { event: 'KeyAuthorized', key },
    ])
    expect((await readAgentKey(client, account, key, TX))?.witness).toBeNull()
    expect((await readAgentKey(client, account, other, TX))?.witness).toBeNull()
  })

  it('finds no mandate when the transaction authorized another key or carries no witness', async () => {
    const elsewhere = node(account, [
      { event: 'KeyAuthorized', key: newAddress() },
      { event: 'Witness', witness: mandate },
    ])
    expect((await readAgentKey(elsewhere, account, key, TX))?.witness).toBeNull()
    const unwitnessed = node(account, [{ event: 'KeyAuthorized', key }])
    expect((await readAgentKey(unwitnessed, account, key, TX))?.witness).toBeNull()
  })
})

describe('readContest', () => {
  const lock = newAddress()
  const token = '0x20c0000000000000000000000000000000000001'
  const commitmentId = id('contested commitment')
  const statementHash = id('the statement')
  const BLOCK = id('block')
  const pausedLog = {
    address: lock,
    blockHash: BLOCK,
    blockNumber: '0x7',
    logIndex: '0x0',
    transactionHash: TX,
    transactionIndex: '0x0',
    removed: false,
    topics: encodeEventTopics({
      abi: LOCK_PAUSED_EVENT_ABI,
      eventName: 'Paused',
      args: { commitmentId },
    }),
    data: encodeAbiParameters(
      LOCK_PAUSED_EVENT_ABI[0].inputs.filter((i) => !i.indexed),
      [0, id('terms'), PAUSE_CAUSES.contest, 1_800_000_000n, 3, statementHash, 0n],
    ),
  }
  type Component = { name: string; type: string }
  const components = (
    LOCK_ABI.find((f) => f.name === 'commitment') as {
      outputs: readonly [{ components: readonly Component[] }]
    }
  ).outputs[0].components
  const zeroOf = (type: string): unknown =>
    type.endsWith('[4]')
      ? [0n, 0n, 0n, 0n]
      : type === 'bool'
        ? false
        : type === 'address'
          ? '0x0000000000000000000000000000000000000000'
          : type === 'bytes32'
            ? `0x${'00'.repeat(32)}`
            : type.startsWith('uint128') || type.startsWith('uint64') || type === 'uint256'
              ? 0n
              : 0
  /** The lock's record of a no-show paused by the business's contest of its second report. */
  const record = {
    ...Object.fromEntries(components.map((c) => [c.name, zeroOf(c.type)])),
    state: 4,
    hasReport: true,
    contested: true,
    reportKind: 1,
    reportCount: 2,
    reportAmount: 500_000_000n,
  }
  const node = (
    o: {
      receipt?: 'none' | 'down' | { status: '0x0' | '0x1' }
      /** The finalized block's number. */
      final?: bigint
      /** The hash of the chain's block at the receipt's height. */
      atHeight?: Hex
    } = {},
  ) => {
    const reads: unknown[] = []
    const client = createClient({
      transport: custom(
        {
          async request({ method, params }) {
            const receipt = o.receipt ?? { status: '0x1' }
            if (receipt === 'down') throw new Error('503 Service Unavailable')
            if (method === 'eth_getBlockByNumber') {
              const [tag] = params as [string]
              const number = tag === 'finalized' ? toHex(o.final ?? 9n) : tag
              const hash = tag === 'finalized' ? id('final') : (o.atHeight ?? BLOCK)
              return { number, hash, parentHash: id('parent'), timestamp: '0x1', transactions: [] }
            }
            if (method === 'eth_getTransactionReceipt') {
              if (receipt === 'none') return null
              return {
                transactionHash: TX,
                blockHash: BLOCK,
                blockNumber: '0x7',
                transactionIndex: '0x0',
                from: newAddress(),
                to: lock,
                cumulativeGasUsed: '0x1',
                gasUsed: '0x1',
                effectiveGasPrice: '0x1',
                contractAddress: null,
                logs: [pausedLog],
                logsBloom: `0x${'00'.repeat(256)}`,
                status: receipt.status,
                type: '0x2',
              }
            }
            if (method === 'eth_call') {
              const [call, block] = params as [{ data: Hex }, unknown]
              reads.push(block)
              const { functionName } = decodeFunctionData({ abi: LOCK_ABI, data: call.data })
              if (functionName === 'token') {
                return encodeFunctionResult({ abi: LOCK_ABI, functionName, result: token })
              }
              return encodeFunctionResult({
                abi: LOCK_ABI,
                functionName: 'commitment',
                result: record as never,
              })
            }
            throw new Error(`unexpected ${method}`)
          },
        },
        { retryCount: 0 },
      ),
    })
    return { client, reads }
  }
  const contest = {
    commitmentId,
    side: 'buyer' as const,
    reasonCode: 3,
    statementHash,
    pausedAt: 1_800_000_000n,
    blockNumber: 7n,
    finalized: true,
    report: { number: 2, kind: 'noShow' as const, amount: 500_000_000n },
  }

  it('reads the contest a final transaction carried, with the report the lock held at its block', async () => {
    const { client, reads } = node()
    expect(await readContest(client, lock, commitmentId, 'buyer', TX)).toEqual(contest)
    // Both reads of the lock name the contest's block, never the latest.
    expect(reads).toEqual(['0x7', '0x7'])
  })

  it('reads a contest above the finalized block, or in a block the chain no longer holds, as not final', async () => {
    const above = await readContest(node({ final: 6n }).client, lock, commitmentId, 'buyer', TX)
    expect(above).toEqual({ ...contest, finalized: false })
    const dropped = node({ atHeight: id('the block that won the reorganization') })
    expect(await readContest(dropped.client, lock, commitmentId, 'buyer', TX)).toEqual({
      ...contest,
      finalized: false,
    })
  })

  it('reads no contest from a failed transaction, a missing one or another commitment', async () => {
    const failed = node({ receipt: { status: '0x0' } }).client
    expect(await readContest(failed, lock, commitmentId, 'buyer', TX)).toBeNull()
    expect(
      await readContest(node({ receipt: 'none' }).client, lock, commitmentId, 'buyer', TX),
    ).toBeNull()
    const other = id('another commitment')
    expect(await readContest(node().client, lock, other, 'buyer', TX)).toBeNull()
  })

  it("throws when the node can't answer, so an outage never reads as a missing contest", async () => {
    const down = node({ receipt: 'down' }).client
    await expect(readContest(down, lock, commitmentId, 'buyer', TX)).rejects.toThrow()
  })

  it('reads from MemoryChain only for the lock, commitment, side and transaction it was given', async () => {
    const memory = new MemoryChain(1)
    memory.setContest(lock, TX, contest)
    const upper = `0x${commitmentId.slice(2).toUpperCase()}` as Hex
    expect(await memory.contest(lock.toLowerCase() as Address, upper, 'buyer', TX)).toEqual(contest)
    expect(await memory.contest(lock, commitmentId, 'supplier', TX)).toBeNull()
    expect(await memory.contest(lock, id('another commitment'), 'buyer', TX)).toBeNull()
    expect(await memory.contest(newAddress(), commitmentId, 'buyer', TX)).toBeNull()
    expect(await memory.contest(lock, commitmentId, 'buyer', id('another transaction'))).toBeNull()
  })
})
