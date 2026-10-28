import {
  CHARGE_KINDS,
  type Charge,
  type ChargeKind,
  RAIL_STATES,
  tempoKeychainCheck,
} from '@avow-finance/spec'
import {
  type Address,
  type Client,
  type Hex,
  isAddressEqual,
  parseEventLogs,
  zeroAddress,
} from 'viem'
import { getTransactionReceipt, readContract } from 'viem/actions'
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

const KIND_NAMES = new Map<number, ChargeKind>(
  (Object.entries(CHARGE_KINDS) as [ChargeKind, number][]).map(([name, code]) => [code, name]),
)

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

  async function backing(
    lock: Address,
    commitmentId: Hex,
    side: 'buyer' | 'supplier',
  ): Promise<LockedBacking | null> {
    const [c, token] = await Promise.all([
      readContract(client, {
        address: lock,
        abi: LOCK_ABI,
        functionName: 'commitment',
        args: [commitmentId, side === 'buyer' ? 0 : 1],
      }),
      tokenOf(lock),
    ])
    if (c.state === 0) return null
    const state = RAIL_STATES[c.state]
    if (!state)
      throw new Error(`The lock reports state ${c.state}, which this verifier doesn't read`)
    const charges: Charge[] = []
    for (let k = 0; k < c.most.length; k++) {
      if ((c.kinds & (1 << k)) === 0) continue
      const kind = KIND_NAMES.get(k)
      if (!kind)
        throw new Error(`The lock holds charge kind ${k}, which this verifier doesn't read`)
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

  return {
    chainId,
    lock,
    backing,
    agentKey: (account, key, authorizedIn) => readAgentKey(client, account, key, authorizedIn),
    isAccountSignature: (account, digest, signature) =>
      check({ signer: account, digest, signature }),
  }
}
