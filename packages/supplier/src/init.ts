import { join } from 'node:path'
import { AvowApiError, registerSandboxSupplier } from '@avow-finance/sdk'
import type { SandboxDeployment, SupplierProfile } from '@avow-finance/spec'
import { type Address, BaseError } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { SupplierStore } from './store.js'

export interface InitDeps {
  store: SupplierStore
  /** The deployment to register with, read only once the keys are in place. */
  deployment: () => Promise<Pick<SandboxDeployment, 'chainId' | 'apiUrl' | 'factory'>>
  /** Has Moderato's faucet fund an address, which the signing key needs for its fees. */
  fund: (address: Address) => Promise<unknown>
  fetch?: typeof fetch
  log: (line: string) => void
}

const message = (e: unknown) =>
  e instanceof BaseError ? e.shortMessage : e instanceof Error ? e.message : String(e)

/**
 * Makes the supplier's keys, or keeps the ones the state directory holds, registers them with
 * Avow's sandbox as a supplier and has the faucet fund the signing key. The account is its own
 * payout address. Avow answers a repeat of the same keys with the supplier it holds, so running
 * this again after any failure picks up where it stopped.
 */
export async function initSupplier(deps: InitDeps): Promise<SupplierProfile> {
  const { store, log } = deps
  if (!store.keys()) store.makeKeys()
  const keys = store.keys()
  if (!keys) throw new Error(`No keys in ${store.dir}. Run init again.`)
  const keysFile = join(store.dir, 'keys.json')
  const account = privateKeyToAccount(keys.accountKey)
  const signingKey = privateKeyToAccount(keys.signingKey)
  log(`keys are in ${keysFile}. Keep that file safe and out of version control.`)

  const deployment = await deps.deployment()
  log(`registering ${account.address} as a supplier with ${deployment.apiUrl}`)
  let profile: SupplierProfile
  try {
    profile = await registerSandboxSupplier({
      deployment,
      root: account,
      signingKey,
      payee: account.address,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    })
  } catch (e) {
    const reason = e instanceof Error && e.cause instanceof AvowApiError ? e.cause.reason : null
    if (reason === 'sandbox.taken') {
      throw new Error(
        `Avow refused these keys as taken (sandbox.taken). It holds this account with another payout address, or another supplier holds the signing key ${signingKey.address}. Make new keys by running init with a new STATE_DIR.`,
        { cause: e },
      )
    }
    throw new Error(
      `${message(e)} Your keys are kept in ${keysFile}, so run init again to register them.`,
      { cause: e },
    )
  }

  log(`funding the signing key ${signingKey.address} from Moderato's faucet`)
  try {
    await deps.fund(signingKey.address)
  } catch (e) {
    throw new Error(
      `Moderato's faucet didn't fund the signing key ${signingKey.address} (${message(e)}). Avow registered you as ${profile.businessId}, and your keys are kept in ${keysFile}, so run init again to ask the faucet again.`,
      { cause: e },
    )
  }
  return profile
}
