import { MODERATO_RPC_URL } from '@avow-finance/sdk'
import { type Address, getAddress, isAddress } from 'viem'

/** The keeper's settings, read from the environment. */
export interface KeeperSettings {
  /** The lock factory whose locks the keeper serves. */
  factory: Address
  /** The block the factory was created in, where the search for its locks starts. */
  startBlock: bigint
  /** How far back in the chain's time, in seconds, the keeper looks for commitments. */
  lookback: bigint
  rpcUrl: string
}

const DAY = 86_400n

/**
 * The demo factory times disputes in minutes and its bookings run in one sitting, so two weeks
 * holds every side there that can still have a step due, with room for a keeper that was off for
 * days. A booking weeks ahead, or a lock with a real 90-day dispute default, needs longer.
 */
export const LOOKBACK_DAYS = 14

/** Reads the keeper's settings. It throws naming each one that's missing or wrong. */
export function keeperSettings(env: Record<string, string | undefined>): KeeperSettings {
  const wrong: string[] = []
  const factory = env.AVOW_FACTORY?.trim() ?? ''
  if (!isAddress(factory, { strict: false })) wrong.push('AVOW_FACTORY')
  const startBlock = env.AVOW_FACTORY_START_BLOCK?.trim() ?? ''
  if (!/^\d{1,15}$/.test(startBlock)) wrong.push('AVOW_FACTORY_START_BLOCK')
  const days = env.LOOKBACK_DAYS?.trim() || String(LOOKBACK_DAYS)
  if (!/^\d{1,4}$/.test(days) || Number(days) < 1) wrong.push('LOOKBACK_DAYS')
  if (wrong.length > 0) {
    throw new Error(`These settings are missing or wrong: ${wrong.sort().join(', ')}`)
  }
  return {
    factory: getAddress(factory),
    startBlock: BigInt(startBlock),
    lookback: BigInt(days) * DAY,
    rpcUrl: env.RPC_URL?.trim() || MODERATO_RPC_URL,
  }
}
