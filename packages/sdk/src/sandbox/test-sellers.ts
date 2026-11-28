import { parseTestSellers, type TestSeller } from '@avow-finance/spec'
import { deploymentOf, readDeploymentFile } from './deployment.js'
import { SANDBOX_SCREEN_URL } from './session.js'

/**
 * Avow's test sellers as the sandbox lists them, so an agent can order from one without knowing
 * its business ID. They read from the same deployment file the SDK takes Avow's API and factory
 * from, so the list is as trustworthy as the sandbox's own origin. Each is a labelled test
 * business, and nothing it sells is delivered or billed. What stops an order is the mandate the
 * business's person approved, which has to name the seller's business, as for any supplier.
 */
export type SandboxTestSellers =
  | { listed: true; sellers: TestSeller[] }
  /** The sandbox lists none, which a deployment does until it hosts its test sellers. */
  | { listed: false }

export async function sandboxTestSellers(
  o: { screenUrl?: string; fetch?: typeof fetch } = {},
): Promise<SandboxTestSellers> {
  const file = await readDeploymentFile(o.screenUrl ?? SANDBOX_SCREEN_URL, o.fetch)
  // The file has to describe a deployment the SDK would work against at all. That checks the
  // factory the same file names, and says nothing more about who wrote the list.
  deploymentOf(file)
  const list =
    typeof file.json === 'object' && file.json !== null && 'testSellers' in file.json
      ? file.json.testSellers
      : undefined
  if (list === undefined) return { listed: false }
  const sellers = parseTestSellers(list)
  if (!sellers.ok) {
    throw new Error(
      `The SDK can't read the sandbox's list of test sellers at ${file.url}, so none is shown.`,
    )
  }
  return sellers.value.length > 0 ? { listed: true, sellers: sellers.value } : { listed: false }
}
