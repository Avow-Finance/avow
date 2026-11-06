import { z } from 'zod'
import { REASON_CODES, type ReasonCode } from './reasons.js'

/**
 * The fields every session event shares, in one place so the sandbox's events and a job's events
 * read them the same way.
 */

/**
 * The sources that act with only the agent's key. `script` is the developer's agent file, `mcp` a
 * model driving the sandbox's MCP server, and `session` the developer's agent session, where a
 * model, or the scripted fixture, takes jobs through the job tools.
 */
export const AGENT_SOURCES = ['script', 'mcp', 'session'] as const
export type AgentSource = (typeof AGENT_SOURCES)[number]

/**
 * Who refused. `service` is the developer's own policy in `service.ts`, which the session's tool
 * layer applies before anything is signed. `sdk` is the agent's own SDK, which checks the mandate
 * before anyone signs. `avow` is Avow's API, which checks the mandate against what the lock holds
 * before it approves a reserve. `customer` is the customer's verifier, which checks a quote before
 * the customer commits. `supplier` is the supplier the agent books with, which can decline to sign
 * the agreement or never accept the reserve. `relay` is Avow's relay, which refuses to pay the fee
 * for a transaction it won't sponsor, or can't be reached. `lock` is a lock on-chain, which reverts
 * a reserve that breaks Avow's approval, including the caps the approval carries, whether the
 * revert lands or shows while the node prepares the transaction. `keychain` is the business
 * account's keychain, which holds the agent's key to the daily limit the business's root key set.
 * `unknown` is a transaction whose fate nobody gave: it expired in no block, the node never took
 * it, or the node wouldn't give its latest block.
 */
export const REFUSAL_LAYERS = [
  'service',
  'sdk',
  'avow',
  'customer',
  'supplier',
  'relay',
  'lock',
  'keychain',
  'unknown',
] as const
export type RefusalLayer = (typeof REFUSAL_LAYERS)[number]

/** Which run of the agent an event belongs to, counting from 1. */
export const runJson = z.number().int().positive().max(1_000_000)

export const agentSourceJson = z.enum(AGENT_SOURCES)

/** A reason code this package knows. */
export const reasonCodeJson = z.enum(Object.keys(REASON_CODES) as [ReasonCode, ...ReasonCode[]])
