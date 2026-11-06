import {
  type BuyerSideReference,
  chainedJobTerms,
  digestOf,
  discloseSection,
  type GpuReservationTerms,
  JOB_CATEGORY,
  type JobOffer,
  newSalt,
  type QuoteRequest,
  type RequestKey,
  type SupplierProfile,
  type TermsAgreement,
  type TestCustomerProfile,
  termsAgreementTypedData,
  termsHash,
  toWire,
} from '@avow-finance/spec'
import { hexToBigInt, toHex } from 'viem'

/** The compute a job relies on: the business's own booking of it, with its terms and salt. */
export interface ComputeBooking {
  /** The booking, on the buyer side of the business's own lock. */
  reference: BuyerSideReference
  terms: GpuReservationTerms
  salt: `0x${string}`
}

export interface JobQuoteInput {
  offer: JobOffer
  customer: TestCustomerProfile
  /** The developer's business, as Avow registered it as a supplier. */
  supplier: SupplierProfile
  /** The supplier's signing key, which signs the terms agreement. */
  signingKey: RequestKey
  /**
   * The compute booking the quote names, or null for a quote that names none, which the customer
   * refuses as `dependency.required`, as Avow would.
   */
  compute: ComputeBooking | null
  /** When the agreement lapses, in unix seconds. The customer refuses one valid too long. */
  expiry: bigint
}

const randomUint = () => hexToBigInt(toHex(crypto.getRandomValues(new Uint8Array(16))))

/**
 * Quotes an order. The quote's terms are the offer's, with the compute booking added as the one
 * booking they rely on, which makes them version 3. The salt is new, and the signing key signs the
 * terms agreement naming the offer's commitment id, the customer as buyer under its mandate, this
 * business as supplier and the job category. The quote shows the compute booking's subject, which
 * holds no price, so the customer can check the booking fits the job.
 */
export async function quoteJob(input: JobQuoteInput): Promise<QuoteRequest> {
  const { offer, customer, compute } = input
  if (input.signingKey.address.toLowerCase() !== input.supplier.signingKey.toLowerCase()) {
    throw new Error("The key given isn't the supplier's signing key")
  }
  const terms = compute
    ? chainedJobTerms(offer.terms, [
        { on: compute.reference, condition: 'accepted', disclosed: 'subject' },
      ])
    : offer.terms
  const salt = newSalt()
  const agreement: TermsAgreement = {
    commitmentId: offer.commitmentId,
    termsHash: termsHash(terms, salt),
    category: JOB_CATEGORY,
    buyerBusinessId: customer.businessId,
    supplierBusinessId: input.supplier.businessId,
    mandateHash: customer.mandateHash,
    nonce: randomUint(),
    expiry: input.expiry,
  }
  const domain = { chainId: customer.chainId, verifyingContract: customer.lock }
  const supplierSignature = await input.signingKey.signDigest(
    digestOf(termsAgreementTypedData(agreement, domain)),
  )
  const disclosed = compute ? [toWire(discloseSection(compute.terms, compute.salt, 'subject'))] : []
  return { terms, salt, agreement, supplierSignature, disclosed }
}
