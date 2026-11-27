import type { Address, Hex } from 'viem'
import { keccak256, stringToHex } from 'viem'
import { z } from 'zod'
import { address, bytes32, hexBytes, u64 } from './json-fields.js'
import { isPlainText } from './text.js'

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
 *
 * An agent can also ask before it knows its business, at `SANDBOX_PATHS.openAgentRequests`, signed
 * under the factory instead of a lock. That request names no business. Its link lets the person
 * sign in or set up a business and approve, and the approval binds it to the business whose root
 * key signed the agent's mandate. From then on the agent asks that business as any agent does.
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

/** The most characters an agent's label holds. */
export const AGENT_LABEL_MAX = 60

/** What a new label may hold, in the words an agent hears when its label can't be used. */
export const AGENT_LABEL_RULE = `A label is 1 to ${AGENT_LABEL_MAX} characters on one line, with no double quote and no hidden character or mark that changes which way text reads`

/**
 * The label a new request carries, trimmed. An agent chooses it, and the administrator reads it on
 * the card they approve, so it's held to `isPlainText` and can't pose as a line the card wrote or
 * reorder the words after it.
 */
export const agentLabelJson = z
  .string()
  .trim()
  .min(1)
  .max(AGENT_LABEL_MAX)
  .refine((v) => isPlainText(v, AGENT_LABEL_MAX), AGENT_LABEL_RULE)
  .describe(AGENT_LABEL_RULE)

/** The label an agent would ask under, trimmed, or null when a new request can't carry it. */
export function agentLabelOf(raw: string): string | null {
  const parsed = agentLabelJson.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/**
 * A label read back from a request Avow already holds, or from an approval request made from one.
 * It keeps the looser rule labels were first asked under, so a record from before `agentLabelJson`
 * still reads, and a label inside a signed decision keeps the terms it was signed over.
 */
export const heldAgentLabelJson = z
  .string()
  .trim()
  .min(1)
  .max(AGENT_LABEL_MAX)
  .regex(/^[^\p{Cc}]+$/u, 'printable characters only')

export const agentRequestJson = z.strictObject({
  businessId: z.string().min(1).max(200),
  label: agentLabelJson,
  signingKey: address.optional(),
})

export function parseAgentRequest(json: unknown): AgentRequest | null {
  const parsed = agentRequestJson.safeParse(json)
  if (!parsed.success) return null
  const { signingKey, ...rest } = parsed.data
  return signingKey ? { ...rest, signingKey } : rest
}

/** What an agent sends when it asks before it knows its business: its name, and any signing key. */
export type OpenAgentRequest = Omit<AgentRequest, 'businessId'>

export const openAgentRequestJson = agentRequestJson.omit({ businessId: true })

export function parseOpenAgentRequest(json: unknown): OpenAgentRequest | null {
  const parsed = openAgentRequestJson.safeParse(json)
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
  label: heldAgentLabelJson,
  pairingCode: z.string().regex(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/),
  requestedAt: u64,
  expiresAt: u64,
  /** The signing key an agent that sells asked to quote and accept with, or null. */
  signingKey: address.nullable(),
}

export const agentRequestStatusJson = z.discriminatedUnion('state', [
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

const { businessId: _businessId, lock: _lock, ...openBase } = statusBase

/**
 * Where a request that named no business stands. Open waits for someone to approve it, and bound
 * means a business's administrator approved it, so the agent asks that business for the approval
 * at `SANDBOX_PATHS.agentRequests`, as any agent does.
 */
export const openAgentRequestStatusJson = z.discriminatedUnion('state', [
  z.strictObject({ ...openBase, state: z.literal('open') }),
  z.strictObject({ ...openBase, state: z.literal('expired') }),
  z.strictObject({ ...openBase, state: z.literal('bound'), businessId: z.string().min(1) }),
])

/** An open request as Avow answers it, to the agent that made it or to a console that opens its link. */
export type OpenAgentRequestStatus = z.infer<typeof openAgentRequestStatusJson>

export function parseOpenAgentRequestStatus(json: unknown): OpenAgentRequestStatus | null {
  const parsed = openAgentRequestStatusJson.safeParse(json)
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
