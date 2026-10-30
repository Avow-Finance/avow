import { MODERATO_FEE_TOKEN, MODERATO_RPC_URL, TRIGGER_ABI } from '@avow-finance/sdk'
import {
  type Address,
  createClient,
  custom,
  decodeFunctionData,
  type Hex,
  HttpRequestError,
  keccak256,
  numberToHex,
  RpcRequestError,
} from 'viem'
import { tempoModerato } from 'viem/chains'
import { Transaction } from 'viem/tempo'

/*
 * A JSON-RPC node the Tempo adapter's tests script, behind viem's custom transport, so viem's own
 * actions and the SDK's sender run as they do against Moderato. Its answers copy the shape of
 * Moderato's, and its errors are the ones viem's HTTP transport raises for Moderato's.
 */

/** A log the node holds, in the form eth_getLogs returns. */
export interface NodeLog {
  address: Address
  block: bigint
  topics: [Hex, ...Hex[]]
  data: Hex
}

/** What the node does with a raw transaction it's sent. */
export type SendBehavior =
  /** It takes the transaction and answers with its hash. */
  | 'answer'
  /** It takes the transaction, and the gateway in front of it answers with a 502. */
  | 'take-then-fail'

export interface NodeScript {
  head: bigint
  logs?: NodeLog[]
  /** The most logs one eth_getLogs answer holds, 20,000 by default as on Moderato. */
  maxResults?: number
  /** Calls to `trigger` that succeed, as `lock:commitmentId:sideCode`, all lowercase. */
  due?: string[]
  /**
   * The data a call to `trigger` that isn't due reverts with, the lock's `NothingDue()` by
   * default, or null for a revert with none.
   */
  revertData?: Hex | null
  /** How every eth_call fails, when it does: a gateway error, an HTTP 429 or a JSON-RPC limit. */
  callsFail?: 'gateway' | 'http-rate-limit' | 'rpc-rate-limit'
  send?: SendBehavior
  /** The receipt a transaction it takes gets, or none ever. */
  receipt?: 'success' | 'reverted' | 'none'
}

const FAUCET_HASHES: Hex[] = [`0x${'fa'.repeat(32)}`, `0x${'fb'.repeat(32)}`]
/** What the deployed lock reverts with when no step is due, `NothingDue()`. */
export const NOTHING_DUE: Hex = '0x86fdb19c'

const rpcError = (method: string, params: unknown, code: number, message: string, data?: Hex) =>
  new RpcRequestError({
    body: { method, params },
    error: { code, message, ...(data ? { data } : {}) },
    url: MODERATO_RPC_URL,
  })

export function scriptedNode(script: NodeScript) {
  const startedAt = BigInt(Math.floor(Date.now() / 1000))
  /** Every request, in order. */
  const requests: { method: string; params: unknown[] }[] = []
  /** The bytes of each eth_sendRawTransaction, in order. */
  const sent: Hex[] = []
  const taken = new Map<
    Hex,
    { calls: readonly { to?: Address | undefined; data?: Hex | undefined }[] }
  >()

  const hashOf = (n: bigint) => numberToHex(n, { size: 32 })
  const block = (n: bigint) => ({
    number: numberToHex(n),
    hash: hashOf(n),
    parentHash: hashOf(n - 1n),
    // One second a block, with the head at the time the node was made.
    timestamp: numberToHex(startedAt - (script.head - n)),
    baseFeePerGas: '0x23c34600',
    gasLimit: '0x1dcd6500',
    gasUsed: '0x0',
    miner: '0x0000000000000000000000000000000000000000',
    difficulty: '0x0',
    extraData: '0x',
    logsBloom: `0x${'00'.repeat(256)}`,
    mixHash: `0x${'00'.repeat(32)}`,
    nonce: '0x0000000000000000',
    receiptsRoot: `0x${'00'.repeat(32)}`,
    sha3Uncles: `0x${'00'.repeat(32)}`,
    size: '0x4e0',
    stateRoot: `0x${'00'.repeat(32)}`,
    transactionsRoot: `0x${'00'.repeat(32)}`,
    transactions: [],
    uncles: [],
  })
  const receipt = (hash: Hex, status: '0x1' | '0x0') => ({
    type: '0x76',
    status,
    cumulativeGasUsed: '0x4f657',
    logs: [],
    logsBloom: `0x${'00'.repeat(256)}`,
    transactionHash: hash,
    transactionIndex: '0x0',
    blockHash: hashOf(script.head),
    blockNumber: numberToHex(script.head),
    gasUsed: '0x4f657',
    effectiveGasPrice: '0x23c34601',
    from: '0xbe54f9cbaf3c47b542cd64c41ac1dc26508986bc',
    to: '0x101878b1adbfc7029cb41ffc19d00fb6b79151b4',
    contractAddress: null,
    feeToken: MODERATO_FEE_TOKEN.toLowerCase(),
    feePayer: '0xbe54f9cbaf3c47b542cd64c41ac1dc26508986bc',
  })
  const transaction = (hash: Hex) => ({
    type: '0x76',
    chainId: numberToHex(tempoModerato.id),
    feeToken: MODERATO_FEE_TOKEN.toLowerCase(),
    maxPriorityFeePerGas: '0x1',
    maxFeePerGas: '0x55d4a801',
    gas: '0x30000',
    calls: (taken.get(hash)?.calls ?? []).map((c) => ({
      to: c.to,
      value: '0x0',
      input: c.data,
      data: null,
    })),
    accessList: [],
    nonceKey: `0x${'ff'.repeat(32)}`,
    nonce: '0x0',
    feePayerSignature: null,
    validBefore: null,
    validAfter: null,
    keyAuthorization: null,
    aaAuthorizationList: [],
    signature: { type: 'secp256k1', r: '0x1', s: '0x1', yParity: '0x0', v: '0x0' },
    hash,
    blockHash: null,
    blockNumber: null,
    transactionIndex: null,
    from: '0xbe54f9cbaf3c47b542cd64c41ac1dc26508986bc',
    gasPrice: '0x23c34601',
  })

  function getLogs(method: string, params: unknown[]) {
    const [filter] = params as [
      { address: Address | Address[]; topics: [Hex[]]; fromBlock: Hex; toBlock: Hex },
    ]
    const from = BigInt(filter.fromBlock)
    const to = BigInt(filter.toBlock)
    if (to - from > 100_000n) {
      throw rpcError(method, params, -32602, 'query exceeds max block range 100000')
    }
    const named = new Set([filter.address].flat().map((a) => a.toLowerCase()))
    const wanted = new Set(filter.topics[0].map((t) => t.toLowerCase()))
    const found = (script.logs ?? [])
      .filter((l) => named.has(l.address.toLowerCase()) && wanted.has(l.topics[0].toLowerCase()))
      .filter((l) => l.block >= from && l.block <= to)
    const most = script.maxResults ?? 20_000
    if (found.length > most) {
      const retry = `${from}-${from + (to - from) / 2n}`
      throw rpcError(
        method,
        params,
        -32602,
        `query exceeds max results ${most}, retry with the range ${retry}`,
      )
    }
    return found.map((l, i) => ({
      address: l.address.toLowerCase(),
      topics: l.topics,
      data: l.data,
      blockNumber: numberToHex(l.block),
      blockHash: hashOf(l.block),
      transactionHash: keccak256(numberToHex(l.block * 1000n + BigInt(i))),
      transactionIndex: '0x0',
      logIndex: numberToHex(i),
      removed: false,
    }))
  }

  function simulate(method: string, params: unknown[]) {
    switch (script.callsFail) {
      case 'gateway':
        throw new HttpRequestError({ url: MODERATO_RPC_URL, status: 502, details: 'Bad Gateway' })
      case 'http-rate-limit':
        throw new HttpRequestError({
          url: MODERATO_RPC_URL,
          status: 429,
          details: 'Too Many Requests',
        })
      case 'rpc-rate-limit':
        throw rpcError(method, params, -32005, 'rate limit exceeded')
    }
    const [request] = params as [{ to?: Address; data?: Hex; calls?: { to: Address; data: Hex }[] }]
    const to = request.to ?? request.calls?.[0]?.to
    const data = request.data ?? request.calls?.[0]?.data
    if (!to || !data) throw rpcError(method, params, -32602, 'a call with nowhere to go')
    const { args } = decodeFunctionData({ abi: TRIGGER_ABI, data })
    const key = `${to}:${args[0]}:${args[1]}`.toLowerCase()
    if (!(script.due ?? []).includes(key)) {
      const data = script.revertData === undefined ? NOTHING_DUE : script.revertData
      throw rpcError(method, params, 3, 'execution reverted', data ?? undefined)
    }
    return '0x'
  }

  async function request({ method, params = [] }: { method: string; params?: unknown[] }) {
    requests.push({ method, params })
    switch (method) {
      case 'eth_chainId':
        return numberToHex(tempoModerato.id)
      case 'eth_blockNumber':
        return numberToHex(script.head)
      case 'eth_getBlockByNumber': {
        const [tag] = params as [Hex | 'latest' | 'finalized']
        const n = tag === 'latest' || tag === 'finalized' ? script.head : BigInt(tag)
        return n <= script.head ? block(n) : null
      }
      case 'eth_getLogs':
        return getLogs(method, params)
      case 'eth_call':
        return simulate(method, params)
      case 'eth_fillTransaction':
        throw rpcError(method, params, -32601, 'the method eth_fillTransaction does not exist')
      case 'eth_estimateGas':
        return '0x30000'
      case 'eth_maxPriorityFeePerGas':
        return '0x1'
      case 'tempo_fundAddress':
        return FAUCET_HASHES
      case 'eth_sendRawTransaction': {
        const [bytes] = params as [Hex]
        sent.push(bytes)
        const hash = keccak256(bytes)
        const tx = Transaction.deserialize(bytes as Transaction.TransactionSerializedTempo)
        taken.set(hash, { calls: 'calls' in tx ? (tx.calls ?? []) : [] })
        if (script.send === 'take-then-fail') {
          throw new HttpRequestError({ url: MODERATO_RPC_URL, status: 502, details: 'Bad Gateway' })
        }
        return hash
      }
      case 'eth_getTransactionByHash': {
        const [hash] = params as [Hex]
        return taken.has(hash) ? transaction(hash) : null
      }
      case 'eth_getTransactionReceipt': {
        const [hash] = params as [Hex]
        if (FAUCET_HASHES.includes(hash)) return receipt(hash, '0x1')
        if (!taken.has(hash) || script.receipt === 'none') return null
        return receipt(hash, script.receipt === 'reverted' ? '0x0' : '0x1')
      }
      default:
        throw rpcError(method, params, -32601, `the scripted node has no ${method}`)
    }
  }

  const client = createClient({
    chain: tempoModerato.extend({ feeToken: MODERATO_FEE_TOKEN }),
    transport: custom({ request }, { retryCount: 0 }),
  })
  return { client, requests, sent, faucetHashes: FAUCET_HASHES }
}
