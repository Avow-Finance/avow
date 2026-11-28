import { chmod, lstat, mkdir, rm } from 'node:fs/promises'
import { connect, createServer, type Server } from 'node:net'
import { join } from 'node:path'
import { type ReasonCode, toWire } from '@avow-finance/spec'
import type { Address, Hex } from 'viem'
import type { AgentBuyer } from '../agent.js'
import type { ParentSigner } from '../slices/parent-signer.js'
import {
  signWorkerRequest,
  type WorkerAnswer,
  type WorkerAsk,
  type WorkerKey,
} from '../slices/worker-request.js'
import { parseWorkerAnswer, parseWorkerRequest } from '../slices/worker-wire.js'

/** The folder in `.avow` that holds the agent's socket, which only its own user can enter. */
export const WORKERS_DIR = 'workers'
/** The agent's socket, which only its own user can open. */
export const WORKER_SOCKET = 'signer.sock'
/** The longest line a worker may send, in bytes. A request is far smaller. */
const MAX_LINE = 256 * 1024

/** Where the agent's socket sits under a `.avow` folder. */
export const workerSocketPath = (avowDir: string) => join(avowDir, WORKERS_DIR, WORKER_SOCKET)

/**
 * Serves the agent's signer to its own workers on this machine, on a socket in `.avow` that only
 * the agent's user can reach: the folder is the user's alone and the socket is readable and
 * writable by the user only. A worker on another machine can't reach it, and needs a mandate of
 * its own. Each line is one request a worker's key signed, and the signer checks it against the
 * worker's live slice before it signs anything with the agent's key, which never crosses the
 * socket.
 */
export async function serveWorkers(a: {
  avowDir: string
  signer: ParentSigner
  expected: { chainId: number; lock: Address }
}): Promise<Server> {
  const dir = join(a.avowDir, WORKERS_DIR)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700)
  const path = join(dir, WORKER_SOCKET)
  const stale = await lstat(path).catch(() => null)
  if (stale) {
    if (!stale.isSocket()) throw new Error(`${path} exists and is not a socket`)
    await rm(path)
  }
  const server = createServer((socket) => {
    let buffer = ''
    let queue = Promise.resolve()
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      buffer += chunk
      if (buffer.length > MAX_LINE) {
        socket.end(`${JSON.stringify({ ok: false, reason: 'request.invalid' })}\n`)
        return
      }
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const line = buffer.slice(0, at)
        buffer = buffer.slice(at + 1)
        queue = queue.then(async () => {
          const answer = await answerLine(line, a)
          if (!socket.destroyed) socket.write(`${JSON.stringify(toWire(answer))}\n`)
        })
      }
    })
    socket.on('error', () => socket.destroy())
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => resolve())
  })
  await chmod(path, 0o600)
  return server
}

async function answerLine(
  line: string,
  a: { signer: ParentSigner; expected: { chainId: number; lock: Address } },
): Promise<WorkerAnswer> {
  let json: unknown
  try {
    json = JSON.parse(line)
  } catch {
    return { ok: false, reason: 'request.invalid' }
  }
  const read = parseWorkerRequest(json, a.expected)
  if (!read.ok) return { ok: false, reason: read.reason }
  try {
    return await a.signer.handle(read.value)
  } catch {
    // A failure to read Avow or the chain, or to send, signs nothing, and the worker can ask again.
    return { ok: false, reason: 'request.invalid' }
  }
}

/** Sends one signed request to the agent's socket and reads its answer. */
async function ask(path: string, request: unknown): Promise<WorkerAnswer> {
  return new Promise((resolve, reject) => {
    const socket = connect(path)
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(`${JSON.stringify(toWire(request))}\n`))
    socket.on('data', (chunk: string) => {
      buffer += chunk
      const at = buffer.indexOf('\n')
      if (at < 0) return
      socket.end()
      let json: unknown
      try {
        json = JSON.parse(buffer.slice(0, at))
      } catch {
        json = null
      }
      const answer = parseWorkerAnswer(json)
      if (answer) resolve(answer)
      else reject(new Error("The agent's answer wasn't one a worker reads"))
    })
    socket.on('error', reject)
  })
}

/**
 * What a worker on the agent's machine asks of the agent: its side of an agreement and the funding
 * of a reserve, each signed by the worker's own key. A refusal throws a `WorkerRefused` with the
 * agent's reason code.
 */
export function workerSigner(a: { socketPath: string; key: WorkerKey; now?: () => bigint }) {
  const now = a.now ?? (() => BigInt(Math.floor(Date.now() / 1000)))
  const send = async (askFor: WorkerAsk) =>
    ask(a.socketPath, await signWorkerRequest(askFor, a.key, now()))
  return {
    async signAgreement(
      askFor: Omit<Extract<WorkerAsk, { kind: 'agreement' }>, 'kind'>,
    ): Promise<`0x${string}`> {
      const answer = await send({ kind: 'agreement', ...askFor })
      if (!answer.ok) throw new WorkerRefused(answer.reason)
      if (answer.kind !== 'agreement') throw new WorkerRefused('request.invalid')
      return answer.buyerSignature
    },
    async fund(
      approval: Extract<WorkerAsk, { kind: 'fund' }>['approval'],
    ): Promise<{ transactionHash: Hex | null; blockNumber: bigint | null }> {
      const answer = await send({ kind: 'fund', approval })
      if (!answer.ok) throw new WorkerRefused(answer.reason)
      if (answer.kind !== 'fund') throw new WorkerRefused('request.invalid')
      return { transactionHash: answer.transactionHash, blockNumber: answer.blockNumber }
    },
  }
}

/** The agent refused what its worker asked, for the reason code it gives. */
export class WorkerRefused extends Error {
  readonly code: string
  constructor(code: string) {
    super(`The agent refused its worker's request (${code})`)
    this.name = 'WorkerRefused'
    this.code = code
  }
}

/**
 * A worker's side of the socket as `createAgent` takes it, so a worker books with the same calls
 * an agent does. A refusal comes back with the agent's reason. A funding whose answer never came
 * may have been sent, so `createAgent` reads the lock for it.
 */
export function workerBuyer(signer: ReturnType<typeof workerSigner>): AgentBuyer {
  return {
    async signAgreement(a) {
      try {
        return { ok: true, signature: await signer.signAgreement(a) }
      } catch (error) {
        if (error instanceof WorkerRefused) return { ok: false, reason: error.code as ReasonCode }
        throw error
      }
    },
    async fund(approval) {
      try {
        return { ok: true, ...(await signer.fund(approval)) }
      } catch (error) {
        if (error instanceof WorkerRefused) {
          // The agent answers `service.unavailable` only once it sent and couldn't tell the outcome.
          return {
            ok: false,
            reason: error.code as ReasonCode,
            sent: error.code === 'service.unavailable',
          }
        }
        // A socket nobody answers took no request. Any other failure may have come after it did.
        const code = (error as NodeJS.ErrnoException).code
        const unreached = code === 'ECONNREFUSED' || code === 'ENOENT'
        return { ok: false, reason: 'service.unavailable', sent: !unreached }
      }
    },
  }
}
