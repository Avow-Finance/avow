import type { Address, Hex } from 'viem'
import { z } from 'zod'
import { canonicalJson } from './canonical.js'
import {
  type CheckedDependency,
  checkedDependencyJson,
  dependencyIndexJson,
  isChainedTerms,
  MAX_DEPENDENCIES,
  type PinnedBlock,
  pinnedBlockJson,
} from './dependencies.js'
import type { TermsAgreement } from './eip712.js'
import { type FactBody, factBodyShape } from './facts.js'
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
import { plainTermsOf } from './terms.js'
import type { SupplierProfile } from './types.js'
import {
  chainedJobTermsJson,
  jobTermsJson,
  type Parsed,
  paymentReferenceJson,
  termsAgreementJson,
  toWire,
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
  /** POST, signed, with a `DeliveryReport` as the body. Reports delivery, answered with 202. */
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
  /** How the order should go, when the developer asks for one. Left out, the job runs to payment. */
  scenario?: OrderScenario | undefined
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
 * that never landed with no reason given. `supplier` is the developer's business never accepting
 * the customer's reserve by its deadline, as with `supplier.not_accepted`.
 */
export const CUSTOMER_REFUSAL_LAYERS = [
  'customer',
  'supplier',
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
  /** The transaction that funded the reserve, which the customer's reserve fact names. */
  fundedIn: Hex
}

/**
 * Something the customer said about an order, as a message, numbered from 0 in the order said. The
 * developer's session posts each one once, by its index, as the customer's speech, and never as
 * evidence.
 */
export interface CustomerSaid {
  index: number
  text: string
}

/**
 * A fact the customer's verifier stated about an order, numbered from 0, with what it rests on. The
 * developer's session posts each one once, by its index, as the customer's statement, and a reader
 * checks it from the chain before showing it as verified.
 */
export interface CustomerFact extends FactBody {
  index: number
  verifiedBy: 'customer'
}

/** The longest message the customer says. */
export const CUSTOMER_SAID_MAX = 500

/** The most messages or facts one order carries. */
export const ORDER_STATEMENTS_MAX = 32

/** The label of the result a delivery hands over, which says plainly that it's a placeholder. */
export const SIMULATED_RESULT_LABEL =
  'Simulated fine-tuning result, a placeholder, since no model was trained'

/**
 * The result a delivery hands over. The work is simulated, so it's a placeholder whose label is the
 * one plain label, with the hash of its content.
 */
export interface DeliveryResult {
  label: typeof SIMULATED_RESULT_LABEL
  hash: Hex
}

/** The body of POST `/v1/orders/{orderId}/delivery`. */
export interface DeliveryReport {
  result: DeliveryResult
}

/** Where an order stands, in the order it moves. */
export const ORDER_STATUSES = [
  'offered',
  'verifying',
  'refused',
  'reserved',
  'accepted',
  'cancelled',
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
  /** What the customer has said about the order so far, in order. */
  said: CustomerSaid[]
  /** The facts the customer's verifier has stated about the order so far, in order. */
  facts: CustomerFact[]
}

/**
 * Why a quote or a delivery report for an order can't be taken from this signer, or null when it
 * can. Only the supplier the order was offered to can act on it, through the signing key Avow
 * registered for that supplier, so the order's supplier, the registered profile and the signer are
 * checked together, and a key registered for another supplier never acts on this order.
 */
export function orderSignerProblem(
  order: { supplierBusinessId: string },
  registered: Pick<SupplierProfile, 'businessId' | 'signingKey'>,
  signer: Address,
): ReasonCode | null {
  const offeredTo = order.supplierBusinessId === registered.businessId
  const theirKey = registered.signingKey.toLowerCase() === signer.toLowerCase()
  return offeredTo && theirKey ? null : 'order.supplier_mismatch'
}

/**
 * How an order is asked to go, for a developer who wants to see a promise broken. A test customer
 * asked for `cancels_late` cancels the job shortly after its work starts, which its reserve backs.
 */
export const ORDER_SCENARIOS = ['cancels_late'] as const
export type OrderScenario = (typeof ORDER_SCENARIOS)[number]

/**
 * The customer's word that it cancelled a job after its start, with the time Avow recorded for its
 * signed request. Avow confirms a late-cancellation charge from its own record of that request and
 * never from this statement.
 */
export interface OrderCancellation {
  cancelledAt: bigint
}

/**
 * What GET `/v1/orders/{orderId}` answers. A refused order says why, and every order past the
 * customer's check lists each booking relied on with the block it was read at. From `reserved` on
 * it names the customer's reserve, and a paid order names the transfer, whose memo is the
 * commitment id. The reserve doesn't secure that payment. A cancelled order says when the customer
 * cancelled, after the job's start, so the supplier can report the charge its terms allow.
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
      status: 'cancelled'
      checks: CheckedDependency[]
      reserve: CustomerReserve
      cancellation: OrderCancellation
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

export const orderRequestJson = z.strictObject({
  supplier: supplierProfileJson,
  scenario: z.enum(ORDER_SCENARIOS).optional(),
})

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

const reserveJson = z.strictObject({
  reference: commitmentReferenceJson,
  amount: u256,
  fundedIn: bytes32,
})
const checks = z.array(checkedDependencyJson).max(MAX_DEPENDENCIES)

/** Statements numbered from 0, each index once and in order, so a reader posts each exactly once. */
const numbered = <T extends { index: number }>(item: z.ZodType<T>) =>
  z
    .array(item)
    .max(ORDER_STATEMENTS_MAX)
    .refine((list) => list.every((s, i) => s.index === i), 'indexes 0, 1, 2 and so on, in order')

export const customerSaidJson = z.strictObject({
  index: z
    .number()
    .int()
    .min(0)
    .max(ORDER_STATEMENTS_MAX - 1),
  text: z.string().min(1).max(CUSTOMER_SAID_MAX),
})

export const customerFactJson = z.strictObject({
  index: z
    .number()
    .int()
    .min(0)
    .max(ORDER_STATEMENTS_MAX - 1),
  ...factBodyShape,
  verifiedBy: z.literal('customer'),
})

const base = {
  orderId: orderIdJson,
  commitmentId: bytes32,
  customer: jobCustomerJson,
  supplierBusinessId: businessIdJson,
  said: numbered(customerSaidJson),
  facts: numbered(customerFactJson),
}

export const deliveryReportJson = z.strictObject({
  result: z.strictObject({ label: z.literal(SIMULATED_RESULT_LABEL), hash: bytes32 }),
})

export const orderStateJson = z.discriminatedUnion('status', [
  z.strictObject({ ...base, status: z.literal('offered') }),
  z.strictObject({ ...base, status: z.literal('verifying') }),
  z.strictObject({ ...base, status: z.literal('refused'), refusal: customerRefusalJson, checks }),
  ...(['reserved', 'accepted', 'delivered'] as const).map((status) =>
    z.strictObject({ ...base, status: z.literal(status), checks, reserve: reserveJson }),
  ),
  z.strictObject({
    ...base,
    status: z.literal('cancelled'),
    checks,
    reserve: reserveJson,
    cancellation: z.strictObject({ cancelledAt: u64 }),
  }),
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

/**
 * Why a quote's terms aren't the offer's, or null when they are. A quote may add the bookings the
 * job relies on, which makes its terms version 3 with a setting for who checks them, and may change
 * nothing else. Anything more is `order.terms_changed`.
 */
export function quoteTermsProblem(
  offered: JobTerms,
  quoted: ChainedJobTerms | JobTerms,
): ReasonCode | null {
  const plain = isChainedTerms(quoted) ? plainTermsOf(quoted) : quoted
  try {
    return canonicalJson(toWire(plain)) === canonicalJson(toWire(offered))
      ? null
      : 'order.terms_changed'
  } catch {
    return 'order.terms_changed'
  }
}

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
/** Reads the body of a delivery report, as the customer takes it. */
export const parseDeliveryReport = reader<DeliveryReport>(deliveryReportJson)
