import type { Hex } from 'viem'
import { z } from 'zod'
import type { JobTerms } from './job.js'
import { address, bytes32, u64, u256 } from './json-fields.js'
import {
  type JobRequirement,
  jobRequirementJson,
  orderIdJson,
  type QuoteRequest,
  quoteRequestJson,
} from './test-customer.js'
import { jobTermsJson } from './wire.js'

/**
 * Avow's sandbox mailbox, which carries a job between two businesses' agents wherever each one
 * runs. Every message is signed by the key that sends it, and Avow keeps each order until it ends,
 * so an agent that reads an order and stops before answering reads it again.
 *
 * 1. The buyer's agent sends an order with an expiry. Nothing is reserved.
 * 2. The supplier's agent reads it from its inbox and sends terms, a quote it signed.
 * 3. The buyer's agent checks the quote, its authority and the bookings the job relies on, funds
 *    the commitment, and tells the mailbox, which reads the reserve on chain.
 * 4. The supplier's agent accepts on chain under the commitment's rules, and tells the mailbox,
 *    which reads the acceptance on chain.
 *
 * An order nobody funded lapses at its expiry, with nothing reserved. Once funded it's a
 * commitment awaiting acceptance, and the lock's own deadlines decide what happens to the reserve.
 * Each step is answered the same when sent again, so a retry never makes a second commitment.
 */

/** The longest an order can wait to be funded, in seconds, from when the buyer sends it. */
export const MAILBOX_ORDER_LIFETIME_MAX = 60n * 60n

/** The most orders an inbox answers with at once, oldest first. */
export const MAILBOX_INBOX_MAX = 20

/** What a quote and an acceptance need to know of the buyer: its business, lock and mandate. */
export interface JobBuyer {
  businessId: string
  account: `0x${string}`
  lock: `0x${string}`
  chainId: number
  /** The hash of the buyer agent's mandate, which the supplier's terms agreement names. */
  mandateHash: Hex
}

/** What a buyer's agent sends to order a job from another business. */
export interface MailboxOrderRequest {
  orderId: string
  /** The commitment id the buyer chose, which the quote's agreement has to name. */
  commitmentId: Hex
  supplierBusinessId: string
  /** The terms the buyer offers. A quote may add the bookings the job relies on, and nothing else. */
  terms: JobTerms
  /** The booking the job has to rely on. */
  requirement: JobRequirement
  /** When the order lapses unless it's funded, in unix seconds. */
  expiry: bigint
}

export const MAILBOX_STATUSES = ['requested', 'quoted', 'expired', 'reserved', 'accepted'] as const
export type MailboxStatus = (typeof MAILBOX_STATUSES)[number]

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

interface MailboxOrderBase extends MailboxOrderRequest {
  buyer: JobBuyer
  requestedAt: bigint
}

/** An order as the mailbox answers it, to either side or to either business's console. */
export type MailboxOrder =
  | (MailboxOrderBase & { status: 'requested' })
  | (MailboxOrderBase & { status: 'expired'; quote: QuoteRequest | null })
  | (MailboxOrderBase & { status: 'quoted'; quote: QuoteRequest })
  | (MailboxOrderBase & { status: 'reserved'; quote: QuoteRequest; reserve: MailboxReserve })
  | (MailboxOrderBase & {
      status: 'accepted'
      quote: QuoteRequest
      reserve: MailboxReserve
      /** The acceptance's transaction when the supplier's agent saw it land, or null. */
      acceptedIn: Hex | null
    })

const businessIdJson = z.string().min(1).max(100)

export const jobBuyerJson = z.strictObject({
  businessId: businessIdJson,
  account: address,
  lock: address,
  chainId: z.number().int().positive(),
  mandateHash: bytes32,
})

export const mailboxOrderRequestJson = z.strictObject({
  orderId: orderIdJson,
  commitmentId: bytes32,
  supplierBusinessId: businessIdJson,
  terms: jobTermsJson,
  requirement: jobRequirementJson,
  expiry: u64,
})

const reserveJson = z.strictObject({ fundedIn: bytes32.nullable(), amount: u256, acceptBy: u64 })

const base = { ...mailboxOrderRequestJson.shape, buyer: jobBuyerJson, requestedAt: u64 }

export const mailboxOrderJson = z.discriminatedUnion('status', [
  z.strictObject({ ...base, status: z.literal('requested') }),
  z.strictObject({ ...base, status: z.literal('expired'), quote: quoteRequestJson.nullable() }),
  z.strictObject({ ...base, status: z.literal('quoted'), quote: quoteRequestJson }),
  z.strictObject({
    ...base,
    status: z.literal('reserved'),
    quote: quoteRequestJson,
    reserve: reserveJson,
  }),
  z.strictObject({
    ...base,
    status: z.literal('accepted'),
    quote: quoteRequestJson,
    reserve: reserveJson,
    acceptedIn: bytes32.nullable(),
  }),
])

/** What the buyer sends once its reserve is on the lock, which Avow then reads for itself. */
export const mailboxReservedJson = z.strictObject({ fundedIn: bytes32.nullable() })
/** What the supplier sends once the lock shows its acceptance, which Avow then reads for itself. */
export const mailboxAcceptedJson = z.strictObject({ acceptedIn: bytes32.nullable() })

const read =
  <T>(schema: z.ZodType<T>) =>
  (json: unknown): T | null => {
    const parsed = schema.safeParse(json)
    return parsed.success ? parsed.data : null
  }

export const parseMailboxOrderRequest = read(
  mailboxOrderRequestJson as unknown as z.ZodType<MailboxOrderRequest>,
)
export const parseMailboxOrder = read(mailboxOrderJson as unknown as z.ZodType<MailboxOrder>)
export const parseMailboxInbox = read(
  z.strictObject({
    orders: z.array(mailboxOrderJson).max(MAILBOX_INBOX_MAX),
  }) as unknown as z.ZodType<{
    orders: MailboxOrder[]
  }>,
)
export const parseMailboxReserved = read(mailboxReservedJson)
export const parseMailboxAccepted = read(mailboxAcceptedJson)

/**
 * Where an order stands at `now`, from what the mailbox holds. An order nobody funded is expired
 * from its expiry on, whether or not it was quoted, and a funded one never expires here.
 */
export function mailboxStatusAt(
  held: { status: MailboxStatus; expiry: bigint },
  now: bigint,
): MailboxStatus {
  if ((held.status === 'requested' || held.status === 'quoted') && now >= held.expiry) {
    return 'expired'
  }
  return held.status
}
