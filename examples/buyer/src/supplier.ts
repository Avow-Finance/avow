import type { SupplierConnection } from '@avow-finance/sdk'
import { type SupplierProfile, toWire } from '@avow-finance/spec'
import { type Address, getAddress, type Hex } from 'viem'
import { z } from 'zod'

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((s) => getAddress(s) as Address)
const profileJson = z.object({
  businessId: z.string().regex(/^[a-z0-9_-]{1,64}$/),
  account: address,
  payee: address,
  signingKey: address,
})
const signatureJson = z.object({ signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/) })

/**
 * The agent's channel to a supplier that runs the supplier quickstart, or any adapter with the same
 * two routes. The profile comes from the supplier, and the agent checks every signature it gets
 * back against the signing key in that profile before it relies on it. The SDK refuses a booking
 * whose agreement another key signed, and Avow's API checks the profile against what it recorded
 * for the supplier.
 */
export async function httpSupplier(
  url: string,
  send: typeof fetch = fetch,
): Promise<SupplierConnection> {
  const base = url.replace(/\/+$/, '')
  const answer = await send(`${base}/profile`, { signal: AbortSignal.timeout(15_000) })
  const profile = profileJson.safeParse(await answer.json().catch(() => null))
  if (!answer.ok || !profile.success) throw new Error(`${base} gave no supplier profile`)
  return {
    profile: profile.data satisfies SupplierProfile,
    async signAgreement(offer) {
      const signed = await send(`${base}/agreements`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(toWire(offer)),
        signal: AbortSignal.timeout(30_000),
      })
      const body = (await signed.json().catch(() => null)) as { error?: unknown } | null
      if (!signed.ok) {
        throw new Error(
          `The supplier refused the agreement: ${String(body?.error ?? signed.status)}`,
        )
      }
      const parsed = signatureJson.safeParse(body)
      if (!parsed.success) throw new Error('The supplier answered with no signature')
      return parsed.data.signature as Hex
    },
    async startJob() {
      throw new Error("The quickstart doesn't start jobs yet")
    },
  }
}
