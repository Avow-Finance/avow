import {
  type Account,
  type Chain,
  type Client,
  type Hex,
  keccak256,
  type TransactionReceipt,
  type Transport,
} from 'viem'
import {
  getBlock,
  getBlockNumber,
  getTransaction,
  getTransactionReceipt,
  prepareTransactionRequest,
  signTransaction,
} from 'viem/actions'
import { Transaction } from 'viem/tempo'
import type { Call } from './lock.js'

/** How hard the sender tries before it gives up. */
export interface SendLimits {
  /** How many times it prepares a transaction the node refuses, a few seconds apart. */
  prepareTries: number
  /** How many times it sends the same signed bytes while the node answers with an error. */
  sendTries: number
  /** How many times it signs, when each transaction before expired in no block. */
  signings: number
  /** Milliseconds between tries and between reads of the chain. */
  wait: number
  /** Milliseconds it waits for one transaction's outcome before it gives up, not knowing it. */
  receiptTimeout: number
}

export const SEND_LIMITS: SendLimits = {
  prepareTries: 4,
  sendTries: 4,
  signings: 3,
  wait: 2000,
  receiptTimeout: 180_000,
}

/**
 * Why a send failed, with the hash of every transaction it sent. Its outcome is `failed` when
 * nothing it sent took effect or still can, and `unknown` when a transaction may have landed, so
 * the caller has to read the chain before acting again.
 */
export class SendError extends Error {
  readonly outcome: 'failed' | 'unknown'
  readonly hashes: readonly Hex[]

  constructor(
    message: string,
    outcome: 'failed' | 'unknown',
    hashes: readonly Hex[],
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'SendError'
    this.outcome = outcome
    this.hashes = [...hashes]
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const reason = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300)

function checked(limits: SendLimits): SendLimits {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value < 1) {
      throw new RangeError(`The send limit ${name} has to be a whole number of at least 1`)
    }
  }
  return limits
}

async function prepare(
  client: Client<Transport, Chain>,
  account: Account,
  calls: readonly Call[],
  limits: SendLimits,
  hashes: readonly Hex[],
) {
  for (let i = 1; ; i++) {
    try {
      // `calls` and `feePayer` are Tempo's transaction fields, which viem's generic types omit.
      return (await prepareTransactionRequest(client, {
        account,
        calls,
        feePayer: true,
      } as never)) as { validBefore?: number }
    } catch (error) {
      // A node a block behind can see a step as not due yet, so a refusal counts once it holds.
      if (i >= limits.prepareTries) {
        throw new SendError(
          `The node refused to prepare the transaction: ${reason(error)}`,
          'failed',
          hashes,
          { cause: error },
        )
      }
      await sleep(limits.wait)
    }
  }
}

/** Tempo's transaction fields the relay has to leave as the key signed them. */
const SIGNED_FIELDS = [
  'chainId',
  'calls',
  'nonce',
  'nonceKey',
  'validBefore',
  'validAfter',
  'gas',
  'maxFeePerGas',
  'maxPriorityFeePerGas',
  'accessList',
  'keyAuthorization',
  'signature',
] as const

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a, (_, v) => (typeof v === 'bigint' ? v.toString() : v)) ===
  JSON.stringify(b, (_, v) => (typeof v === 'bigint' ? v.toString() : v))

/**
 * Why the relay's bytes aren't the transaction the key signed with the relay's fee payer
 * signature added, or null when they are. The relay may set the fee token, which the sender
 * doesn't sign, and nothing else.
 */
export function cosignProblem(signed: Hex, cosigned: Hex): string | null {
  let before: Record<string, unknown>
  let after: Record<string, unknown>
  try {
    before = Transaction.deserialize(signed as `0x76${string}`) as Record<string, unknown>
    after = Transaction.deserialize(cosigned as `0x76${string}`) as Record<string, unknown>
  } catch {
    return "the bytes aren't a Tempo transaction"
  }
  if (!after.feePayerSignature) return 'they carry no fee payer signature'
  for (const field of SIGNED_FIELDS) {
    if (!same(before[field], after[field])) return `they change the transaction's ${field}`
  }
  return null
}

/**
 * Sends the bytes, and returns null once the node has them, or the node's last error when it
 * never took them. The public RPC can answer with an error after taking a transaction, so an
 * error counts only while the node doesn't know the hash. The same bytes are the same
 * transaction, so sending them again never sends a second one.
 */
async function submit(
  client: Client<Transport, Chain>,
  bytes: Hex,
  hash: Hex,
  limits: SendLimits,
  hashes: readonly Hex[],
): Promise<unknown> {
  let last: unknown = null
  for (let i = 0; i < limits.sendTries; i++) {
    try {
      const answer = await client.request({ method: 'eth_sendRawTransaction', params: [bytes] })
      if (typeof answer === 'string' && answer.toLowerCase() !== hash.toLowerCase()) {
        throw new SendError(`The node answered with the hash ${answer}, not ${hash}`, 'unknown', [
          ...hashes,
          answer as Hex,
        ])
      }
      return null
    } catch (error) {
      if (error instanceof SendError) throw error
      last = error
    }
    await sleep(limits.wait)
    if (await getTransaction(client, { hash }).catch(() => null)) return null
  }
  return last ?? new Error('The node never took the transaction')
}

/** The latest block's number, read again while the node answers with an error. */
async function latestBlock(
  client: Client<Transport, Chain>,
  limits: SendLimits,
  hashes: readonly Hex[],
): Promise<bigint> {
  for (let i = 1; ; i++) {
    try {
      return await getBlockNumber(client, { cacheTime: 0 })
    } catch (error) {
      if (i >= limits.prepareTries) {
        throw new SendError(
          `The node didn't give its latest block: ${reason(error)}`,
          'failed',
          hashes,
          { cause: error },
        )
      }
      await sleep(limits.wait)
    }
  }
}

/**
 * Waits for a transaction's outcome. It looks for the receipt, and reads each new block by number
 * for the transaction's hash, from the block the node was at before the transaction went out. A
 * block read by number comes whole from a node that has it, so a node a block behind can't hide a
 * transaction that landed. Once it reads a block later than the transaction's expiry, and no block
 * before held the hash, the transaction never landed and no later block can include it. An error
 * from the node is read again, never taken as an answer.
 */
async function outcomeOf(
  client: Client<Transport, Chain>,
  hash: Hex,
  from: bigint,
  validBefore: number | undefined,
  limits: SendLimits,
  hashes: readonly Hex[],
): Promise<TransactionReceipt | 'expired'> {
  const deadline = Date.now() + limits.receiptTimeout
  const wanted = hash.toLowerCase()
  let next = from
  let includedIn: bigint | null = null
  for (;;) {
    const receipt = await getTransactionReceipt(client, { hash }).catch(() => null)
    if (receipt) return receipt
    while (validBefore !== undefined && includedIn === null) {
      const block = await getBlock(client, { blockNumber: next }).catch(() => null)
      if (!block) break
      if (block.transactions.some((t) => String(t).toLowerCase() === wanted)) includedIn = next
      else if (block.timestamp > BigInt(validBefore)) return 'expired'
      else next++
    }
    if (Date.now() > deadline) {
      throw new SendError(
        includedIn === null
          ? `No receipt for ${hash} after waiting, so whether it landed is unknown`
          : `${hash} landed in block ${includedIn}, but its receipt never came, so its outcome is unknown`,
        'unknown',
        hashes,
      )
    }
    await sleep(limits.wait)
  }
}

/**
 * Sends a transaction whose fee Avow's relay pays. The key signs it locally with `feePayer: true`,
 * the relay co-signs it, and the sender checks the relay's bytes are the transaction the key
 * signed before sending them and tracking their hash from the start, since the public RPC can
 * answer with an error after a transaction has landed. viem makes a sponsored transaction valid
 * for under half a minute, and the sender signs again only once it has read every block up to one
 * later than that and found the transaction in none, up to the limit's number of signings. The
 * relay only co-signs and never sends, so a refusal from it sends nothing. It throws a `SendError`
 * when the transaction can't be prepared, lands reverted, never lands, or has an outcome the chain
 * didn't show in time.
 */
export async function sendSponsored(args: {
  client: Client<Transport, Chain>
  account: Account
  calls: readonly Call[]
  sponsor: (transaction: Hex) => Promise<Hex>
  /** Called with each hash before its bytes go to the node. */
  onSent?: (hash: Hex) => void
  limits?: SendLimits
}): Promise<TransactionReceipt> {
  const limits = checked(args.limits ?? SEND_LIMITS)
  const hashes: Hex[] = []
  for (let signing = 1; ; signing++) {
    const request = await prepare(args.client, args.account, args.calls, limits, hashes)
    const signed = await signTransaction(args.client, {
      ...request,
      account: args.account,
    } as never)
    let bytes: Hex
    try {
      bytes = await args.sponsor(signed)
    } catch (error) {
      throw new SendError(`The relay didn't co-sign: ${reason(error)}`, 'failed', hashes, {
        cause: error,
      })
    }
    const problem = cosignProblem(signed, bytes)
    if (problem) {
      throw new SendError(
        `The relay's bytes aren't the transaction the key signed: ${problem}`,
        'failed',
        hashes,
      )
    }
    const hash = keccak256(bytes)
    const from = await latestBlock(args.client, limits, hashes)
    hashes.push(hash)
    args.onSent?.(hash)
    const refused = await submit(args.client, bytes, hash, limits, hashes)
    const outcome = await outcomeOf(args.client, hash, from, request.validBefore, limits, hashes)
    if (outcome !== 'expired') {
      if (outcome.status !== 'success') {
        throw new SendError(`The transaction ${hash} reverted`, 'failed', hashes)
      }
      return outcome
    }
    if (refused !== null) {
      throw new SendError(
        `The node never took the transaction: ${reason(refused)}`,
        'failed',
        hashes,
        {
          cause: refused,
        },
      )
    }
    if (signing >= limits.signings) {
      throw new SendError(`The transaction expired in no block, ${signing} times`, 'failed', hashes)
    }
  }
}
