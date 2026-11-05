import type { Address, Hex } from 'viem'
import { z } from 'zod'
import {
  type CheckedDependency,
  checkedDependencyJson,
  dependencyIndexJson,
  MAX_DEPENDENCIES,
  type PinnedBlock,
  pinnedBlockJson,
} from './dependencies.js'
import type { TermsAgreement } from './eip712.js'
import { GPU_RESERVATION } from './gpu-reservation.js'
import type { ChainedJobTerms, JobTerms } from './job.js'
import { address, bytes32, hexBytes, u64, u256 } from './json-fields.js'
import type { ReasonCode } from './reasons.js'
import {
  type CommitmentReference,
  commitmentReferenceJson,
  type PaymentReference,
} from './references.js'
import { reasonCodeJson } from './session-fields.js'
import { supplierProfileJson } from './supplier-adapter.js'
import type { SupplierProfile } from './types.js'
import {
  chainedJobTermsJson,
  jobTermsJson,
  type Parsed,
  paymentReferenceJson,
  termsAgreementJson,
} from './wire.js'

/**
 * Avow's test customer, a sandbox business on testnet that offers a developer's business paid
 * jobs. Avow's service holds its keys, on testnet only, and it's labelled as Avow's test customer
 * in everything it returns. Its own agent key funds its reserves from its own account, so its lock
 * still pulls only from the account calling it.
 *
 * Orders arrive by pull, so the developer's machine needs no inbound connection. Its job process
 * asks for an order, quotes it, then polls the order until the customer has verified the quote and
 * reserved, and reports delivery.
 *
 * Every POST is a signed API request, as `api-request` defines one, signed by the developer's
 * supplier signing key, with the customer's origin as the audience and the customer's lock as the
 * domain's lock. An order belongs to the supplier it was offered to, which the customer records
 * with the offer. A request for a new order has to be signed by the signing key Avow registered
 * for the supplier it names. A quote or a delivery report has to be signed by the signing key of
 * the supplier the order was offered to, and `orderSignerProblem` refuses any other signer. An
 * order's id is no secret, since every job event names it and anyone with the screen's link can
 * read those, so the id alone lets nobody act on an order. A refusal has the API's error shape and
 * a reason code. The GETs are unsigned. The origin is the sandbox deployment's `customerUrl`.
 */

/** How the test customer labels itself, in its profile, its offers and every order it returns. */
export const TEST_CUSTOMER_LABEL = "Avow's test customer"

/** An order id: 16 random bytes as 32 lower-case hex characters. */
const ORDER_ID = /^[0-9a-f]{32}$/

/** Whether text is an order id, the only form an order's path carries. */
export const isOrderId = (text: string): boolean => ORDER_ID.test(text)

const pathOf = (orderId: string, rest = '') => {
  if (!isOrderId(orderId)) throw new RangeError(`${orderId} isn't an order id`)
  return `/v1/orders/${orderId}${rest}`
}

/** The test customer's routes, each a path on its origin. */
export const TEST_CUSTOMER_PATHS = {
  /** GET, unsigned. The customer's profile. */
  profile: '/v1/profile',
  /** POST, signed. Asks for a new order and answers with the offer. */
  orders: '/v1/orders',
  /** GET, unsigned and polled. Where the order stands. */
  order: (orderId: string) => pathOf(orderId),
  /** POST, signed. Sends the quote, answered with 202 while the customer verifies it. */
  quote: (orderId: string) => pathOf(orderId, '/quote'),
  /** POST, signed, with an empty object as the body. Reports delivery, answered with 202. */
  delivery: (orderId: string) => pathOf(orderId, '/delivery'),
} as const

/** The customer, as each offer, order and session event names it. */
export interface JobCustomer {
  label: typeof TEST_CUSTOMER_LABEL
  businessId: string
}

/** The most the test customer commits to, so nobody can drain the sandbox through it. */
export interface TestCustomerLimits {
  /** The most it reserves for one job, in micros. */
  reserve: bigint
  /** The most it pays for one job, in micros. */
  price: bigint
  /** The most orders one supplier can have open at once. */
  openOrders: number
}

/** What GET `/v1/profile` answers. */
export interface TestCustomerProfile extends JobCustomer {
  account: Address
  lock: Address
  chainId: number
  /** The hash of the mandate its agent key holds, which every terms agreement names. */
  mandateHash: Hex
  limits: TestCustomerLimits
}

/** The body of POST `/v1/orders`: the developer's business as Avow registered it as a supplier. */
export interface OrderRequest {
  supplier: SupplierProfile
}

/**
 * The booking a quote has to rely on. The customer accepts a quote only when its terms name an
 * accepted GPU reservation in the supplier's own lock that holds the job's compute for its whole
 * run, past its free cancellation, with its subject shown.
 */
export interface JobRequirement {
  template: typeof GPU_RESERVATION
  condition: 'accepted'
  disclosed: 'subject'
}

/** What POST `/v1/orders` answers: an offer of a job, open until its expiry. */
export interface JobOffer {
  orderId: string
  /** The commitment id the job's terms agreement has to name. */
  commitmentId: Hex
  customer: JobCustomer
  /** The supplier the order was offered to, the only one that can quote it or report delivery. */
  supplierBusinessId: string
  /** The job as the customer proposes it, before its terms name any compute. */
  terms: JobTerms
  requirement: JobRequirement
  /** When the offer lapses, in unix seconds. */
  expiry: bigint
}

/**
 * The body of POST `/v1/orders/{orderId}/quote`. The supplier's signing key signed the agreement,
 * which names the offer's commitment id, the customer as buyer, the customer's mandate hash and
 * the terms hash of these terms under this salt. Job terms in version 2's shape name no compute,
 * and the customer refuses them with `dependency.required`, as Avow would.
 */
export interface QuoteRequest {
  terms: ChainedJobTerms | JobTerms
  salt: Hex
  agreement: TermsAgreement
  supplierSignature: Hex
  /**
   * For each booking the terms rely on, in their order, its subject section as JSON, as
   * `discloseSection` writes it.
   */
  disclosed: readonly unknown[]
}

/**
 * Who refused for the customer. `customer` is the customer's own check of the quote. `avow` is
 * Avow's API refusing to approve the customer's reserve. `relay`, `lock` and `keychain` refused the
 * customer's reserve on its way to its lock, as they would any agent's, and `unknown` is a reserve
 * that never landed with no reason given.
 */
export const CUSTOMER_REFUSAL_LAYERS = [
  'customer',
  'avow',
  'relay',
  'lock',
  'keychain',
  'unknown',
] as const
export type CustomerRefusalLayer = (typeof CUSTOMER_REFUSAL_LAYERS)[number]

/** Why the customer refused a quote, who refused, and the block the refusing check read. */
export interface CustomerRefusal {
  code: ReasonCode
  layer: CustomerRefusalLayer
  /** The block the check that refused read at, or null when it refused before reading the chain. */
  block: PinnedBlock | null
  /** The booking relied on that failed, by its place in the terms, or null when none did alone. */
  index: number | null
}

/** The customer's reserve for a job, in its own lock. */
export interface CustomerReserve {
  reference: CommitmentReference
  /** In micros. */
  amount: bigint
}

/** Where an order stands, in the order it moves. */
export const ORDER_STATUSES = [
  'offered',
  'verifying',
  'refused',
  'reserved',
  'accepted',
  'delivered',
  'paid',
] as const
export type OrderStatus = (typeof ORDER_STATUSES)[number]

interface OrderBase {
  orderId: string
  commitmentId: Hex
  customer: JobCustomer
  /** The supplier the order was offered to. */
  supplierBusinessId: string
}

/**
 * Why a quote or a delivery report for an order can't be taken from this signer, or null when it
 * can. Only the signing key of the supplier the order was offered to can act on it.
 */
export function orderSignerProblem(
  offeredTo: Pick<SupplierProfile, 'signingKey'>,
  signer: Address,
): ReasonCode | null {
  return offeredTo.signingKey.toLowerCase() === signer.toLowerCase()
    ? null
    : 'order.supplier_mismatch'
}

/**
 * What GET `/v1/orders/{orderId}` answers. A refused order says why, and every order past the
 * customer's check lists each booking relied on with the block it was read at. From `reserved` on
 * it names the customer's reserve, and a paid order names the transfer, whose memo is the
 * commitment id. The reserve doesn't secure that payment.
 */
export type OrderState =
  | (OrderBase & { status: 'offered' | 'verifying' })
  | (OrderBase & { status: 'refused'; refusal: CustomerRefusal; checks: CheckedDependency[] })
  | (OrderBase & {
      status: 'reserved' | 'accepted' | 'delivered'
      checks: CheckedDependency[]
      reserve: CustomerReserve
    })
  | (OrderBase & {
      status: 'paid'
      checks: CheckedDependency[]
      reserve: CustomerReserve
      payment: PaymentReference
    })

/** What the two POSTs that move an order answer with their 202. */
export interface OrderAnswer {
  orderId: string
  status: 'verifying' | 'delivered'
}

/** An order id's JSON form. */
export const orderIdJson = z.string().regex(ORDER_ID)

/** The customer as JSON, labelled as Avow's test customer and nothing else. */
export const jobCustomerJson = z.strictObject({
  label: z.literal(TEST_CUSTOMER_LABEL),
  businessId: z.string().min(1).max(100),
})

export const testCustomerProfileJson = z.strictObject({
  ...jobCustomerJson.shape,
  account: address,
  lock: address,
  chainId: z.number().int().positive(),
  mandateHash: bytes32,
  limits: z.strictObject({
    reserve: u256,
    price: u256,
    openOrders: z.number().int().positive().max(100),
  }),
})

export const orderRequestJson = z.strictObject({ supplier: supplierProfileJson })

/** The booking a quote has to rely on, as JSON. */
export const jobRequirementJson = z.strictObject({
  template: z.literal(GPU_RESERVATION),
  condition: z.literal('accepted'),
  disclosed: z.literal('subject'),
})

const businessIdJson = z.string().min(1).max(100)

export const jobOfferJson = z.strictObject({
  orderId: orderIdJson,
  commitmentId: bytes32,
  customer: jobCustomerJson,
  supplierBusinessId: businessIdJson,
  terms: jobTermsJson,
  requirement: jobRequirementJson,
  expiry: u64,
})

export const quoteRequestJson = z.strictObject({
  terms: z.union([chainedJobTermsJson, jobTermsJson]),
  salt: bytes32,
  agreement: termsAgreementJson,
  supplierSignature: hexBytes,
  disclosed: z.array(z.unknown()).max(MAX_DEPENDENCIES),
})

/** A customer's refusal as JSON. */
export const customerRefusalJson = z.strictObject({
  code: reasonCodeJson,
  layer: z.enum(CUSTOMER_REFUSAL_LAYERS),
  block: pinnedBlockJson.nullable(),
  index: dependencyIndexJson,
})

const reserveJson = z.strictObject({ reference: commitmentReferenceJson, amount: u256 })
const checks = z.array(checkedDependencyJson).max(MAX_DEPENDENCIES)
const base = {
  orderId: orderIdJson,
  commitmentId: bytes32,
  customer: jobCustomerJson,
  supplierBusinessId: businessIdJson,
}

export const orderStateJson = z.discriminatedUnion('status', [
  z.strictObject({ ...base, status: z.literal('offered') }),
  z.strictObject({ ...base, status: z.literal('verifying') }),
  z.strictObject({ ...base, status: z.literal('refused'), refusal: customerRefusalJson, checks }),
  ...(['reserved', 'accepted', 'delivered'] as const).map((status) =>
    z.strictObject({ ...base, status: z.literal(status), checks, reserve: reserveJson }),
  ),
  z.strictObject({
    ...base,
    status: z.literal('paid'),
    checks,
    reserve: reserveJson,
    payment: paymentReferenceJson,
  }),
])

export const orderAnswerJson = z.strictObject({
  orderId: orderIdJson,
  status: z.enum(['verifying', 'delivered']),
})

/** Reads a JSON body with a schema, refusing anything else as `message.invalid`. */
function reader<T>(schema: z.ZodType<T>) {
  return (json: unknown): Parsed<T> => {
    const parsed = schema.safeParse(json)
    return parsed.success
      ? { ok: true, value: parsed.data }
      : { ok: false, reason: 'message.invalid' }
  }
}

/** Reads the customer's profile. */
export const parseTestCustomerProfile = reader<TestCustomerProfile>(testCustomerProfileJson)
/** Reads the body of a request for a new order, as the customer takes it. */
export const parseOrderRequest = reader<OrderRequest>(orderRequestJson)
/** Reads the customer's offer. */
export const parseJobOffer = reader<JobOffer>(jobOfferJson)
/** Reads the body of a quote, as the customer takes it. */
export const parseQuoteRequest = reader<QuoteRequest>(quoteRequestJson)
/** Reads where an order stands. */
export const parseOrderState = reader<OrderState>(orderStateJson)
/** Reads the answer to a quote or a delivery report. */
export const parseOrderAnswer = reader<OrderAnswer>(orderAnswerJson)
