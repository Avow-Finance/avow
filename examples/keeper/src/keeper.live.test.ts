import { readFileSync } from 'node:fs'
import { moderatoClient } from '@avow-finance/sdk'
import { ENDINGS } from '@avow-finance/spec'
import { FACTORY_ABI, readBacking } from '@avow-finance/verifier'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { getCode, getTransactionReceipt, readContract } from 'viem/actions'
import { describe, expect, it } from 'vitest'
import { keep } from './keeper.js'
import { needsAttention } from './report.js'
import { findLocks, findSides, MODERATO_LOG_LIMITS } from './scan.js'
import { keeperSettings } from './settings.js'
import { explorerOf, tempoKeeperChain } from './tempo.js'

/**
 * The keeper against the factory the scheduled workflow serves on Moderato, with the settings read
 * from the workflow itself. It checks the start block and every lock and open side against the
 * chain, then runs the keeper, which sends any step that's due from a key made for the run and
 * funded by the faucet. Nothing is saved. Runs when AVOW_LIVE_TEMPO=1.
 */
const live = process.env.AVOW_LIVE_TEMPO === '1'

/** The factory and start block the scheduled workflow runs the keeper with. */
function workflowSettings() {
  const workflow = readFileSync(
    new URL('../../../.github/workflows/keeper.yml', import.meta.url),
    'utf8',
  )
  const env = Object.fromEntries(
    [
      ...workflow.matchAll(/^\s*(AVOW_FACTORY|AVOW_FACTORY_START_BLOCK):\s*"?([^"\s]+)"?\s*$/gm),
    ].map((m) => [m[1], m[2]]),
  )
  return keeperSettings(env)
}

function onModerato() {
  const client = moderatoClient()
  const key = privateKeyToAccount(generatePrivateKey())
  return { settings: workflowSettings(), client, chain: tempoKeeperChain({ client, key }) }
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
    const locks = await findLocks(chain, settings.factory, range, MODERATO_LOG_LIMITS)
    expect(locks.length).toBeGreaterThan(0)
    for (const lock of locks) {
      const fromFactory = await readContract(client, {
        address: settings.factory,
        abi: FACTORY_ABI,
        functionName: 'isLock',
        args: [lock],
      })
      expect(fromFactory).toBe(true)
    }
    const sides = await findSides(chain, locks, range, MODERATO_LOG_LIMITS)
    for (const side of sides.open) {
      const backing = await readBacking(client, side.lock, side.commitmentId, side.side)
      expect(backing).not.toBeNull()
      expect(ENDINGS).not.toContain(backing?.state)
    }
  }, 120_000)

  it('sends every step that is due, each landing and leaving nothing due', async () => {
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
    })
    expect(needsAttention(report)).toBe(false)
    for (const result of report.results) {
      if (result.outcome !== 'sent') continue
      const receipt = await getTransactionReceipt(client, { hash: result.hash })
      expect(receipt.status).toBe('success')
      expect(await chain.isDue(result)).toBe(false)
      expect(lines.some((l) => l.endsWith(`${explorer}/tx/${result.hash}`))).toBe(true)
    }
    expect(lines.at(-1)).toMatch(/^checked \d+ locks created in blocks /)
  }, 300_000)
})
