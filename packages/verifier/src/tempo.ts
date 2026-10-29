import {
  CHARGE_KINDS,
  type Charge,
  type ChargeKind,
  type ObservedTransfer,
  RAIL_STATES,
  SIDE_CODES,
  tempoKeychainCheck,
} from '@avow-finance/spec'
import {
  type Address,
  BlockNotFoundError,
  type Client,
  type Hex,
  isAddressEqual,
  parseEventLogs,
  TransactionReceiptNotFoundError,
  zeroAddress,
} from 'viem'
import { getBlock, getTransactionReceipt, readContract } from 'viem/actions'
import { Abis, Addresses } from 'viem/tempo'
import type { AgentKeyInfo, ChainReader, LockedBacking, LockInfo } from './chain.js'
import { FACTORY_ABI, LOCK_ABI } from './lock-abi.js'

/** The keychain stores a key with no expiry as the largest uint64. */
const NO_EXPIRY = 2n ** 64n - 1n

/**
 * Reads an agent key from Tempo's keychain: whether it's revoked, when it expires, and the
 * mandate hash bound into it. The keychain logs that hash as a witness in the transaction that
 * authorized the key, and Moderato's public RPC searches logs only over short block ranges, so the
 * caller names that transaction. Its receipt comes from the chain, so naming it proves nothing on
 * its own: the key and the witness must both appear in it.
 */
export async function readAgentKey(
  client: Client,
  account: Address,
  key: Address,
  authorizedIn: Hex,
): Promise<AgentKeyInfo | null> {
  const stored = await readContract(client, {
    address: Addresses.accountKeychain,
    abi: Abis.accountKeychain,
    functionName: 'getKey',
    args: [account, key],
  })
  if (isAddressEqual(stored.keyId, zeroAddress)) return null

  const receipt = await getTransactionReceipt(client, { hash: authorizedIn })
  const logs = parseEventLogs({
    abi: Abis.accountKeychain,
    logs: receipt.logs.filter((l) => isAddressEqual(l.address, Addresses.accountKeychain)),
  })
  // Tempo's witness event doesn't name the key, so the transaction must authorize exactly one key
  // for this account, this one, with exactly one witness. Anything else can't be paired safely.
  const authorizedKeys = logs.flatMap((l) =>
    l.eventName === 'KeyAuthorized' && isAddressEqual(l.args.account, account)
      ? [l.args.publicKey]
      : [],
  )
  const witnesses = logs.flatMap((l) =>
    l.eventName === 'KeyAuthorizationWitness' && isAddressEqual(l.args.account, account)
      ? [l.args.witness]
      : [],
  )
  const onlyThisKey =
    authorizedKeys.length === 1 && isAddressEqual(authorizedKeys[0] ?? zeroAddress, key)
  return {
    active: !stored.isRevoked,
    expiry: stored.expiry >= NO_EXPIRY ? null : stored.expiry,
    witness: onlyThisKey && witnesses.length === 1 ? (witnesses[0] ?? null) : null,
  }
}

/** Tempo puts every TIP-20 token at these 12 bytes, `0x20c0` and ten zero bytes, then its 8-byte id. */
const TIP20_PREFIX = '0x20c000000000000000000000'

/** Whether an address is a TIP-20 token's, by the whole 12-byte prefix. */
function isTip20(address: Address): boolean {
  return address.toLowerCase().startsWith(TIP20_PREFIX)
}

/**
 * Reads the log at one index of one transaction. The log counts as a payment only when a TIP-20
 * token emitted it and it decodes as that token's `TransferWithMemo` event, and the caller checks
 * that the token is the one the reference names and one it accepts. The receipt is final only
 * when its block is at or below the chain's finalized block and is the chain's block at that
 * height, so a receipt from a block that lost a reorg never reads as final.
 */
export async function readTransfer(
  client: Client,
  chainId: number,
  transactionHash: Hex,
  logIndex: number,
): Promise<ObservedTransfer | null> {
  // The finalized block is read first, so every block at or below it stays the chain's block.
  const final = await getBlock(client, { blockTag: 'finalized' })
  let receipt: Awaited<ReturnType<typeof getTransactionReceipt>>
  try {
    receipt = await getTransactionReceipt(client, { hash: transactionHash })
  } catch (error) {
    if (error instanceof TransactionReceiptNotFoundError) return null
    throw error
  }
  const log = receipt.logs.find((l) => l.logIndex === logIndex)
  if (!log) return null
  let finalized = false
  if (final.number !== null && receipt.blockNumber <= final.number) {
    // A node a block behind may not have the block yet, and then the receipt reads as not final.
    const atHeight = await getBlock(client, { blockNumber: receipt.blockNumber }).catch(
      (error: unknown) => {
        if (error instanceof BlockNotFoundError) return null
        throw error
      },
    )
    finalized =
      atHeight?.hash != null && atHeight.hash.toLowerCase() === receipt.blockHash.toLowerCase()
  }
  const [decoded] = isTip20(log.address)
    ? parseEventLogs({ abi: Abis.tip20, eventName: 'TransferWithMemo', logs: [log], strict: true })
    : []
  return {
    chainId,
    transactionHash: receipt.transactionHash,
    logIndex,
    succeeded: receipt.status === 'success',
    finalized,
    emitter: log.address,
    event: decoded
      ? {
          from: decoded.args.from,
          to: decoded.args.to,
          amount: decoded.args.amount,
          memo: decoded.args.memo,
        }
      : null,
  }
}

const KIND_NAMES = new Map<number, ChargeKind>(
  (Object.entries(CHARGE_KINDS) as [ChargeKind, number][]).map(([name, code]) => [code, name]),
)

/**
 * Reads what a lock holds for one side of a commitment, or null when it holds nothing. It reads
 * only the lock, so it needs no factory, and the caller decides whether the lock is Avow's. Given
 * a block number it reads the lock as of that block, and a node that doesn't have the block yet
 * refuses the read.
 */
export async function readBacking(
  client: Client,
  lock: Address,
  commitmentId: Hex,
  side: 'buyer' | 'supplier',
  options: { blockNumber?: bigint } = {},
): Promise<LockedBacking | null> {
  const at = options.blockNumber === undefined ? {} : { blockNumber: options.blockNumber }
  const [c, token] = await Promise.all([
    readContract(client, {
      address: lock,
      abi: LOCK_ABI,
      functionName: 'commitment',
      args: [commitmentId, SIDE_CODES[side]],
      ...at,
    }),
    readContract(client, { address: lock, abi: LOCK_ABI, functionName: 'token', ...at }),
  ])
  if (c.state === 0) return null
  const state = RAIL_STATES[c.state]
  if (!state) throw new Error(`The lock reports state ${c.state}, which this verifier doesn't read`)
  const charges: Charge[] = []
  for (let k = 0; k < c.most.length; k++) {
    if ((c.kinds & (1 << k)) === 0) continue
    const kind = KIND_NAMES.get(k)
    if (!kind) throw new Error(`The lock holds charge kind ${k}, which this verifier doesn't read`)
    charges.push({ kind, most: c.most[k] ?? 0n, earliest: c.earliest[k] ?? 0n })
  }
  return {
    state,
    token,
    amount: c.amount,
    held: c.held,
    payee: c.payout,
    supplier: c.supplier,
    supplierSigner: c.supplierSigner,
    freeCancelBy: c.freeCancelBy,
    acceptBy: c.acceptBy,
    chargeDeadline: c.chargeDeadline,
    contestWindow: c.contestWindow,
    releaseDate: c.releaseDate,
    charges,
    day90SupplierShareBps: c.day90ShareBps,
    arbiter: c.arbiter,
    termsHash: c.termsHash,
    mandateHash: c.mandateHash,
    approvalHash: c.approvalHash,
    fundingKey: c.fundedBy,
    reportCount: c.reportCount,
    hasRuling: c.hasRuling,
  }
}

export interface TempoReaderOptions {
  /** The factory the supplier trusts. Only a lock it created counts as Avow's. */
  factory: Address
  /** The chain's id, the client's own chain when left out. */
  chainId?: number
}

/**
 * Reads Tempo directly: the lock's settings and its record of a commitment, the agent key in the
 * keychain, and account signatures through Tempo's own signature verifier. A lock counts as
 * Avow's only when the factory the supplier pinned says it created it, since any contract can name
 * a factory. The supplier trusts the node the client talks to, so it uses one it chose.
 */
export function tempoChainReader(client: Client, options: TempoReaderOptions): ChainReader {
  const chainId = options.chainId ?? client.chain?.id
  if (chainId === undefined) throw new Error("Name the chain's id, or give the client a chain")
  const check = tempoKeychainCheck(client)
  const tokenOf = (lock: Address) =>
    readContract(client, { address: lock, abi: LOCK_ABI, functionName: 'token' })

  async function lock(lock: Address): Promise<LockInfo | null> {
    const created = await readContract(client, {
      address: options.factory,
      abi: FACTORY_ABI,
      functionName: 'isLock',
      args: [lock],
    })
    if (!created) return null
    const at = { address: lock, abi: LOCK_ABI } as const
    const [
      factory,
      account,
      token,
      minContestWindow,
      confirmWindow,
      rulingDelay,
      rulingKeyEnd,
      day90,
    ] = await Promise.all([
      readContract(client, { ...at, functionName: 'factory' }),
      readContract(client, { ...at, functionName: 'account' }),
      tokenOf(lock),
      readContract(client, { ...at, functionName: 'minContestWindow' }),
      readContract(client, { ...at, functionName: 'confirmWindow' }),
      readContract(client, { ...at, functionName: 'rulingDelay' }),
      readContract(client, { ...at, functionName: 'rulingKeyEnd' }),
      readContract(client, { ...at, functionName: 'day90' }),
    ])
    return {
      fromFactory: isAddressEqual(factory, options.factory),
      account,
      token,
      timing: { minContestWindow, confirmWindow, rulingDelay, rulingKeyEnd, day90 },
    }
  }

  return {
    chainId,
    lock,
    backing: (lock, commitmentId, side) => readBacking(client, lock, commitmentId, side),
    agentKey: (account, key, authorizedIn) => readAgentKey(client, account, key, authorizedIn),
    isAccountSignature: (account, digest, signature) =>
      check({ signer: account, digest, signature }),
    transfer: (transactionHash, logIndex) =>
      readTransfer(client, chainId, transactionHash, logIndex),
  }
}
