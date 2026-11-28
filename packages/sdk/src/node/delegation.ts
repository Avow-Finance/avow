import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { type AgentDelegation, agentDelegation, type WorkerFolders } from '../sandbox/delegation.js'
import { sandboxWorker } from '../sandbox/worker.js'
import { fileStore, SANDBOX_DIR } from './platform.js'
import {
  serveWorkers,
  WORKERS_DIR,
  workerBuyer,
  workerSigner,
  workerSocketPath,
} from './worker-socket.js'

/** The workers' folders under an agent's `.avow` folder, one for each worker by its id. */
export function workerFolders(avowDir: string): WorkerFolders {
  const root = join(avowDir, WORKERS_DIR)
  return {
    store: (id) => fileStore(join(root, id)),
    async ids() {
      const entries = await readdir(root, { withFileTypes: true }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return []
          throw error
        },
      )
      return entries
        .filter((e) => e.isDirectory() && /^[0-9a-f]{12}$/.test(e.name))
        .map((e) => e.name)
    },
  }
}

/**
 * The agent in `dir` as the agent of its workers on this machine: its delegation, with the
 * agent's signer served to its workers on the socket in `.avow`, which only the agent's user can
 * open. The socket closes with `close`.
 */
export async function delegationOnThisMachine(
  dir: string = process.cwd(),
  options: { fetch?: typeof fetch } = {},
): Promise<AgentDelegation & { close(): Promise<void> }> {
  const avowDir = join(dir, SANDBOX_DIR)
  const delegation = await agentDelegation({
    store: fileStore(avowDir),
    workers: workerFolders(avowDir),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })
  const server = await serveWorkers({
    avowDir,
    signer: delegation.signer,
    expected: delegation.where,
  })
  return {
    ...delegation,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/**
 * The worker with this id under the agent in `dir`, booking through the agent's socket on this
 * machine. The agent has to be running `delegationOnThisMachine`, or its MCP server, for the
 * worker's bookings to be signed and funded.
 */
export function sandboxWorkerOnThisMachine(
  id: string,
  dir: string = process.cwd(),
  options: { fetch?: typeof fetch } = {},
) {
  const avowDir = join(dir, SANDBOX_DIR)
  const socketPath = workerSocketPath(avowDir)
  return sandboxWorker({
    store: workerFolders(avowDir).store(id),
    buyer: (key) => workerBuyer(workerSigner({ socketPath, key })),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })
}
