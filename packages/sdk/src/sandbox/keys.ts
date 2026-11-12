import {
  type Address,
  encodeFunctionData,
  getAddress,
  isAddressEqual,
  parseAbiItem,
  zeroAddress,
} from 'viem'
import { Abis, type Account, Addresses } from 'viem/tempo'
import { ADMINISTRATOR_ABI, type Call } from '../lock.js'
import { MODERATO_FACTORY_CREATED_IN } from '../moderato.js'
import { sendOwn } from '../send.js'
import type { SandboxClient } from './fees.js'

/** The widest block range one log query takes on Moderato's public node, with room to spare. */
const STEP = 90_000n

const KEYCHAIN = Addresses.accountKeychain as Address
const KEY_AUTHORIZED = parseAbiItem(
  'event KeyAuthorized(address indexed account, address indexed publicKey, uint8 signatureType, uint64 expiry)',
)
const ADMIN_KEY_AUTHORIZED = parseAbiItem(
  'event AdminKeyAuthorized(address indexed account, address indexed publicKey)',
)
const LOCK_CREATED = parseAbiItem('event LockCreated(address indexed account, address lock)')
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
 * The block the factory created the business's lock in, read from the factory's own event. Every
 * key the business authorized came after it, and nothing on this machine can move it. It reads
 * back from the latest block, since a sandbox business is usually days old, and stops at the block
 * the factory itself was created in.
 */
export async function lockCreatedIn(m: {
  client: SandboxClient
  factory: Address
  account: Address
  lock: Address
  /** The block the factory was created in. */
  factoryCreatedIn?: bigint
}): Promise<bigint> {
  const floor = m.factoryCreatedIn ?? MODERATO_FACTORY_CREATED_IN
  for (let to = await m.client.getBlockNumber(); to >= floor; to -= STEP) {
    const from = to - STEP + 1n > floor ? to - STEP + 1n : floor
    const logs = await m.client.getLogs({
      address: m.factory,
      event: LOCK_CREATED,
      args: { account: m.account },
      fromBlock: from,
      toBlock: to,
    })
    const created = logs.find((l) => l.args.lock && isAddressEqual(l.args.lock, m.lock))
    if (created && created.blockNumber !== null) return created.blockNumber
  }
  throw new Error(`The factory at ${m.factory} never created the business's lock at ${m.lock}`)
}

/**
 * Every key the account's keychain still lets sign for the account, read from the chain: each
 * access key and each admin key authorized since `fromBlock` that isn't revoked or expired. The
 * account's root key isn't in the keychain, so it's never among them. Nothing the agent can write
 * decides this list.
 */
export async function liveKeys(
  client: SandboxClient,
  account: Address,
  fromBlock: bigint,
): Promise<Address[]> {
  const logs = await logsSince(client, fromBlock, async (range) => [
    ...(await client.getLogs({
      address: KEYCHAIN,
      event: KEY_AUTHORIZED,
      args: { account },
      ...range,
    })),
    ...(await client.getLogs({
      address: KEYCHAIN,
      event: ADMIN_KEY_AUTHORIZED,
      args: { account },
      ...range,
    })),
  ])
  const keys = [
    ...new Set(logs.flatMap((l) => (l.args.publicKey ? [getAddress(l.args.publicKey)] : []))),
  ].filter((key) => !isAddressEqual(key, account))
  const now = BigInt(Math.floor(Date.now() / 1000))
  const live: Address[] = []
  for (const key of keys) {
    const k = await client.readContract({
      address: KEYCHAIN,
      abi: Abis.accountKeychain,
      functionName: 'getKey',
      args: [account, key],
    })
    const access = !k.isRevoked && k.keyId !== zeroAddress && (k.expiry === 0n || k.expiry > now)
    const admin = await client.readContract({
      address: KEYCHAIN,
      abi: Abis.accountKeychain,
      functionName: 'isAdminKey',
      args: [account, key],
    })
    if (access || admin) live.push(key)
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

/**
 * The calls that revoke each key in the account's keychain, access or admin, which only the root
 * key can send.
 */
export const revokeKeyCalls = (keys: readonly Address[]): Call[] =>
  keys.map((key) => ({
    to: KEYCHAIN,
    data: encodeFunctionData({ abi: Abis.accountKeychain, functionName: 'revokeKey', args: [key] }),
  }))

/**
 * Revokes every key the account's keychain still authorizes, access or admin, apart from `keep`, in
 * a transaction of its own from the root key. It reads the keys from the chain since `since`, which
 * the caller takes from the chain too, so no file the agent changed or deleted can keep one live.
 * It gives the keys it revoked.
 */
export async function revokeOtherKeys(m: {
  client: SandboxClient
  root: Account.RootAccount
  since: bigint
  keep?: readonly Address[]
}): Promise<Address[]> {
  const keep = m.keep ?? []
  const live = (await liveKeys(m.client, m.root.address, m.since)).filter(
    (k) => !keep.some((kept) => isAddressEqual(kept, k)),
  )
  if (live.length > 0) {
    await sendOwn({ client: m.client, account: m.root, calls: revokeKeyCalls(live) })
  }
  return live
}
