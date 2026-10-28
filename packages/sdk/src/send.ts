import { TxEnvelopeTempo } from 'ox/tempo'
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
 * Why a send failed, with the hash of every transaction it sent and how many the key signed. Its
 * outcome is `failed` when nothing it sent took effect or still can, and `unknown` when a
 * transaction may have landed, so the caller has to read the chain before acting again. A `failed`
 * after signing assumes nobody sent the signed transaction but the sender, which the relay's
 * contract promises.
 */
export class SendError extends Error {
  readonly outcome: 'failed' | 'unknown'
  readonly hashes: readonly Hex[]
  readonly signings: number

  constructor(
    message: string,
    outcome: 'failed' | 'unknown',
    sent: { hashes: readonly Hex[]; signings: number },
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'SendError'
    this.outcome = outcome
    this.hashes = [...sent.hashes]
    this.signings = sent.signings
  }
}

/** What a send has done so far, which every error it throws carries. */
interface Sent {
  hashes: Hex[]
  signings: number
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
  sent: Sent,
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
          sent,
          { cause: error },
        )
      }
      await sleep(limits.wait)
    }
  }
}

/** The fields a sender signs, named when the relay's bytes change one. */
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
  'authorizationList',
  'keyAuthorization',
] as const

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a, (_, v) => (typeof v === 'bigint' ? v.toString() : v)) ===
  JSON.stringify(b, (_, v) => (typeof v === 'bigint' ? v.toString() : v))

/**
 * Why the relay's bytes aren't the transaction the key signed with a fee payer's signature added,
 * or null when they are. The payload the key signed has to be the same in both, which covers every
 * call with its destination, data and value, the nonce, the validity window, the gas and fees, and
 * any key authorization, and the key's signature has to be the same too. Only the fee token, which
 * a sender doesn't sign, and the fee payer's signature may differ.
 */
export function cosignProblem(signed: Hex, cosigned: Hex): string | null {
  let before: TxEnvelopeTempo.TxEnvelopeTempo
  let after: TxEnvelopeTempo.TxEnvelopeTempo
  try {
    before = TxEnvelopeTempo.deserialize(signed as TxEnvelopeTempo.Serialized)
    after = TxEnvelopeTempo.deserialize(cosigned as TxEnvelopeTempo.Serialized)
  } catch {
    return "the bytes aren't a Tempo transaction"
  }
  if (!after.feePayerSignature) return 'they carry no fee payer signature'
  if (!before.signature || !same(before.signature, after.signature)) {
    return "they change the key's signature"
  }
  if (TxEnvelopeTempo.getSignPayload(before) !== TxEnvelopeTempo.getSignPayload(after)) {
    const changed = SIGNED_FIELDS.find((field) => !same(before[field], after[field]))
    return `they change what the key signed${changed ? `, its ${changed} among it` : ''}`
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
  sent: Sent,
): Promise<unknown> {
  let last: unknown = null
  for (let i = 0; i < limits.sendTries; i++) {
    try {
      const answer = await client.request({ method: 'eth_sendRawTransaction', params: [bytes] })
      if (typeof answer === 'string' && answer.toLowerCase() !== hash.toLowerCase()) {
        throw new SendError(`The node answered with the hash ${answer}, not ${hash}`, 'unknown', {
          hashes: [...sent.hashes, answer as Hex],
          signings: sent.signings,
        })
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
  sent: Sent,
): Promise<bigint> {
  for (let i = 1; ; i++) {
    try {
      return await getBlockNumber(client, { cacheTime: 0 })
    } catch (error) {
      if (i >= limits.prepareTries) {
        throw new SendError(
          `The node didn't give its latest block: ${reason(error)}`,
          'failed',
          sent,
          {
            cause: error,
          },
        )
      }
      await sleep(limits.wait)
    }
  }
}

/**
 * Waits for a transaction's outcome. It looks for the receipt, and reads each block by number for
 * the transaction's hash, from the block the node was at before the key signed. It reads only
 * blocks at or below the chain's finalized block, which no later answer can change, and a block
 * read by number comes whole or not at all, so a node that's behind can't hide a block. A failed or
 * missing read stops the scan at that block until a later read gets it. Once the scan reads a block
 * later than the transaction's expiry, and no block before it held the hash, the transaction never
 * landed and no later block can include it. Tempo only includes a transaction in a block before its
 * `validBefore`, and a block later than it counts here, one second more cautious than that rule.
 */
async function outcomeOf(
  client: Client<Transport, Chain>,
  hash: Hex,
  from: bigint,
  validBefore: number | undefined,
  limits: SendLimits,
  sent: Sent,
): Promise<TransactionReceipt | 'expired'> {
  const deadline = Date.now() + limits.receiptTimeout
  const late = () => Date.now() > deadline
  const wanted = hash.toLowerCase()
  let next = from
  let includedIn: bigint | null = null
  for (;;) {
    const receipt = await getTransactionReceipt(client, { hash }).catch(() => null)
    if (receipt) return receipt
    if (validBefore !== undefined && includedIn === null) {
      const final = await getBlock(client, { blockTag: 'finalized' }).catch(() => null)
      while (final && next <= final.number && includedIn === null && !late()) {
        const block = await getBlock(client, { blockNumber: next }).catch(() => null)
        if (!block) break
        if (block.transactions.some((t) => String(t).toLowerCase() === wanted)) includedIn = next
        else if (block.timestamp > BigInt(validBefore)) return 'expired'
        else next++
      }
    }
    if (late()) {
      throw new SendError(
        includedIn === null
          ? `No receipt for ${hash} after waiting, so whether it landed is unknown`
          : `${hash} landed in block ${includedIn}, but its receipt never came, so its outcome is unknown`,
        'unknown',
        sent,
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
 * for under half a minute. The sender signs again only once it has read every finalized block,
 * from before the key signed up to one later than that expiry, and found the transaction in none,
 * up to the limit's number of signings. It throws a `SendError` when the transaction can't be
 * prepared, lands reverted, never lands, or has an outcome the chain didn't show in time.
 */
export async function sendSponsored(args: {
  client: Client<Transport, Chain>
  account: Account
  calls: readonly Call[]
  /**
   * Has the relay co-sign the signed transaction and returns the co-signed bytes. It must never
   * send the transaction itself or pass it on, since anyone holding it could land it until it
   * expires, and the sender's outcomes assume only the sender sends it.
   */
  sponsor: (transaction: Hex) => Promise<Hex>
  /** Called with each hash before its bytes go to the node. */
  onSent?: (hash: Hex) => void
  limits?: SendLimits
}): Promise<TransactionReceipt> {
  const limits = checked(args.limits ?? SEND_LIMITS)
  const sent: Sent = { hashes: [], signings: 0 }
  for (;;) {
    const request = await prepare(args.client, args.account, args.calls, limits, sent)
    // Read before the key signs, so no block that could hold the transaction comes before it.
    const from = await latestBlock(args.client, limits, sent)
    const signed = await signTransaction(args.client, {
      ...request,
      account: args.account,
    } as never)
    sent.signings++
    let bytes: Hex
    try {
      bytes = await args.sponsor(signed)
    } catch (error) {
      throw new SendError(`The relay didn't co-sign: ${reason(error)}`, 'failed', sent, {
        cause: error,
      })
    }
    const problem = cosignProblem(signed, bytes)
    if (problem) {
      throw new SendError(
        `The relay's bytes aren't the transaction the key signed: ${problem}`,
        'failed',
        sent,
      )
    }
    const hash = keccak256(bytes)
    sent.hashes.push(hash)
    args.onSent?.(hash)
    const refused = await submit(args.client, bytes, hash, limits, sent)
    const outcome = await outcomeOf(args.client, hash, from, request.validBefore, limits, sent)
    if (outcome !== 'expired') {
      if (outcome.status !== 'success') {
        throw new SendError(`The transaction ${hash} reverted`, 'failed', sent)
      }
      return outcome
    }
    if (refused !== null) {
      throw new SendError(
        `The node never took the transaction: ${reason(refused)}`,
        'failed',
        sent,
        {
          cause: refused,
        },
      )
    }
    if (sent.signings >= limits.signings) {
      throw new SendError(
        `The transaction expired in no block, ${sent.signings} times`,
        'failed',
        sent,
      )
    }
  }
}
