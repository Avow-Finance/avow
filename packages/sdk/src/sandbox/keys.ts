import { type Address, encodeFunctionData, getAddress, parseAbiItem, zeroAddress } from 'viem'
import { Abis, type Account, Addresses } from 'viem/tempo'
import { ADMINISTRATOR_ABI, type Call } from '../lock.js'
import { sendOwn } from '../send.js'
import type { SandboxClient } from './business.js'

/** The widest block range one log query takes on Moderato's public node, with room to spare. */
const STEP = 90_000n

const KEY_AUTHORIZED = parseAbiItem(
  'event KeyAuthorized(address indexed account, address indexed publicKey, uint8 signatureType, uint64 expiry)',
)
const SUPPLIER_APPROVED = parseAbiItem('event SupplierApproved(address indexed supplier)')

/** Every log a filter matches from `fromBlock` to the latest block, a range at a time. */
async function logsSince<T>(
  client: SandboxClient,
  fromBlock: bigint,
  read: (range: { fromBlock: bigint; toBlock: bigint }) => Promise<T[]>,
): Promise<T[]> {
  const latest = await client.getBlockNumber()
  const found: T[] = []
  for (let from = fromBlock; from <= latest; from += STEP) {
    const to = from + STEP - 1n < latest ? from + STEP - 1n : latest
    found.push(...(await read({ fromBlock: from, toBlock: to })))
  }
  return found
}

/**
 * Every access key the account's keychain still lets sign for the account, read from the chain:
 * each key authorized since `fromBlock` that isn't revoked or expired. Nothing the agent can write
 * decides this list.
 */
export async function liveAgentKeys(
  client: SandboxClient,
  account: Address,
  fromBlock: bigint,
): Promise<Address[]> {
  const logs = await logsSince(client, fromBlock, (range) =>
    client.getLogs({
      address: Addresses.accountKeychain as Address,
      event: KEY_AUTHORIZED,
      args: { account },
      ...range,
    }),
  )
  const keys = [
    ...new Set(logs.flatMap((l) => (l.args.publicKey ? [getAddress(l.args.publicKey)] : []))),
  ]
  const now = BigInt(Math.floor(Date.now() / 1000))
  const live: Address[] = []
  for (const key of keys) {
    const k = await client.readContract({
      address: Addresses.accountKeychain as Address,
      abi: Abis.accountKeychain,
      functionName: 'getKey',
      args: [account, key],
    })
    if (!k.isRevoked && k.keyId !== zeroAddress && (k.expiry === 0n || k.expiry > now))
      live.push(key)
  }
  return live
}

/** Every supplier the lock approves now, read from the lock's own events and its state. */
export async function approvedSuppliers(
  client: SandboxClient,
  lock: Address,
  fromBlock: bigint,
): Promise<Address[]> {
  const logs = await logsSince(client, fromBlock, (range) =>
    client.getLogs({ address: lock, event: SUPPLIER_APPROVED, ...range }),
  )
  const candidates = [
    ...new Set(logs.flatMap((l) => (l.args.supplier ? [getAddress(l.args.supplier)] : []))),
  ]
  const approved: Address[] = []
  for (const supplier of candidates) {
    const still = await client.readContract({
      address: lock,
      abi: ADMINISTRATOR_ABI,
      functionName: 'approvedSupplier',
      args: [supplier],
    })
    if (still) approved.push(supplier)
  }
  return approved
}

/** The calls that revoke each key in the account's keychain, which only the root key can send. */
export const revokeKeyCalls = (keys: readonly Address[]): Call[] =>
  keys.map((key) => ({
    to: Addresses.accountKeychain as Address,
    data: encodeFunctionData({ abi: Abis.accountKeychain, functionName: 'revokeKey', args: [key] }),
  }))

/**
 * Revokes every agent key the account's keychain still authorizes, apart from `keep`, in a
 * transaction of its own from the root key. It reads the keys from the chain since `fromBlock`, so
 * a file the agent changed or deleted can't keep one live. It gives the keys it revoked.
 */
export async function revokeOtherAgentKeys(m: {
  client: SandboxClient
  root: Account.RootAccount
  fromBlock: bigint
  keep?: readonly Address[]
}): Promise<Address[]> {
  const keep = (m.keep ?? []).map((k) => k.toLowerCase())
  const live = (await liveAgentKeys(m.client, m.root.address, m.fromBlock)).filter(
    (k) => !keep.includes(k.toLowerCase()),
  )
  if (live.length > 0) {
    await sendOwn({ client: m.client, account: m.root, calls: revokeKeyCalls(live) })
  }
  return live
}
