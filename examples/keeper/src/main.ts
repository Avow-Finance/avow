#!/usr/bin/env node
import { moderatoClient } from '@avow-finance/sdk'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { keep } from './keeper.js'
import { needsAttention, reasonOf } from './report.js'
import { MODERATO_LOG_LIMITS } from './scan.js'
import { keeperSettings } from './settings.js'
import { explorerOf, tempoKeeperChain } from './tempo.js'

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`)

/**
 * One run against Moderato. It exits with status 1 when a step failed, a transaction's outcome is
 * unknown or a side couldn't be checked, so a scheduled run shows what needs a look.
 */
async function main() {
  const settings = keeperSettings(process.env)
  const client = moderatoClient(settings.rpcUrl)
  // A key for this run alone. It holds only what the testnet faucet sends it, and the run keeps
  // it in memory and nowhere else.
  const key = privateKeyToAccount(generatePrivateKey())
  const report = await keep({
    chain: tempoKeeperChain({ client, key }),
    factory: settings.factory,
    startBlock: settings.startBlock,
    lookback: settings.lookback,
    limits: MODERATO_LOG_LIMITS,
    explorer: explorerOf(client),
    log,
  })
  if (needsAttention(report)) process.exitCode = 1
}

main().catch((e: unknown) => {
  console.error(reasonOf(e))
  process.exit(1)
})
