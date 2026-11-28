import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { connect, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ParentSigner } from '../slices/parent-signer.js'
import { isWorkerRequestSigned, type WorkerRequest } from '../slices/worker-request.js'
import { CHAIN_ID, id, LOCK } from '../test/fixture.js'
import {
  serveWorkers,
  WORKER_SOCKET,
  WORKERS_DIR,
  WorkerRefused,
  workerBuyer,
  workerSigner,
  workerSocketPath,
} from './worker-socket.js'

let dir: string
let server: Server | null
const handled: WorkerRequest[] = []
const worker = privateKeyToAccount(generatePrivateKey())

/** A signer that answers as the agent's would, recording what it was asked. */
const signer: ParentSigner = {
  async handle(r) {
    handled.push(r)
    if (!isWorkerRequestSigned(r)) return { ok: false, reason: 'message.signature_invalid' }
    return r.ask.kind === 'fund'
      ? { ok: true, kind: 'fund', transactionHash: id('tx'), blockNumber: 9n }
      : { ok: false, reason: 'mandate.over_commitment_cap' }
  },
}

const approval = {
  type: 'Approval' as const,
  schemaVersion: '1',
  chainId: CHAIN_ID,
  lock: LOCK,
  message: {
    commitmentId: id('c'),
    side: 'buyer' as const,
    token: '0x20c0000000000000000000000000000000000001' as const,
    amount: 1n,
    supplier: '0x0000000000000000000000000000000000000001' as const,
    supplierSigner: '0x0000000000000000000000000000000000000002' as const,
    payee: '0x0000000000000000000000000000000000000003' as const,
    freeCancelBy: 1n,
    acceptBy: 2n,
    chargeDeadline: 3n,
    releaseDate: 4n,
    contestWindow: 5n,
    charges: [{ kind: 'noShow' as const, most: 1n, earliest: 1n }],
    day90SupplierShareBps: 5000,
    arbiter: '0x0000000000000000000000000000000000000004' as const,
    termsHash: id('t'),
    mandateHash: id('m'),
    capPerCommitment: 1n,
    capOpenReserves: 1n,
    fundingKey: '0x0000000000000000000000000000000000000005' as const,
    nonce: 1n,
    expiry: 9n,
  },
  signature: `0x${'11'.repeat(65)}` as const,
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'a45-avow-'))
  handled.length = 0
  server = await serveWorkers({ avowDir: dir, signer, expected: { chainId: CHAIN_ID, lock: LOCK } })
})

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = null
  await rm(dir, { recursive: true, force: true })
})

describe("the agent's socket for its workers", () => {
  it("sits in a folder only the agent's user can enter, and only that user can open it", async () => {
    expect((await stat(join(dir, WORKERS_DIR))).mode & 0o777).toBe(0o700)
    const socket = await stat(workerSocketPath(dir))
    expect(socket.isSocket()).toBe(true)
    expect(socket.mode & 0o777).toBe(0o600)
  })

  it("carries a worker's signed request to the agent's signer and its answer back", async () => {
    const w = workerSigner({ socketPath: workerSocketPath(dir), key: worker })
    expect(await w.fund(approval)).toEqual({ transactionHash: id('tx'), blockNumber: 9n })
    expect(handled).toHaveLength(1)
    expect(handled[0]?.subKey).toBe(worker.address)
    expect(isWorkerRequestSigned(handled[0] as WorkerRequest)).toBe(true)
  })

  it("throws the agent's refusal with its reason code", async () => {
    const w = workerSigner({ socketPath: workerSocketPath(dir), key: worker })
    const refused = w.signAgreement({
      agreement: {
        commitmentId: id('c'),
        termsHash: id('t'),
        category: 'compute',
        buyerBusinessId: 'biz_buyer',
        supplierBusinessId: 'biz_supplier',
        mandateHash: id('m'),
        nonce: 1n,
        expiry: 9n,
      },
      request: {
        commitmentId: id('c'),
        agentKey: worker.address,
        supplier: 'biz_supplier',
        payee: worker.address,
        category: 'compute',
        terms: {} as never,
      },
      salt: id('salt'),
    })
    // Terms that don't parse never reach the signer.
    await expect(refused).rejects.toThrow(WorkerRefused)
    expect(handled).toHaveLength(0)
  })

  it('answers a line that is no request with a refusal, and signs nothing', async () => {
    const answer = await new Promise<string>((resolve, reject) => {
      const s = connect(workerSocketPath(dir))
      let got = ''
      s.setEncoding('utf8')
      s.on('connect', () => s.write('{"not":"a request"}\n'))
      s.on('data', (c: string) => {
        got += c
        if (got.includes('\n')) {
          s.end()
          resolve(got.trim())
        }
      })
      s.on('error', reject)
    })
    expect(JSON.parse(answer)).toEqual({ ok: false, reason: 'request.invalid' })
    expect(handled).toHaveLength(0)
  })

  it('replaces a socket a stopped agent left, and refuses to replace anything else', async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    server = await serveWorkers({
      avowDir: dir,
      signer,
      expected: { chainId: CHAIN_ID, lock: LOCK },
    })
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    server = null
    await rm(workerSocketPath(dir), { force: true })
    await writeFile(join(dir, WORKERS_DIR, WORKER_SOCKET), 'not a socket')
    await expect(
      serveWorkers({ avowDir: dir, signer, expected: { chainId: CHAIN_ID, lock: LOCK } }),
    ).rejects.toThrow('not a socket')
  })
})

describe("a worker's buyer over the socket", () => {
  it("hands createAgent the agent's funding, and its refusal of an agreement as a reason", async () => {
    const buyer = workerBuyer(workerSigner({ socketPath: workerSocketPath(dir), key: worker }))
    expect(await buyer.fund(approval)).toEqual({
      ok: true,
      transactionHash: id('tx'),
      blockNumber: 9n,
    })
    const refused = await buyer.signAgreement({
      agreement: {
        commitmentId: id('c'),
        termsHash: id('t'),
        category: 'compute',
        buyerBusinessId: 'biz_buyer',
        supplierBusinessId: 'biz_supplier',
        mandateHash: id('m'),
        nonce: 1n,
        expiry: 9n,
      },
      request: {
        commitmentId: id('c'),
        agentKey: worker.address,
        supplier: 'biz_supplier',
        payee: worker.address,
        category: 'compute',
        terms: {} as never,
      },
      salt: id('salt'),
    })
    expect(refused).toEqual({ ok: false, reason: 'request.invalid' })
  })

  it('says nothing was sent when no agent answers the socket', async () => {
    const buyer = workerBuyer(workerSigner({ socketPath: join(dir, 'nobody.sock'), key: worker }))
    expect(await buyer.fund(approval)).toEqual({
      ok: false,
      reason: 'service.unavailable',
      sent: false,
    })
  })
})
