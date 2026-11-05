import { z } from 'zod'
import { REASON_CODES, type ReasonCode } from './reasons.js'

/**
 * The fields every session event shares, in one place so the sandbox's events and a job's events
 * read them the same way.
 */

/** The sources that act with only the agent's key. */
export const AGENT_SOURCES = ['script', 'mcp'] as const
export type AgentSource = (typeof AGENT_SOURCES)[number]

/** Which run of the agent an event belongs to, counting from 1. */
export const runJson = z.number().int().positive().max(1_000_000)

export const agentSourceJson = z.enum(AGENT_SOURCES)

/** A reason code this package knows. */
export const reasonCodeJson = z.enum(Object.keys(REASON_CODES) as [ReasonCode, ...ReasonCode[]])
