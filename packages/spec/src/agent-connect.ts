import type { Address, Hex } from 'viem'
import { keccak256, stringToHex } from 'viem'
import { z } from 'zod'
import { address, bytes32, hexBytes, u64 } from './json-fields.js'

/**
 * An agent asking a business for authority, from wherever its developer runs it. The agent makes
 * its own key, and sends Avow a request signed by that key naming the business it works for. The
 * business's administrator sees the request in the console, checks the pairing code against the
 * one the agent printed, and signs the agent's mandate and key authorization with the passkey.
 * Avow holds the signed approval for the agent to collect, and the agent enrolls with it. The
 * routes are `SANDBOX_PATHS.agentRequests` and `SANDBOX_PATHS.agentApproval`.
 *
 * The agent asks by sending its request, and hears the answer by sending it again. Each ask is
 * answered with where the request stands, and an ask after a request lapsed starts a fresh one.
 *
 * The request carries no authority. Anyone can ask any business, and nothing is granted until the
 * account's own root key signs. The pairing code is how the administrator tells their own agent's
 * request from someone else's.
 */

/** How long a request waits for the administrator, in seconds, before it lapses unanswered. */
export const AGENT_REQUEST_LIFETIME = 60n * 60n

/**
 * What an agent sends when it asks: the business it works for, a name its developer chose, and for
 * an agent that sells, the signing key it made to quote and accept jobs for the business.
 */
export interface AgentRequest {
  businessId: string
  label: string
  signingKey?: Address
}

const labelJson = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[^\p{Cc}]+$/u, 'printable characters only')

const agentRequestJson = z.strictObject({
  businessId: z.string().min(1).max(200),
  label: labelJson,
  signingKey: address.optional(),
})

export function parseAgentRequest(json: unknown): AgentRequest | null {
  const parsed = agentRequestJson.safeParse(json)
  if (!parsed.success) return null
  const { signingKey, ...rest } = parsed.data
  return signingKey ? { ...rest, signingKey } : rest
}

/** Where a request stands. Approved carries the signed approval for the agent to enroll with. */
export const AGENT_REQUEST_STATES = ['pending', 'approved', 'expired'] as const
export type AgentRequestState = (typeof AGENT_REQUEST_STATES)[number]

const statusBase = {
  businessId: z.string().min(1),
  agentKey: address,
  lock: address,
  label: labelJson,
  pairingCode: z.string().regex(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/),
  requestedAt: u64,
  expiresAt: u64,
  /** The signing key an agent that sells asked to quote and accept with, or null. */
  signingKey: address.nullable(),
}

const agentRequestStatusJson = z.discriminatedUnion('state', [
  z.strictObject({ ...statusBase, state: z.literal('pending') }),
  z.strictObject({ ...statusBase, state: z.literal('expired') }),
  z.strictObject({
    ...statusBase,
    state: z.literal('approved'),
    // The body the agent sends to enroll, exactly as the administrator's console posted it.
    approval: z.strictObject({
      mandate: z.record(z.string(), z.unknown()),
      keyAuthorizedIn: bytes32,
    }),
    // For an agent that sells, the supplier registration of its signing key with the account's
    // signature on it, which the agent completes with its own and sends to Avow. Null otherwise.
    supplierRegistration: z
      .strictObject({ registration: z.record(z.string(), z.unknown()), accountSignature: hexBytes })
      .nullable(),
  }),
])

/** A request as Avow answers it, to the agent that made it or to the business's console. */
export type AgentRequestStatus = z.infer<typeof agentRequestStatusJson>

export function parseAgentRequestStatus(json: unknown): AgentRequestStatus | null {
  const parsed = agentRequestStatusJson.safeParse(json)
  return parsed.success ? parsed.data : null
}

// Crockford's base32, which leaves out I, L, O and U so a code read aloud or retyped stays right.
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * The code an agent prints when it asks, and the console shows beside the request. Both work it
 * out from the agent's key, so it needs no channel of its own: matching codes mean the request in
 * the console came from the agent in the developer's terminal. Eight characters, 40 bits.
 */
export function pairingCode(agentKey: Address): string {
  const digest: Hex = keccak256(stringToHex(`avow-pairing:${agentKey.toLowerCase()}`))
  let bits = BigInt(digest.slice(0, 12)) // the first 5 bytes
  let code = ''
  for (let i = 0; i < 8; i++) {
    code = (CODE_ALPHABET[Number(bits & 31n)] ?? '0') + code
    bits >>= 5n
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

/**
 * The hash of a console link that opens one agent's request for review. It names the request by
 * the agent's key and grants nothing, since whoever opens it still signs in, and only the
 * business's administrator can approve what the console shows.
 */
export const approvalHash = (agentKey: Address): string => `#approve-${agentKey.toLowerCase()}`

/** The agent key a console link's hash names for review, or null when it names none. */
export function approvalKeyOf(hash: string): Address | null {
  const match = /^#approve-(0x[0-9a-f]{40})$/.exec(hash)
  return match ? (match[1] as Address) : null
}
