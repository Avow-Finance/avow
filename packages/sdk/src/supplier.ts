import {
  type AgreementOffer,
  parseAgreementSignature,
  parseSupplierProfile,
  parseSupplierRefusal,
  type Signed,
  type StartReceipt,
  SUPPLIER_ADAPTER_PATHS,
  type SupplierProfile,
  toWire,
} from '@avow-finance/spec'
import type { Hex } from 'viem'

/**
 * The agent's channel to one supplier. The supplier's own integration implements it, and a
 * scripted supplier implements it for a demo or a test. Over HTTP, a supplier's adapter serves
 * the profile and the agreement at the routes `SUPPLIER_ADAPTER_PATHS` names, with the bodies the
 * spec's `parseSupplierProfile`, `parseAgreementOffer` and `parseAgreementSignature` read.
 */
export interface SupplierConnection {
  /** The supplier's business id, account, signing key and payout address. */
  readonly profile: SupplierProfile
  /**
   * Asks the supplier to sign the terms agreement. The supplier checks that the terms and salt
   * give the agreement's terms hash and that the terms are ones it offers, then signs the
   * agreement with its signing key and returns the signature.
   */
  signAgreement(offer: AgreementOffer): Promise<Hex>
  /** Asks the supplier to start the job, which returns its signed start receipt. */
  startJob(request: {
    commitmentId: Hex
    startRequestHash: Hex
    requestedAt: bigint
  }): Promise<Signed<StartReceipt>>
}

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
      throw new Error("The supplier adapter's routes don't start a job yet")
    },
  }
}
