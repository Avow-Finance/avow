import { PRODUCTION_PROFILE, type TermsProfile } from './profiles.js'

/** Tempo's Moderato testnet. */
export const TEMPO_MODERATO = 42431

/** Chains where test data and the testnet demo profile may run. */
export const TESTNET_CHAIN_IDS: readonly number[] = [TEMPO_MODERATO]

export function isTestnetChain(chainId: number): boolean {
  return TESTNET_CHAIN_IDS.includes(chainId)
}

/**
 * Throws when a config would accept test data, or a contest window shorter than production's, on
 * a chain that isn't a testnet. It reads the window itself rather than the profile's name, so a
 * profile can't pass by being called production. It's a setup mistake, so it stops the caller
 * before any check runs.
 */
export function assertTestSettingsOnTestnet(config: {
  chainId: number
  testData: boolean
  profile: TermsProfile
}): void {
  if (isTestnetChain(config.chainId)) return
  if (config.testData) throw new Error(`Test data is refused on chain ${config.chainId}`)
  if (config.profile.minContestWindow < PRODUCTION_PROFILE.minContestWindow) {
    throw new Error(
      `A contest window under ${PRODUCTION_PROFILE.minContestWindow} seconds is refused on chain ${config.chainId}`,
    )
  }
}
