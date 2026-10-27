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
import type { AgentKeyInfo } from './chain.js'

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
  const authorized = logs.some(
    (l) =>
      l.eventName === 'KeyAuthorized' &&
      isAddressEqual(l.args.account, account) &&
      isAddressEqual(l.args.publicKey, key),
  )
  const witnesses = logs.flatMap((l) =>
    l.eventName === 'KeyAuthorizationWitness' && isAddressEqual(l.args.account, account)
      ? [l.args.witness]
      : [],
  )
  return {
    active: !stored.isRevoked,
    expiry: stored.expiry >= NO_EXPIRY ? null : stored.expiry,
    // One authorization per transaction carries one witness. Anything else is ambiguous.
    witness: authorized && witnesses.length === 1 ? (witnesses[0] ?? null) : null,
  }
}
