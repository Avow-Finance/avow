/**
 * The side of the SDK an agent runs for the workers it starts, `@avow-finance/sdk/slices`. It hands
 * slices out, narrows and ends them, and signs for a worker only inside its live slice. It acts
 * with the agent's own key, and nothing here opens the business's key, signs a mandate or changes
 * the authority a person gave the agent.
 */

export {
  type AgentDelegation,
  agentDelegation,
  type DelegatedWorker,
  type WorkerFolders,
  type WorkerLimitsAsk,
  workerLimits,
} from './sandbox/delegation.js'
export { type SandboxWorker, sandboxWorker, WorkerBookingRefused } from './sandbox/worker.js'
export { type SliceApi, sliceApi } from './slices/client.js'
export { handOutSlice, narrowSlice, revokeWorker, SliceRefused } from './slices/hand-out.js'
export {
  createParentSigner,
  type ParentKey,
  type ParentSigner,
  type ParentSignerDeps,
} from './slices/parent-signer.js'
export {
  signWorkerRequest,
  type WorkerAnswer,
  type WorkerAsk,
  type WorkerKey,
  type WorkerRequest,
} from './slices/worker-request.js'
