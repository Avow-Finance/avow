import { MODERATO_RPC_URL } from '@avow-finance/sdk'
import { type Address, getAddress, isAddress } from 'viem'

/** The keeper's settings, read from the environment. */
export interface KeeperSettings {
  /** The lock factory whose locks the keeper serves. */
  factory: Address
  /** The block the factory was created in, where the search for its locks starts. */
  startBlock: bigint
  /**
   * How far back in the chain's time, in seconds, the keeper looks for commitments. It sends steps
   * only for sides reserved within it.
   */
  lookback: bigint
  /** How long, in milliseconds, a run starts new queries and sends for. */
  runFor: number
  rpcUrl: string
}

const DAY = 86_400n

/**
 * Two weeks, by default, of commitments the keeper serves. A side reserved longer ago than that
 * is out of its reach, however far away its next deadline is.
 */
export const LOOKBACK_DAYS = 14

/** How many minutes a run starts work for, by default, well inside the workflow's 15. */
export const RUN_MINUTES = 8

/** Reads the keeper's settings. It throws naming each one that's missing or wrong. */
export function keeperSettings(env: Record<string, string | undefined>): KeeperSettings {
  const wrong: string[] = []
  const factory = env.AVOW_FACTORY?.trim() ?? ''
  if (!isAddress(factory, { strict: false })) wrong.push('AVOW_FACTORY')
  const startBlock = env.AVOW_FACTORY_START_BLOCK?.trim() ?? ''
  if (!/^\d{1,15}$/.test(startBlock)) wrong.push('AVOW_FACTORY_START_BLOCK')
  const days = env.LOOKBACK_DAYS?.trim() || String(LOOKBACK_DAYS)
  if (!/^\d{1,4}$/.test(days) || Number(days) < 1) wrong.push('LOOKBACK_DAYS')
  const minutes = env.RUN_MINUTES?.trim() || String(RUN_MINUTES)
  if (!/^\d{1,4}$/.test(minutes) || Number(minutes) < 1) wrong.push('RUN_MINUTES')
  if (wrong.length > 0) {
    throw new Error(`These settings are missing or wrong: ${wrong.sort().join(', ')}`)
  }
  return {
    factory: getAddress(factory),
    startBlock: BigInt(startBlock),
    lookback: BigInt(days) * DAY,
    runFor: Number(minutes) * 60_000,
    rpcUrl: env.RPC_URL?.trim() || MODERATO_RPC_URL,
  }
}
