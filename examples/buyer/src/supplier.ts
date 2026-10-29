import type { SupplierConnection } from '@avow-finance/sdk'
import {
  parseAgreementSignature,
  parseSupplierProfile,
  parseSupplierRefusal,
  SUPPLIER_ADAPTER_PATHS,
  toWire,
} from '@avow-finance/spec'

/**
 * The agent's channel to a supplier's adapter, over the routes and bodies the spec fixes for
 * every adapter. The profile comes from the supplier, and the agent checks every signature it gets
 * back against the signing key in that profile before it relies on it. The SDK refuses a booking
 * whose agreement another key signed, and Avow's API checks the profile against what it recorded
 * for the supplier.
 */
export async function httpSupplier(
  url: string,
  send: typeof fetch = fetch,
): Promise<SupplierConnection> {
  const base = url.replace(/\/+$/, '')
  const answer = await send(`${base}${SUPPLIER_ADAPTER_PATHS.profile}`, {
    signal: AbortSignal.timeout(15_000),
  })
  const profile = parseSupplierProfile(await answer.json().catch(() => null))
  if (!answer.ok || !profile.ok) throw new Error(`${base} gave no supplier profile`)
  return {
    profile: profile.value,
    async signAgreement(offer) {
      const signed = await send(`${base}${SUPPLIER_ADAPTER_PATHS.agreements}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(toWire(offer)),
        signal: AbortSignal.timeout(30_000),
      })
      const body: unknown = await signed.json().catch(() => null)
      if (!signed.ok) {
        const why = parseSupplierRefusal(body)?.error ?? String(signed.status)
        throw new Error(`The supplier refused the agreement: ${why}`)
      }
      const parsed = parseAgreementSignature(body)
      if (!parsed.ok) throw new Error(`The supplier answered with no signature (${parsed.reason})`)
      return parsed.value.signature
    },
    async startJob() {
      throw new Error("The quickstart doesn't start jobs yet")
    },
  }
}
