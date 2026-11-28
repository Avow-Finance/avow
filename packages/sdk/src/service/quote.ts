import {
  digestOf,
  type JobBuyer,
  newSalt,
  type RequestKey,
  SERVICE_CATEGORY,
  type ServiceOrderRequest,
  type ServiceQuote,
  type ServiceSettlement,
  type SupplierProfile,
  serviceOfferTerms,
  type TermsAgreement,
  termsAgreementTypedData,
  termsHash,
} from '@avow-finance/spec'
import { type Hex, hexToBigInt, toHex } from 'viem'

export interface ServiceQuoteInput {
  /** The order, whose offer the supplier has already found among the versions it published. */
  order: Pick<ServiceOrderRequest, 'offer' | 'quantity' | 'builtAt' | 'commitmentId'>
  /** The buyer, which the agreement names with its agent's mandate. */
  buyer: JobBuyer
  /** The business selling, as Avow registered it as a supplier. */
  supplier: SupplierProfile
  /** The supplier's signing key, which signs the terms agreement. */
  signingKey: RequestKey
  /** The arbiter and day-90 share the deployment's approvals name. */
  settlement: ServiceSettlement
  /** When the agreement lapses, in unix seconds. */
  expiry: bigint
  /**
   * The hash of the seller's mandate the supplier's agent sells under, which the agreement names,
   * or null when no seller's mandate is in force for its signing key. Naming one signs the
   * agreement at version 2, and naming none leaves it at version 1.
   */
  sellerMandate: Hex | null
}

const randomUint = () => hexToBigInt(toHex(crypto.getRandomValues(new Uint8Array(16))))

/**
 * Quotes a service order. The terms are the ones the order builds, with nothing moved, under a new
 * salt. The signing key signs the terms agreement naming the order's commitment id, the buyer under
 * its mandate, this business as supplier, the service category, and the seller's mandate the
 * agent sells under when one is in force. Naming it shows the buyer which mandate the sale was
 * agreed under, and proves no check of it. It throws when the offer names
 * another business, since a supplier quotes only its own.
 */
export async function quoteService(input: ServiceQuoteInput): Promise<ServiceQuote> {
  const { order, buyer } = input
  if (input.signingKey.address.toLowerCase() !== input.supplier.signingKey.toLowerCase()) {
    throw new Error("The key given isn't the supplier's signing key")
  }
  if (order.offer.supplier !== input.supplier.businessId) {
    throw new Error("The order's offer names another business")
  }
  const terms = serviceOfferTerms(order.offer, order.quantity, order.builtAt, input.settlement)
  const salt = newSalt()
  const agreement: TermsAgreement = {
    commitmentId: order.commitmentId,
    termsHash: termsHash(terms, salt),
    category: SERVICE_CATEGORY,
    buyerBusinessId: buyer.businessId,
    supplierBusinessId: input.supplier.businessId,
    mandateHash: buyer.mandateHash,
    nonce: randomUint(),
    expiry: input.expiry,
    ...(input.sellerMandate === null ? {} : { sellerMandate: input.sellerMandate }),
  }
  const domain = { chainId: buyer.chainId, verifyingContract: buyer.lock }
  const supplierSignature = await input.signingKey.signDigest(
    digestOf(termsAgreementTypedData(agreement, domain)),
  )
  return { terms, salt, agreement, supplierSignature }
}
