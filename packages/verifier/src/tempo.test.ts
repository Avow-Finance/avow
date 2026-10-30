import { chainedTerms, testnetDemoTerms } from '@avow-finance/spec'
import {
  type Address,
  createClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  getAddress,
  type Hex,
  isAddressEqual,
  keccak256,
  stringToHex,
  toHex,
  zeroAddress,
  zeroHash,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { Abis, Addresses } from 'viem/tempo'
import { describe, expect, it } from 'vitest'
import { verifyDependencies } from './dependency.js'
import { FACTORY_ABI, LOCK_ABI } from './lock-abi.js'
import { readAgentKey, tempoLockReader } from './tempo.js'
import {
  ARBITER,
  CHAIN_ID,
  dependencyOn,
  FACTORY,
  gpuCloud,
  START,
  SUPPLIER_LOCK,
  shownUpstream,
  supplierAccount,
  UPSTREAM_COMMITMENT,
  UPSTREAM_HASH,
} from './test-helpers.js'

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

describe('tempoLockReader', () => {
  const LOCK = SUPPLIER_LOCK
  const LOOKALIKE: Address = '0x00000000000000000000000000000000000010c7'
  const HEAD = 77n
  const reseller = supplierAccount.address
  const upstream = UPSTREAM_COMMITMENT
  const upstreamTerms = UPSTREAM_HASH

  /** The lock's `commitment` record with every field zero, but the ones given. */
  const COMPONENTS = (
    LOCK_ABI.find((f) => f.name === 'commitment') as {
      outputs: readonly [{ components: readonly { name: string; type: string }[] }]
    }
  ).outputs[0].components
  const zeroOf = (type: string): unknown => {
    if (type.endsWith('[4]')) return [0n, 0n, 0n, 0n]
    if (type === 'bool') return false
    if (type === 'address') return zeroAddress
    if (type === 'bytes32') return zeroHash
    return type === 'uint8' || type === 'uint16' ? 0 : 0n
  }
  const record = (change: Record<string, unknown>) =>
    Object.fromEntries(COMPONENTS.map((c) => [c.name, change[c.name] ?? zeroOf(c.type)]))
  const ACCEPTED = record({
    state: 2,
    termsHash: upstreamTerms,
    amount: 1n,
    held: 1n,
    supplier: gpuCloud.address,
  })

  const block = (n: bigint, hash: Hex) => ({
    number: toHex(n),
    hash,
    parentHash: zeroHash,
    timestamp: '0x1',
    transactions: [],
    uncles: [],
    gasLimit: '0x1',
    gasUsed: '0x0',
    baseFeePerGas: '0x1',
    difficulty: '0x0',
    extraData: '0x',
    logsBloom: `0x${'00'.repeat(256)}`,
    miner: zeroAddress,
    mixHash: zeroHash,
    nonce: '0x0000000000000000',
    receiptsRoot: zeroHash,
    sha3Uncles: zeroHash,
    size: '0x1',
    stateRoot: zeroHash,
    transactionsRoot: zeroHash,
  })

  /**
   * A node with the supported factory, the reseller's lock and a lookalike that answers every lock
   * view the same way and names the same factory. It records which contract each call reached and
   * the block each named.
   */
  function lockNode(opts: { headHash?: Hex; hashLater?: Hex | null } = {}) {
    const headHash = opts.headHash ?? id('block 77')
    const calls: { to: Address; block: unknown; fn: string }[] = []
    let served = 0
    const client = createClient({
      transport: custom({
        async request({ method, params }) {
          if (method === 'eth_getBlockByNumber') {
            const [tag] = params as [string]
            if (tag === 'finalized') return block(HEAD, headHash)
            if (tag !== toHex(HEAD)) return null
            served++
            const later = opts.hashLater === undefined ? headHash : opts.hashLater
            return later === null ? null : block(HEAD, later)
          }
          if (method !== 'eth_call') throw new Error(`The test node doesn't answer ${method}`)
          const [{ to, data }, at] = params as [{ to: Address; data: Hex }, unknown]
          if (isAddressEqual(to, FACTORY)) {
            const call = decodeFunctionData({ abi: FACTORY_ABI, data })
            calls.push({ to, block: at, fn: call.functionName })
            const listed = call.functionName === 'isLock' && isAddressEqual(call.args[0], LOCK)
            return encodeFunctionResult({
              abi: FACTORY_ABI,
              functionName: 'isLock',
              result: listed,
            })
          }
          if (!isAddressEqual(to, LOCK) && !isAddressEqual(to, LOOKALIKE)) {
            throw new Error(`No contract at ${to}`)
          }
          const call = decodeFunctionData({ abi: LOCK_ABI, data })
          calls.push({ to, block: at, fn: call.functionName })
          const results: Record<string, unknown> = {
            factory: FACTORY,
            account: reseller,
            token: '0x20C0000000000000000000000000000000000001',
            commitment: ACCEPTED,
          }
          return encodeFunctionResult({
            abi: LOCK_ABI,
            functionName: call.functionName,
            result: results[call.functionName] as never,
          })
        },
      }),
    })
    return { client, calls, served: () => served }
  }

  it('reads every view of the lock as of the latest finalized block, named by number', async () => {
    const node = lockNode()
    const reader = tempoLockReader(node.client, { factory: FACTORY, chainId: 42431 })
    const head = await reader.head()
    expect(head).toEqual({ number: HEAD, hash: id('block 77') })
    expect(await reader.isLock(LOCK, head.number)).toBe(true)
    expect(await reader.lockFields(LOCK, head.number)).toEqual({
      factory: getAddress(FACTORY),
      account: reseller,
    })
    expect(await reader.commitment(LOCK, upstream, 'buyer', head.number)).toMatchObject({
      state: 'accepted',
      hasReport: false,
      termsHash: upstreamTerms,
    })
    expect(await reader.blockHash(head.number)).toBe(id('block 77'))
    expect(node.calls.length).toBeGreaterThan(0)
    for (const c of node.calls) expect(c.block, c.fn).toBe(toHex(HEAD))
  })

  it("reads a lookalike only through the factory, which doesn't list it", async () => {
    const node = lockNode()
    const reader = tempoLockReader(node.client, { factory: FACTORY, chainId: 42431 })
    expect(await reader.isLock(LOOKALIKE, HEAD)).toBe(false)
    expect(node.calls.every((c) => isAddressEqual(c.to, FACTORY))).toBe(true)
  })

  it('gives no hash for a block the node no longer has', async () => {
    const node = lockNode({ hashLater: null })
    const reader = tempoLockReader(node.client, { factory: FACTORY, chainId: 42431 })
    expect(await reader.blockHash(HEAD)).toBeNull()
    expect(node.served()).toBe(1)
  })

  it('passes a booking relied on through the Tempo reader, recording the block it read', async () => {
    const node = lockNode()
    const reader = tempoLockReader(node.client, { factory: FACTORY, chainId: CHAIN_ID })
    const terms = chainedTerms(testnetDemoTerms(START, ARBITER), [dependencyOn()])
    const result = await verifyDependencies(
      { terms, supplier: reseller, disclosed: [shownUpstream] },
      { readers: [reader] },
    )
    expect(result).toEqual({
      ok: true,
      terms,
      checked: [{ on: dependencyOn().on, block: { number: HEAD, hash: id('block 77') } }],
    })
    for (const c of node.calls) expect(c.block, c.fn).toBe(toHex(HEAD))
  })

  it('refuses the lookalike through the Tempo reader without calling it', async () => {
    const node = lockNode()
    const reader = tempoLockReader(node.client, { factory: FACTORY, chainId: CHAIN_ID })
    const terms = chainedTerms(testnetDemoTerms(START, ARBITER), [
      dependencyOn({ lock: LOOKALIKE }),
    ])
    const result = await verifyDependencies(
      { terms, supplier: reseller, disclosed: [shownUpstream] },
      { readers: [reader] },
    )
    expect(result).toMatchObject({ ok: false, reason: 'dependency.lock_unknown' })
    expect(node.calls.some((c) => isAddressEqual(c.to, LOOKALIKE))).toBe(false)
  })

  it('refuses when the block moved between the first read and the last', async () => {
    const node = lockNode({ hashLater: id('another block 77') })
    const reader = tempoLockReader(node.client, { factory: FACTORY, chainId: CHAIN_ID })
    const terms = chainedTerms(testnetDemoTerms(START, ARBITER), [dependencyOn()])
    const result = await verifyDependencies(
      { terms, supplier: reseller, disclosed: [shownUpstream] },
      { readers: [reader] },
    )
    expect(result).toMatchObject({ ok: false, reason: 'dependency.unreadable' })
  })

  it('needs a chain id from the options or the client', () => {
    expect(() => tempoLockReader(lockNode().client, { factory: FACTORY })).toThrow(/chain/)
  })
})
