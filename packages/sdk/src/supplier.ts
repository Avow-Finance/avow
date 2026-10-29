import type { AgreementOffer, Signed, StartReceipt, SupplierProfile } from '@avow-finance/spec'
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
