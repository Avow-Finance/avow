import { parseSupplierProfile, SANDBOX_PATHS, type SupplierProfile } from '@avow-finance/spec'

/**
 * A sandbox supplier's profile as Avow publishes it, or null when Avow answers that it has no
 * such supplier. It throws when Avow can't be asked or answers anything else, so a supplier Avow
 * doesn't know is never mistaken for one it couldn't be asked about.
 */
export async function sandboxSupplierProfile(
  apiUrl: string,
  businessId: string,
  send: typeof fetch,
): Promise<SupplierProfile | null> {
  const answer = await send(`${apiUrl}${SANDBOX_PATHS.supplier(businessId)}`, {
    signal: AbortSignal.timeout(15_000),
  })
  if (answer.status === 404) return null
  const profile = parseSupplierProfile(await answer.json().catch(() => null))
  if (!answer.ok || !profile.ok) {
    throw new Error(`Avow couldn't say whether it knows the supplier ${businessId}`)
  }
  return profile.value
}
