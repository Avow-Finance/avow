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
  getTransaction,
  getTransactionReceipt,
  prepareTransactionRequest,
  signTransaction,
} from 'viem/actions'
import type { Call } from './lock.js'

/** How hard the sender tries before it gives up. */
export interface SendLimits {
  /** How many times it prepares a transaction the node refuses, a few seconds apart. */
  prepareTries: number
  /** How many times it signs a sponsored transaction that expired before it landed. */
  signings: number
  /** Milliseconds between tries and between reads of a receipt. */
  wait: number
  /** Milliseconds it waits for a receipt before it gives up. */
  receiptTimeout: number
}

export const SEND_LIMITS: SendLimits = {
  prepareTries: 4,
  signings: 3,
  wait: 2000,
  receiptTimeout: 180_000,
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function prepare(
  client: Client<Transport, Chain>,
  account: Account,
  calls: readonly Call[],
  limits: SendLimits,
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
      if (i >= limits.prepareTries) throw error
      await sleep(limits.wait)
    }
  }
}

/** Sends the bytes, and treats an error as a failure only once the node doesn't know the hash. */
async function submit(client: Client<Transport, Chain>, bytes: Hex, hash: Hex, limits: SendLimits) {
  let last: unknown
  for (let i = 0; i < limits.prepareTries; i++) {
    try {
      await client.request({ method: 'eth_sendRawTransaction', params: [bytes] })
      return
    } catch (error) {
      last = error
    }
    await sleep(limits.wait)
    if (await getTransaction(client, { hash }).catch(() => null)) return
  }
  throw last
}

/**
 * Waits for the receipt by hash. Once the chain's clock passes the transaction's expiry with no
 * receipt, no later block can include it, so it returns null after looking twice more.
 */
async function receiptOf(
  client: Client<Transport, Chain>,
  hash: Hex,
  validBefore: number | undefined,
  limits: SendLimits,
): Promise<TransactionReceipt | null> {
  const deadline = Date.now() + limits.receiptTimeout
  const receipt = () => getTransactionReceipt(client, { hash }).catch(() => null)
  for (;;) {
    const found = await receipt()
    if (found) return found
    if (validBefore !== undefined) {
      const now = (await getBlock(client, { blockTag: 'latest' })).timestamp
      if (now > BigInt(validBefore)) {
        for (let i = 0; i < 2; i++) {
          await sleep(limits.wait)
          const late = await receipt()
          if (late) return late
        }
        return null
      }
    }
    if (Date.now() > deadline) throw new Error(`No receipt for ${hash} after waiting`)
    await sleep(limits.wait)
  }
}

/**
 * Sends a transaction whose fee Avow's relay pays. The key signs it locally with `feePayer: true`,
 * the relay co-signs it, and the co-signed bytes go to the node with their hash tracked from the
 * start, since the public RPC can answer with an error after a transaction has landed. viem makes a
 * sponsored transaction valid for under half a minute, so one that expires before it lands is
 * signed again, up to the limit's number of signings. Throws when the transaction would revert,
 * lands reverted or never lands.
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
  const limits = args.limits ?? SEND_LIMITS
  for (let signing = 1; ; signing++) {
    const request = await prepare(args.client, args.account, args.calls, limits)
    const signed = await signTransaction(args.client, {
      ...request,
      account: args.account,
    } as never)
    const bytes = await args.sponsor(signed)
    const hash = keccak256(bytes)
    args.onSent?.(hash)
    await submit(args.client, bytes, hash, limits)
    const receipt = await receiptOf(args.client, hash, request.validBefore, limits)
    if (receipt) {
      if (receipt.status !== 'success') throw new Error(`The transaction ${hash} reverted`)
      return receipt
    }
    if (signing >= limits.signings) {
      throw new Error(`The transaction expired before it landed, ${signing} times`)
    }
  }
}
