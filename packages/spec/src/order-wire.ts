import type { Hex } from 'viem'
import { z } from 'zod'
import { type OrderDecline, orderDeclineJson } from './decline.js'
import { businessIdJson, bytes32, u64, u256 } from './json-fields.js'

/**
 * What every kind of order the sandbox mailbox carries shares on the wire: how a business is
 * named, how a funded reserve is reported, and the states an order passes through. A job order and
 * a service order each add their own request and quote.
 */

/**
 * The reserve the buyer funded, as Avow read it from the buyer's lock. Avow reads the lock itself,
 * so the transaction is there only when the agent saw it land, and null after a restart.
 */
export interface MailboxReserve {
  fundedIn: Hex | null
  amount: bigint
  /** The lock's deadline for the supplier to accept, after which the reserve goes back. */
  acceptBy: bigint
}

export const mailboxReserveJson = z.strictObject({
  fundedIn: bytes32.nullable(),
  amount: u256,
  acceptBy: u64,
})

/**
 * Where an order stands, with the quote its kind of order carries once the supplier has sent one.
 * An order ends before anything is reserved in one of three ways: it expires with no answer, the
 * supplier declines it with a reason, or the buyer withdraws it. A quote sent before either is
 * still shown, since it's part of the record, and it can no longer be funded.
 */
export type OrderStage<Quote> =
  | { status: 'requested' }
  | { status: 'expired'; quote: Quote | null }
  | { status: 'declined'; quote: Quote | null; decline: OrderDecline }
  | {
      status: 'withdrawn'
      quote: Quote | null
      /** When Avow took the buyer's withdrawal, by its own clock. */
      withdrawnAt: bigint
    }
  | { status: 'quoted'; quote: Quote }
  | { status: 'reserved'; quote: Quote; reserve: MailboxReserve }
  | {
      status: 'accepted'
      quote: Quote
      reserve: MailboxReserve
      /** The acceptance's transaction when the supplier's agent saw it land, or null. */
      acceptedIn: Hex | null
    }

/** An order's states as JSON, over the fields its kind of order holds and its kind of quote. */
export const orderStagesJson = <Base extends z.ZodRawShape, Quote extends z.ZodType>(
  base: Base,
  quote: Quote,
) =>
  z.discriminatedUnion('status', [
    z.strictObject({ ...base, status: z.literal('requested') }),
    z.strictObject({ ...base, status: z.literal('expired'), quote: quote.nullable() }),
    z.strictObject({
      ...base,
      status: z.literal('declined'),
      quote: quote.nullable(),
      decline: orderDeclineJson,
    }),
    z.strictObject({
      ...base,
      status: z.literal('withdrawn'),
      quote: quote.nullable(),
      withdrawnAt: u64,
    }),
    z.strictObject({ ...base, status: z.literal('quoted'), quote }),
    z.strictObject({ ...base, status: z.literal('reserved'), quote, reserve: mailboxReserveJson }),
    z.strictObject({
      ...base,
      status: z.literal('accepted'),
      quote,
      reserve: mailboxReserveJson,
      acceptedIn: bytes32.nullable(),
    }),
  ])

/** Reads JSON with a schema, or answers null for anything the schema refuses. */
export const readOrNull =
  <T>(schema: z.ZodType<T>) =>
  (json: unknown): T | null => {
    const parsed = schema.safeParse(json)
    return parsed.success ? parsed.data : null
  }
