import {
  type Address,
  createClient,
  custom,
  decodeFunctionData,
  defineChain,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  type Hex,
  hexToBigInt,
  isAddressEqual,
  parseAbiItem,
  publicActions,
  toHex,
} from 'viem'
import { Abis, Addresses } from 'viem/tempo'
import { FACTORY_ABI } from '../lock.js'
import type { SandboxClient } from '../sandbox/business.js'

const KEYCHAIN = Addresses.accountKeychain as Address
const LOCK_CREATED = parseAbiItem('event LockCreated(address indexed account, address lock)')
const NO_EXPIRY = 2n ** 64n - 1n
const HASH = `0x${'ab'.repeat(32)}` as Hex

/** A key as the fake keychain holds it. */
export interface FakeKey {
  key: Address
  admin?: boolean
  revoked?: boolean
  /** The block its authorization landed in, and the witness that came with it. */
  block: bigint
  witness?: Hex
}

/** A log in the form a node returns it. */
const log = (address: Address, topics: Hex[], data: Hex, block: bigint) => ({
  address,
  topics,
  data,
  blockNumber: toHex(block),
  blockHash: HASH,
  transactionHash: HASH,
  transactionIndex: '0x0',
  logIndex: '0x0',
  removed: false,
})

/**
 * A stand-in for Moderato's node that holds one business: its lock, made by the factory at
 * `lockBlock`, and the keys on its account. It records every method it was asked that isn't a
 * read, so a test can tell nothing was sent.
 */
export function fakeChain(c: {
  factory: Address
  account: Address
  lock: Address
  lockBlock: bigint
  latest: bigint
  keys?: FakeKey[]
}): { client: SandboxClient; writes: string[]; ranges: [bigint, bigint][] } {
  const keys = c.keys ?? []
  const writes: string[] = []
  const ranges: [bigint, bigint][] = []
  const keyAuthorized = (k: FakeKey) =>
    log(
      KEYCHAIN,
      encodeEventTopics({
        abi: Abis.accountKeychain,
        eventName: 'KeyAuthorized',
        args: { account: c.account, publicKey: k.key },
      }) as Hex[],
      encodeAbiParameters([{ type: 'uint8' }, { type: 'uint64' }], [0, NO_EXPIRY]),
      k.block,
    )
  const adminKeyAuthorized = (k: FakeKey) =>
    log(
      KEYCHAIN,
      encodeEventTopics({
        abi: Abis.accountKeychain,
        eventName: 'AdminKeyAuthorized',
        args: { account: c.account, publicKey: k.key },
      }) as Hex[],
      '0x',
      k.block,
    )
  const witness = (k: FakeKey) =>
    log(
      KEYCHAIN,
      encodeEventTopics({
        abi: Abis.accountKeychain,
        eventName: 'KeyAuthorizationWitness',
        args: { account: c.account, witness: k.witness ?? HASH },
      }) as Hex[],
      '0x',
      k.block,
    )
  const lockCreated = log(
    c.factory,
    encodeEventTopics({ abi: [LOCK_CREATED], args: { account: c.account } }) as Hex[],
    encodeAbiParameters([{ type: 'address' }], [c.lock]),
    c.lockBlock,
  )
  const topic = (eventName: 'KeyAuthorized' | 'AdminKeyAuthorized') =>
    (encodeEventTopics({ abi: Abis.accountKeychain, eventName }) as Hex[])[0]

  const request = async ({ method, params }: { method: string; params?: unknown }) => {
    const p = (params ?? []) as Record<string, unknown>[]
    switch (method) {
      case 'eth_chainId':
        return toHex(42431)
      case 'eth_blockNumber':
        return toHex(c.latest)
      case 'eth_getCode':
        return isAddressEqual(p[0] as unknown as Address, c.lock) ? '0x6080' : '0x'
      case 'eth_call': {
        const { to, data } = p[0] as { to: Address; data: Hex }
        if (isAddressEqual(to, c.factory)) {
          return encodeFunctionResult({
            abi: FACTORY_ABI,
            functionName: 'lockAddress',
            result: c.lock,
          })
        }
        const call = decodeFunctionData({ abi: Abis.accountKeychain, data })
        const k = keys.find((x) =>
          isAddressEqual(x.key, (call.args as unknown as Address[])[1] as Address),
        )
        if (call.functionName === 'isAdminKey') {
          return encodeFunctionResult({
            abi: Abis.accountKeychain,
            functionName: 'isAdminKey',
            result: Boolean(k?.admin && !k.revoked),
          })
        }
        return encodeFunctionResult({
          abi: Abis.accountKeychain,
          functionName: 'getKey',
          result: {
            signatureType: 0,
            keyId: k && !k.revoked ? k.key : '0x0000000000000000000000000000000000000000',
            expiry: k && !k.revoked ? NO_EXPIRY : 0n,
            enforceLimits: false,
            isRevoked: Boolean(k?.revoked),
          },
        })
      }
      case 'eth_getLogs': {
        const f = p[0] as { address: Address; topics: Hex[]; fromBlock: Hex; toBlock: Hex }
        const from = hexToBigInt(f.fromBlock)
        const to = hexToBigInt(f.toBlock)
        const inRange = (b: bigint) => b >= from && b <= to
        if (isAddressEqual(f.address, c.factory)) {
          ranges.push([from, to])
          return inRange(c.lockBlock) ? [lockCreated] : []
        }
        if (f.topics[0] === topic('KeyAuthorized')) {
          return keys.filter((k) => !k.admin && inRange(k.block)).map(keyAuthorized)
        }
        if (f.topics[0] === topic('AdminKeyAuthorized')) {
          return keys.filter((k) => k.admin && inRange(k.block)).map(adminKeyAuthorized)
        }
        return []
      }
      case 'eth_getTransactionReceipt': {
        const k = keys.find((x) => !x.admin)
        return {
          transactionHash: HASH,
          transactionIndex: '0x0',
          blockHash: HASH,
          blockNumber: toHex(k?.block ?? 1n),
          from: c.account,
          to: KEYCHAIN,
          cumulativeGasUsed: '0x1',
          gasUsed: '0x1',
          effectiveGasPrice: '0x1',
          contractAddress: null,
          logsBloom: `0x${'00'.repeat(256)}`,
          status: '0x1',
          type: '0x2',
          logs: k ? [keyAuthorized(k), witness(k)] : [],
        }
      }
      default:
        writes.push(method)
        throw new Error(`The fake chain doesn't serve ${method}`)
    }
  }
  const chain = defineChain({
    id: 42431,
    name: 'Fake Moderato',
    nativeCurrency: { name: 'USD', symbol: 'USD', decimals: 6 },
    rpcUrls: { default: { http: ['http://127.0.0.1'] } },
  })
  const client: SandboxClient = createClient({ chain, transport: custom({ request }) }).extend(
    publicActions,
  )
  return { client, writes, ranges }
}
