import { type Address, type Hex, isAddressEqual } from 'viem'
import { type AvowDomain, mandateHash } from './eip712.js'
import { isSignedMandate, type MandateProof, parseMandateProof } from './mandate-proof.js'
import type { ReasonCode } from './reasons.js'
import type { Parsed } from './wire.js'

/** The most mandates one agent's chain holds, the current one included. */
export const MAX_MANDATE_CHAIN = 64

/**
 * Every mandate an agent has held, as Avow serves them: the one it acts under now, and each one
 * that mandate replaced, newest first. The last of `earlier` is the mandate the agent's key was
 * put on with, or `current` is when the agent was never given another.
 */
export interface AgentMandates {
  current: MandateProof
  earlier: MandateProof[]
}

/** An agent's mandates checked as one chain, with each mandate's hash. */
export interface MandateChain {
  current: { proof: MandateProof; hash: Hex }
  /** The hashes of the mandates the current one replaced, newest first. */
  earlier: Hex[]
}

/**
 * Parses the mandates Avow serves for one agent. Each has to parse as a mandate for the lock it
 * names, and the chain can't hold more than `MAX_MANDATE_CHAIN`. It doesn't check that they link,
 * which `mandateChainProblem` does.
 */
export function parseAgentMandates(
  json: unknown,
  expected: { chainId: number; lock: Address },
): Parsed<AgentMandates> {
  if (typeof json !== 'object' || json === null) return { ok: false, reason: 'message.invalid' }
  const { current, earlier } = json as { current?: unknown; earlier?: unknown }
  if (!Array.isArray(earlier) || earlier.length >= MAX_MANDATE_CHAIN) {
    return { ok: false, reason: 'message.invalid' }
  }
  const head = parseMandateProof(current, expected)
  if (!head.ok) return head
  const rest: MandateProof[] = []
  for (const e of earlier) {
    const read = parseMandateProof(e, expected)
    if (!read.ok) return read
    rest.push(read.value)
  }
  return { ok: true, value: { current: head.value, earlier: rest } }
}

/**
 * Checks an agent's mandates link into one chain that starts at the mandate its key was put on
 * with, and returns each hash, or the reason they don't. Every mandate names the same account,
 * business, agent and key. Each one after the first names the hash of the one before it in
 * `replaces` and carries the account's signature, and the first names none and hashes to the key's
 * witness on the chain. Hashes are worked out here, never taken from whoever served the chain, so
 * a mandate can't be left out or slipped in without the links breaking.
 * It checks no signature, since that takes the chain, which the verifier and Avow's API read.
 *
 * It says nothing about which mandate is current beyond the order Avow served. Avow decides that
 * by approving reserves only under the current one, and the lock takes none without its approval.
 */
export function mandateChainProblem(
  mandates: AgentMandates,
  expected: { domain: AvowDomain; agentKey: Address; witness: Hex },
): { ok: true; value: MandateChain } | { ok: false; reason: ReasonCode } {
  const no = (reason: ReasonCode) => ({ ok: false, reason }) as const
  const all = [mandates.current, ...mandates.earlier]
  const first = mandates.current.message
  if (!isAddressEqual(first.agentKey, expected.agentKey)) return no('agent.key_mismatch')
  for (const { message: m } of all) {
    if (
      !isAddressEqual(m.account, first.account) ||
      !isAddressEqual(m.agentKey, first.agentKey) ||
      m.businessId !== first.businessId ||
      m.agentId !== first.agentId
    ) {
      return no('message.invalid')
    }
  }
  const hashes = all.map((p) => mandateHash(p.message, expected.domain))
  for (let i = 0; i < all.length - 1; i++) {
    const later = all[i] as MandateProof
    if (later.message.replaces?.toLowerCase() !== hashes[i + 1]?.toLowerCase()) {
      return no('mandate.replaces_mismatch')
    }
    if (!isSignedMandate(later)) return no('message.invalid')
  }
  const oldest = all[all.length - 1] as MandateProof
  if (oldest.message.replaces !== undefined) return no('mandate.replaces_mismatch')
  if (hashes[hashes.length - 1]?.toLowerCase() !== expected.witness.toLowerCase()) {
    return no('chain.mandate_mismatch')
  }
  return {
    ok: true,
    value: {
      current: { proof: mandates.current, hash: hashes[0] as Hex },
      earlier: hashes.slice(1),
    },
  }
}
