import type { CommitmentReference } from '@avow-finance/spec'
import {
  type ChainReader,
  firstBlockAt,
  type LockEventSource,
  type LockEventsRead,
  readLockEvents,
  tempoLockEventSource,
} from '@avow-finance/verifier'
import type { Hex } from 'viem'
import { moderatoClient } from '../moderato.js'
import { platformStore } from './agent.js'
import { loadCommitments, type SandboxStore } from './store.js'
import { trustedChainReader } from './trusted-readers.js'

/**
 * How long before the time the SDK recorded a commitment a read starts, in seconds, since the
 * reserve lands in a block whose time can sit a little before the moment this machine noted it.
 */
const START_MARGIN = 300n

/** What a read of one commitment's events found, and where the next read starts. */
export interface SandboxCommitmentEvents extends LockEventsRead {
  reference: CommitmentReference
}

/** The commitment is none the business's agents made from this machine. */
export class UnknownCommitment extends Error {
  constructor(commitmentId: Hex) {
    super(`No commitment ${commitmentId} was made from this machine. List them with commitments.`)
    this.name = 'UnknownCommitment'
  }
}

/** The commitment's lock is on a chain this SDK trusts no factory on, or no trusted factory made it. */
export class UntrustedLock extends Error {
  constructor(reference: CommitmentReference) {
    super(
      `The lock ${reference.lock} on chain ${reference.chainId} isn't one a factory this SDK trusts made, so its logs aren't read.`,
    )
    this.name = 'UntrustedLock'
  }
}

/** What a read reaches the chain through, for one chain id, or null on a chain the SDK trusts none on. */
export interface EventChain {
  source: LockEventSource
  reader: Pick<ChainReader, 'lock'>
}

/**
 * The chain as this SDK reaches it on its own: Moderato's public RPC, under the chain id the
 * commitment names, with the factories the SDK ships with. Nothing comes from a file Avow serves.
 */
export function trustedEventChain(chainId: number): EventChain | null {
  const client = moderatoClient()
  const reader = trustedChainReader(client, chainId)
  return reader && { source: tempoLockEventSource(client, chainId), reader }
}

/**
 * Reads what the business's lock logged for one of the commitments made from this machine, from
 * the chain and never from Avow. The lock has to be one a factory the SDK trusts made. Without
 * `from`, the read starts a little before the time the commitment was made, and `next` in the
 * answer says where to carry on when the read stopped short of the final block. Each event is a
 * notice of what the lock logged. It grants nothing, and Avow's own records aren't in it.
 */
export async function readCommitmentEvents(
  chainFor: (chainId: number) => EventChain | null,
  store: SandboxStore,
  commitmentId: Hex,
  from?: bigint,
): Promise<SandboxCommitmentEvents> {
  const stored = (await loadCommitments(store)).find(
    (c) => c.reference.commitmentId.toLowerCase() === commitmentId.toLowerCase(),
  )
  if (!stored) throw new UnknownCommitment(commitmentId)
  const { reference } = stored
  const chain = chainFor(reference.chainId)
  if (!chain || !(await chain.reader.lock(reference.lock))?.fromFactory) {
    throw new UntrustedLock(reference)
  }
  const start = from ?? (await firstBlockAt(chain.source, stored.madeAt - START_MARGIN))
  const read = await readLockEvents(chain.source, {
    lock: reference.lock,
    commitmentId: reference.commitmentId,
    from: start,
  })
  return { reference, ...read }
}

/**
 * Reads what the business's lock logged for one of the commitments made from this machine. It
 * needs the agent's folder for its list of commitments and nothing else: no key is opened, nothing
 * is signed, and neither Avow nor a file it serves is read.
 */
export async function sandboxCommitmentEvents(
  commitmentId: Hex,
  options: {
    store?: SandboxStore
    /** The block to read from, as `next` gave it, or a little before the commitment was made. */
    from?: bigint
  } = {},
): Promise<SandboxCommitmentEvents> {
  const store = options.store ?? platformStore()
  if (!store) {
    throw new Error(
      'Reading events needs the folder the agent works in. In Node that is the .avow folder, and anywhere else pass a store.',
    )
  }
  return readCommitmentEvents(trustedEventChain, store, commitmentId, options.from)
}
