import type { Hex } from 'viem'
import { z } from 'zod'
import { type PinnedBlock, pinnedBlockJson } from './dependencies.js'
import { bytes32 } from './json-fields.js'
import { type CommitmentReference, commitmentReferenceJson } from './references.js'

/**
 * A fact is a statement a check made about the chain, with what it rests on. Whoever states it,
 * the developer's session or the customer, it names who verified it, the commitment it's about and
 * the block it was read at, so a reader can check it from the chain itself and never takes it on
 * the word of whoever posted it. A signature on an event that carries a fact says who posted it,
 * never that the fact is true.
 */

/**
 * Who verified a fact or a receipt: the developer's `service.ts` on the developer's machine, the
 * customer's verifier, or Avow's API.
 */
export const VERIFIERS = ['service', 'customer', 'avow'] as const
export type VerifiedBy = (typeof VERIFIERS)[number]

/**
 * Which check a fact comes from: the check of a booking relied on, of a commitment's terms and
 * approval, of a reserve on its lock, or of a payment transfer.
 */
export const FACT_CHECKS = ['dependency', 'commitment', 'reserve', 'payment'] as const
export type FactCheck = (typeof FACT_CHECKS)[number]

/** The longest a fact's text may be. */
export const FACT_TEXT_MAX = 500

/** What a fact says and what it rests on. */
export interface FactBody {
  text: string
  check: FactCheck
  verifiedBy: VerifiedBy
  /** The commitment the fact is about: chain, lock, commitment id and side, with its terms hash. */
  reference: CommitmentReference
  /** The block the check read. The fact says nothing about the chain after it. */
  block: PinnedBlock
  /** The transaction the fact rests on, such as the one that funded a reserve, when there is one. */
  transactionHash: Hex | null
}

/** A fact's fields as JSON, which an event or an order's state carries. */
export const factBodyShape = {
  text: z.string().min(1).max(FACT_TEXT_MAX),
  check: z.enum(FACT_CHECKS),
  verifiedBy: z.enum(VERIFIERS),
  reference: commitmentReferenceJson,
  block: pinnedBlockJson,
  transactionHash: bytes32.nullable(),
}
