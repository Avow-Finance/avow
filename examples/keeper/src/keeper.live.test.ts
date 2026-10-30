import { moderatoClient } from '@avow-finance/sdk'
import { ENDINGS } from '@avow-finance/spec'
import { FACTORY_ABI, readBacking } from '@avow-finance/verifier'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { getCode, getTransactionReceipt, readContract } from 'viem/actions'
import { describe, expect, it } from 'vitest'
import { CHECK_STRIDE, keep } from './keeper.js'
import { needsAttention } from './report.js'
import { findLocks, findSides, MODERATO_LOG_LIMITS } from './scan.js'
import { keeperSettings } from './settings.js'
import { explorerOf, tempoKeeperChain } from './tempo.js'
import { workflowEnv } from './test/workflow.js'

/**
 * The keeper against the factory the scheduled workflow serves on Moderato, with the settings read
 * from the workflow itself. It checks the start block and every lock and open side against the
 * chain, then runs the keeper, which sends any step that's due from a key made for the run and
 * funded by the faucet. Nothing is saved. Runs when AVOW_LIVE_TEMPO=1.
 */
const live = process.env.AVOW_LIVE_TEMPO === '1'
const always = () => true

function onModerato() {
  const client = moderatoClient()
  const key = privateKeyToAccount(generatePrivateKey())
  return {
    settings: keeperSettings(workflowEnv()),
    client,
    chain: tempoKeeperChain({ client, key }),
  }
}

describe.skipIf(!live)("the keeper on the workflow's factory, on Moderato", () => {
  it('starts at the block the factory was created in', async () => {
    const { settings, client } = onModerato()
    const { factory, startBlock } = settings
    expect(await getCode(client, { address: factory, blockNumber: startBlock })).toBeDefined()
    expect(
      await getCode(client, { address: factory, blockNumber: startBlock - 1n }),
    ).toBeUndefined()
  }, 60_000)

  it("finds the factory's locks over more than one query, and only the sides their locks hold open", async () => {
    const { settings, client, chain } = onModerato()
    const head = await chain.head()
    const range = { from: settings.startBlock, to: head.number }
    expect(range.to - range.from + 1n).toBeGreaterThan(MODERATO_LOG_LIMITS.blocks)
    const locks = await findLocks(chain, settings.factory, range, MODERATO_LOG_LIMITS, always)
    expect(locks.unread).toEqual([])
    expect(locks.found.length).toBeGreaterThan(0)
    for (const lock of locks.found) {
      const fromFactory = await readContract(client, {
        address: settings.factory,
        abi: FACTORY_ABI,
        functionName: 'isLock',
        args: [lock],
      })
      expect(fromFactory).toBe(true)
    }
    const sides = await findSides(chain, locks.found, range, MODERATO_LOG_LIMITS, always)
    expect(sides.unread).toEqual([])
    for (const side of sides.found.open) {
      const backing = await readBacking(client, side.lock, side.commitmentId, side.side)
      expect(backing).not.toBeNull()
      expect(ENDINGS).not.toContain(backing?.state)
    }
  }, 120_000)

  it('reads everything and lands each step it sends, with the lock acting on that commitment', async () => {
    const { settings, client, chain } = onModerato()
    const explorer = explorerOf(client)
    const lines: string[] = []
    const report = await keep({
      chain,
      factory: settings.factory,
      startBlock: settings.startBlock,
      lookback: settings.lookback,
      limits: MODERATO_LOG_LIMITS,
      explorer,
      log: (line) => {
        lines.push(line)
        console.log(line)
      },
      now: Date.now,
      stopAt: Date.now() + settings.runFor,
      stride: CHECK_STRIDE,
    })
    expect(needsAttention(report)).toBe(false)
    expect(report.scanned).toBe(report.locks)
    for (const result of report.results) {
      if (result.outcome !== 'sent') continue
      // Another step can come due straight after this one, so the check is that this one landed
      // and the lock logged a step for this commitment in it.
      const receipt = await getTransactionReceipt(client, { hash: result.hash })
      expect(receipt.status).toBe('success')
      const fromLock = receipt.logs.filter(
        (log) => log.address.toLowerCase() === result.lock.toLowerCase(),
      )
      expect(fromLock.some((log) => log.topics[1] === result.commitmentId)).toBe(true)
      expect(lines.some((l) => l.endsWith(`${explorer}/tx/${result.hash}`))).toBe(true)
    }
    expect(lines.at(-1)).toMatch(/^checked \d+ of \d+ locks created in blocks /)
  }, 600_000)
})
