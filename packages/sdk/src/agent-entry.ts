/**
 * The agent's side of the SDK, `@avow-finance/sdk/agent`, which is all an agent's code needs. It
 * acts with the agent's own key under the mandate its business signed. Nothing here opens the
 * business's key, signs a mandate, enrolls a key or changes the authority, and the runner starts
 * the agent's process with only the agent's key.
 */
import { sandboxAgent } from './sandbox/agent.js'

export {
  Refusal,
  type SandboxAgent,
  type SandboxAgentOptions,
  type SandboxBooking,
  type SandboxCheck,
  type SandboxCommitment,
  type SandboxCommitmentRecord,
  type SandboxSession,
} from './sandbox/agent.js'
export type { SandboxStore, SandboxSupplier } from './sandbox/store.js'
export type { SandboxResource } from './sandbox/terms.js'

/** The sandbox as an agent sees it. */
export const sandbox = { agent: sandboxAgent } as const
