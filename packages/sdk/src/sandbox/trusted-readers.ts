import {
  type ChainReader,
  type PinnedLockReader,
  tempoChainReader,
  tempoLockReader,
} from '@avow-finance/verifier'
import type { Address, Client } from 'viem'
import { trustedFactoryAddresses } from './deployment.js'

/**
 * A chain reader that counts a lock as Avow's when any factory the SDK trusts on the chain made
 * it, or null on a chain where it trusts none. A deployment names one factory, and a lock from an
 * earlier trusted factory still reads through this.
 */
export function trustedChainReader(client: Client, chainId: number): ChainReader | null {
  const factories = trustedFactoryAddresses(chainId)
  return factories.length > 0 ? tempoChainReader(client, { factory: factories, chainId }) : null
}

/**
 * One pinned lock reader for each of these factories, as the dependency check takes them, so an
 * upstream booking in a lock from any of them can be read.
 */
export function lockReadersFor(
  client: Client,
  chainId: number,
  factories: readonly Address[],
): PinnedLockReader[] {
  return factories.map((factory) => tempoLockReader(client, { factory, chainId }))
}

/**
 * One pinned lock reader for each factory the SDK trusts on the chain. None on a chain where it
 * trusts none, so the check refuses.
 */
export function trustedLockReaders(client: Client, chainId: number): PinnedLockReader[] {
  return lockReadersFor(client, chainId, trustedFactoryAddresses(chainId))
}
