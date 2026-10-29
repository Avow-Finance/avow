import type { Address, Hex } from 'viem'
import { z } from 'zod'
import type { AvowDomain, TermsAgreement } from './eip712.js'
import { isKeySignatureForm } from './keychain.js'
import type { SupplierProfile, Terms } from './types.js'
import { type Parsed, parseTerms, termsAgreementJson } from './wire.js'

/**
 * The two routes a supplier's adapter serves to agents, under the base URL the supplier gives
 * them. A `GET` of `profile` answers with the supplier's `SupplierProfile`. A `POST` of an
 * `AgreementOffer` to `agreements` answers with status 200 and an `AgreementSignature`, or with a
 * status of 400 or more and a `SupplierRefusal`. Every body is JSON, with amounts and times as
 * decimal strings, as `toWire` writes them.
 */
export const SUPPLIER_ADAPTER_PATHS = { profile: '/profile', agreements: '/agreements' } as const

/**
 * An agent's request that a supplier sign a terms agreement: the agreement, the terms and salt
 * that give its terms hash, and the domain of the buyer's lock it's signed under. The supplier
 * checks the terms are ones it offers and give the agreement's terms hash before it signs.
 */
export interface AgreementOffer {
  agreement: TermsAgreement
  terms: Terms
  salt: Hex
  domain: AvowDomain
}

/**
 * A supplier's answer to an offer it signs: its signing key's signature over the agreement's
 * EIP-712 digest. The agent checks it with `isKeySignature` before relying on it.
 */
export interface AgreementSignature {
  signature: Hex
}

/** A supplier's answer to an offer it won't sign, saying why in a sentence. */
export interface SupplierRefusal {
  error: string
}

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((s) => s.toLowerCase() as Address)
const bytes32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((s) => s.toLowerCase() as Hex)
const objectJson = z.record(z.string(), z.unknown())

const profileJson = z.object({
  businessId: z.string().min(1),
  account: address,
  payee: address,
  signingKey: address,
})

const offerJson = z.strictObject({
  agreement: objectJson,
  terms: objectJson,
  salt: bytes32,
  domain: z.strictObject({ chainId: z.number().int().positive(), verifyingContract: address }),
})

/** Reads a supplier's profile. Other fields are ignored, so an adapter can serve more. */
export function parseSupplierProfile(json: unknown): Parsed<SupplierProfile> {
  const parsed = profileJson.safeParse(json)
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, reason: 'message.invalid' }
}

/**
 * Reads an agent's offer. The agreement and the terms parse as their own schemas, so terms of
 * another version or under a template this code doesn't know are refused with the reason
 * `parseTerms` gives.
 */
export function parseAgreementOffer(json: unknown): Parsed<AgreementOffer> {
  const outer = offerJson.safeParse(json)
  if (!outer.success) return { ok: false, reason: 'message.invalid' }
  const agreement = termsAgreementJson.safeParse(outer.data.agreement)
  if (!agreement.success) return { ok: false, reason: 'message.invalid' }
  const terms = parseTerms(outer.data.terms)
  if (!terms.ok) return terms
  return {
    ok: true,
    value: {
      agreement: agreement.data,
      terms: terms.value,
      salt: outer.data.salt,
      domain: outer.data.domain,
    },
  }
}

/**
 * Reads a supplier's signature on an offer. It takes every kind of signature `isKeySignature`
 * checks, so a supplier whose signing key is a passkey can answer. Whether the supplier's signing
 * key signed this agreement is for the agent to check, as the SDK's `book` does.
 */
export function parseAgreementSignature(json: unknown): Parsed<AgreementSignature> {
  const parsed = z.object({ signature: z.string().regex(/^0x([0-9a-fA-F]{2})+$/) }).safeParse(json)
  if (!parsed.success) return { ok: false, reason: 'message.invalid' }
  const signature = parsed.data.signature.toLowerCase() as Hex
  if (!isKeySignatureForm(signature)) return { ok: false, reason: 'message.signature_invalid' }
  return { ok: true, value: { signature } }
}

/** Reads why a supplier refused an offer, or returns null when the body doesn't say. */
export function parseSupplierRefusal(json: unknown): SupplierRefusal | null {
  const parsed = z.object({ error: z.string().min(1) }).safeParse(json)
  return parsed.success ? { error: parsed.data.error } : null
}
