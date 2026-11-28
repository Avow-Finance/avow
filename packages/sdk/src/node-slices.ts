/**
 * The slices side of the SDK as Node loads it, with the agent's socket for its workers on the same
 * machine and the workers' side of it.
 */

export {
  delegationOnThisMachine,
  sandboxWorkerOnThisMachine,
  workerFolders,
} from './node/delegation.js'
export {
  serveWorkers,
  WorkerRefused,
  workerBuyer,
  workerSigner,
  workerSocketPath,
} from './node/worker-socket.js'
export * from './slices-entry.js'
