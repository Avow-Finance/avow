import type { CommitmentReference } from '@avow-finance/spec'
import {
  firstBlockAt,
  type LockEventSource,
  type LockEventsRead,
  readLockEvents,
  tempoLockEventSource,
} from '@avow-finance/verifier'
import type { Hex } from 'viem'
import { moderatoClient } from '../moderato.js'
import { platformStore, type SandboxAgentOptions } from './agent.js'
import { loadSandboxDeployment } from './deployment.js'
import { SANDBOX_SCREEN_URL } from './session.js'
import { loadCommitments, type SandboxStore } from './store.js'

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

/**
 * Reads what the business's lock logged for one of the commitments made from this machine, from
 * the chain and never from Avow. Without `from`, the read starts a little before the time the
 * commitment was made, and `next` in the answer says where to carry on when the read stopped short
 * of the final block. Each event is a notice of what the lock logged. It grants nothing, and
 * Avow's own records, such as its approval, aren't in it.
 */
export async function readCommitmentEvents(
  source: LockEventSource,
  store: SandboxStore,
  commitmentId: Hex,
  from?: bigint,
): Promise<SandboxCommitmentEvents> {
  const stored = (await loadCommitments(store)).find(
    (c) => c.reference.commitmentId.toLowerCase() === commitmentId.toLowerCase(),
  )
  if (!stored) throw new UnknownCommitment(commitmentId)
  const start = from ?? (await firstBlockAt(source, stored.madeAt - START_MARGIN))
  const read = await readLockEvents(source, {
    lock: stored.reference.lock,
    commitmentId: stored.reference.commitmentId,
    from: start,
  })
  return { reference: stored.reference, ...read }
}

/**
 * Reads what the business's lock logged for one of the commitments made from this machine, from
 * the sandbox's chain. It needs the agent's folder for its list of commitments and nothing else:
 * no key is opened, nothing is signed and Avow is never asked.
 */
export async function sandboxCommitmentEvents(
  commitmentId: Hex,
  options: Pick<SandboxAgentOptions, 'fetch' | 'store' | 'screenUrl' | 'deployment'> & {
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
  const send = options.fetch ?? ((input, init) => fetch(input, init))
  const deployment =
    options.deployment ??
    (await loadSandboxDeployment(options.screenUrl ?? SANDBOX_SCREEN_URL, send))
  const source = tempoLockEventSource(moderatoClient(deployment.rpcUrl), deployment.chainId)
  return readCommitmentEvents(source, store, commitmentId, options.from)
}
