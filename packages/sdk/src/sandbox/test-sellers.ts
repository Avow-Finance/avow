import { parseTestSellers, type TestSeller } from '@avow-finance/spec'
import { deploymentOf, readDeploymentFile } from './deployment.js'
import { SANDBOX_SCREEN_URL } from './session.js'

/**
 * Avow's test sellers as the sandbox lists them, so an agent can order from one without knowing
 * its business ID. They read from the same deployment file the SDK takes Avow's API and factory
 * from, and only from a deployment the SDK trusts. Each is a labelled test business, and nothing
 * it sells is delivered or billed.
 */
export type SandboxTestSellers =
  | { listed: true; sellers: TestSeller[] }
  /** The sandbox lists none, which a deployment does until it hosts its test sellers. */
  | { listed: false }

export async function sandboxTestSellers(
  o: { screenUrl?: string; fetch?: typeof fetch } = {},
): Promise<SandboxTestSellers> {
  const file = await readDeploymentFile(o.screenUrl ?? SANDBOX_SCREEN_URL, o.fetch)
  // A list on a deployment the SDK doesn't trust is no list of Avow's.
  deploymentOf(file)
  const list =
    typeof file.json === 'object' && file.json !== null && 'testSellers' in file.json
      ? file.json.testSellers
      : undefined
  if (list === undefined) return { listed: false }
  const sellers = parseTestSellers(list)
  if (!sellers.ok) {
    throw new Error(
      `${file.url} lists test sellers the SDK can't read, so none is shown. Every seller has to be labelled as a test business.`,
    )
  }
  return sellers.value.length > 0 ? { listed: true, sellers: sellers.value } : { listed: false }
}
