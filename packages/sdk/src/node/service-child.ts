import { readFileSync } from 'node:fs'
import { toWire } from '@avow-finance/spec'
import { readBacking, tempoLockReader } from '@avow-finance/verifier'
import { createPublicClient, http } from 'viem'
import { decodeData } from '../session/data.js'
import { isService, type ReservedJob } from '../session/service.js'
import { type CommitmentChain, serviceChecks, snapshotChain } from '../session/service-check.js'
import type { ChildChain } from '../session/world.js'

/**
 * What runs in the developer's service process, which holds no key. It loads `service.ts`, then
 * either writes its budget and switch, or runs `checkBeforeWork` on the job it was handed, with
 * checks that read the chain and nothing else, and writes the verdict. Each answer is one line of
 * JSON on its output.
 */

const systemClock = () => BigInt(Math.floor(Date.now() / 1000))

/** The chain the checks read: Tempo's RPC for a live run, or what the fixture world handed over. */
function chainOf(chain: ChildChain): CommitmentChain {
  if (chain.kind === 'snapshot') return snapshotChain(chain.snapshot)
  const client = createPublicClient({ transport: http(chain.url) })
  return {
    readers: [tempoLockReader(client, { factory: chain.factory, chainId: chain.chainId })],
    backing: (lock, commitmentId, side, at) =>
      readBacking(client, lock, commitmentId, side, { blockNumber: at }),
  }
}

export async function runServiceChild(serviceUrl: string, inputPath: string): Promise<void> {
  const input = decodeData(readFileSync(inputPath, 'utf8')) as
    | { mode: 'policy' }
    | { mode: 'check'; job: ReservedJob; chain: ChildChain }
  const loaded = (await import(serviceUrl)) as { default?: unknown }
  const service = loaded.default
  if (!isService(service)) {
    throw new Error(
      'service.ts has to export the service defineService makes as its default export',
    )
  }
  if (input.mode === 'policy') {
    const { budgetPerGpuHour, computeSwitch } = service.policy
    process.stdout.write(
      `${JSON.stringify({ budgetPerGpuHour: budgetPerGpuHour.toString(), computeSwitch })}\n`,
    )
    return
  }
  const verdict = await service.checkBeforeWork(
    input.job,
    serviceChecks(chainOf(input.chain), systemClock),
  )
  process.stdout.write(`${JSON.stringify(toWire(verdict))}\n`)
}
