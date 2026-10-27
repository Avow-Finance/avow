/** Tempo's Moderato testnet. */
export const TEMPO_MODERATO = 42431

/** Chains where test data and the testnet demo profile may run. */
export const TESTNET_CHAIN_IDS: readonly number[] = [TEMPO_MODERATO]

export function isTestnetChain(chainId: number): boolean {
  return TESTNET_CHAIN_IDS.includes(chainId)
}

/**
 * Throws when a config would accept test data or the testnet demo terms on a chain that isn't a
 * testnet. It's a setup mistake, so it stops the caller before any check runs.
 */
export function assertTestSettingsOnTestnet(config: {
  chainId: number
  testData: boolean
  profile: { name: string }
}): void {
  if (isTestnetChain(config.chainId)) return
  if (config.testData) throw new Error(`Test data is refused on chain ${config.chainId}`)
  if (config.profile.name !== 'production') {
    throw new Error(`The ${config.profile.name} profile is refused on chain ${config.chainId}`)
  }
}
