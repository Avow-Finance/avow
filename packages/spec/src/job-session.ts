import type { Hex } from 'viem'
import { z } from 'zod'
import {
  type CheckedDependency,
  checkedDependencyJson,
  dependencyIndexJson,
  MAX_DEPENDENCIES,
  type PinnedBlock,
  pinnedBlockJson,
} from './dependencies.js'
import { CHARGE_KINDS, type ChargeKind, RELEASE_REASONS, type ReleaseReason } from './eip712.js'
import type { JobSubject } from './job.js'
import { bytes32, u64, u256 } from './json-fields.js'
import type { ReasonCode } from './reasons.js'
import {
  type CommitmentReference,
  commitmentReferenceJson,
  type PaymentReference,
} from './references.js'
import { type AgentSource, agentSourceJson, reasonCodeJson, runJson } from './session-fields.js'
import {
  type CustomerRefusal,
  customerRefusalJson,
  type DeliveryResult,
  deliveryReportJson,
  type JobCustomer,
  type JobRequirement,
  jobCustomerJson,
  jobRequirementJson,
  orderIdJson,
} from './test-customer.js'
import { jobSubjectJson, paymentReferenceJson } from './wire.js'

/**
 * The events of one job, which the developer's job process posts to its session as they happen,
 * so the screen shows what the developer's code does. Each names the order it belongs to. In order
 * they are the order received, the compute secured, the quote sent, the customer verifying, the
 * customer verified or refused, the developer's own check of the customer's commitment passed or
 * refused, work started, delivered, the payment received and each reserve released.
 *
 * An event about the customer reports what the customer's order said, with each check's block, so
 * the screen can read the chain at that block itself. Every statement names the block it rests on
 * and says nothing beyond it.
 */

interface JobEventBase {
  run: number
  source: AgentSource
  orderId: string
}

/** Avow's test customer offered a job, which needs an accepted compute booking behind the quote. */
export interface JobOrderReceived extends JobEventBase {
  type: 'job_order_received'
  customer: JobCustomer
  work: JobSubject['work']
  /** The job's price in micros, paid by a separate transfer on delivery. */
  price: bigint
  deliverBy: bigint
  requirement: JobRequirement
}

/** The business booked compute for the job, and the GPU supplier accepted the booking. */
export interface JobComputeSecured extends JobEventBase {
  type: 'job_compute_secured'
  /** The compute booking, on the buyer side of the business's own lock. */
  reference: CommitmentReference
  /** The GPU supplier's business id. */
  supplier: string
  /** What the business reserved for it, in micros. */
  amount: bigint
  /** Until this moment the business can cancel the booking at no charge. */
  freeCancelBy: bigint
  /** When the reserve comes back if nobody releases or charges it before. */
  releaseDate: bigint
}

/** The developer's code quoted the job. */
export interface JobQuoteSent extends JobEventBase {
  type: 'job_quote_sent'
  termsHash: Hex
  /** The compute booking the quote names, or null when it names none. */
  compute: CommitmentReference | null
  price: bigint
}

/** The customer is checking the quote and the compute booking it names. */
export interface JobCustomerVerifying extends JobEventBase {
  type: 'job_customer_verifying'
}

/** The customer's check passed, with each booking relied on and the block it was read at. */
export interface JobCustomerVerified extends JobEventBase {
  type: 'job_customer_verified'
  checks: CheckedDependency[]
}

/** The customer refused the quote, or its reserve was refused on the way to its lock. */
export interface JobCustomerRefused extends JobEventBase {
  type: 'job_customer_refused'
  refusal: CustomerRefusal
}

/** One charge the job's terms let the supplier report, up to its cap in micros. */
export interface JobCharge {
  kind: ChargeKind
  amount: bigint
}

/**
 * The developer's code checked the customer's commitment and its reserve, and its acceptance
 * landed on the customer's lock. This is the moment work can begin.
 */
export interface JobCommitmentChecked extends JobEventBase {
  type: 'job_commitment_checked'
  /** The customer's commitment, on the buyer side of the customer's lock. */
  reference: CommitmentReference
  /** What the customer's reserve holds, in micros. */
  amount: bigint
  /** The charges the reserve backs, each with its cap. The job's price is never one. */
  charges: JobCharge[]
  releaseDate: bigint
  /** The compute booking as the acceptance check read it again, with its block. */
  checks: CheckedDependency[]
  /** The transaction that carried the acceptance, and its block. */
  acceptedIn: { transactionHash: Hex; blockNumber: bigint }
}

/**
 * Who refused the customer's commitment on the developer's side. `supplier` is the developer's own
 * check, and `relay` and `lock` refused the acceptance on its way to the customer's lock.
 */
export const COMMITMENT_REFUSAL_LAYERS = ['supplier', 'relay', 'lock'] as const
export type CommitmentRefusalLayer = (typeof COMMITMENT_REFUSAL_LAYERS)[number]

/** The developer's code refused the customer's commitment, so no work starts. */
export interface JobCommitmentRefused extends JobEventBase {
  type: 'job_commitment_refused'
  code: ReasonCode
  layer: CommitmentRefusalLayer
  /** The block the refusing check read, or null when it refused before reading the chain. */
  block: PinnedBlock | null
  /** The booking relied on that failed, by its place in the terms, or null when none did alone. */
  index: number | null
}

/** Work started, at or after the moment the customer's free cancellation ended. */
export interface JobWorkStarted extends JobEventBase {
  type: 'job_work_started'
  reference: CommitmentReference
}

/**
 * The developer's code reported delivery to the customer, handing over the result. The work is
 * simulated, so the result is a placeholder whose label says so, with the hash of its content.
 */
export interface JobDelivered extends JobEventBase {
  type: 'job_delivered'
  reference: CommitmentReference
  result: DeliveryResult
}

/** The customer paid the price, by a transfer whose memo is the job's commitment id. */
export interface JobPaid extends JobEventBase {
  type: 'job_paid'
  payment: PaymentReference
}

/** How a reserve came back. A consent carries the reason the supplier gave, as it gave it. */
export type JobRelease =
  | { way: 'consent'; reason: ReleaseReason }
  | { way: 'free_cancellation' }
  | { way: 'release_date' }
  | { way: 'unaccepted' }

/** A reserve of the job came back to the business that made it. */
export interface JobReserveReleased extends JobEventBase {
  type: 'job_reserve_released'
  /** `job` is the customer's reserve for the job, and `compute` the business's for its compute. */
  role: 'job' | 'compute'
  reference: CommitmentReference
  release: JobRelease
  transactionHash: Hex
}

/** One event of a job, as its session's screen shows it. */
export type JobEvent =
  | JobOrderReceived
  | JobComputeSecured
  | JobQuoteSent
  | JobCustomerVerifying
  | JobCustomerVerified
  | JobCustomerRefused
  | JobCommitmentChecked
  | JobCommitmentRefused
  | JobWorkStarted
  | JobDelivered
  | JobPaid
  | JobReserveReleased

const base = { run: runJson, source: agentSourceJson, orderId: orderIdJson }
const checks = z.array(checkedDependencyJson).max(MAX_DEPENDENCIES)
const chargeKind = z.enum(Object.keys(CHARGE_KINDS) as [ChargeKind, ...ChargeKind[]])
const releaseReason = z.enum(Object.keys(RELEASE_REASONS) as [ReleaseReason, ...ReleaseReason[]])

/** Each job event's JSON form, which the session's event schema takes alongside its own. */
export const JOB_EVENT_SCHEMAS = [
  z.strictObject({
    ...base,
    type: z.literal('job_order_received'),
    customer: jobCustomerJson,
    work: jobSubjectJson.shape.work,
    price: u256,
    deliverBy: u64,
    requirement: jobRequirementJson,
  }),
  z.strictObject({
    ...base,
    type: z.literal('job_compute_secured'),
    reference: commitmentReferenceJson,
    supplier: z.string().min(1).max(100),
    amount: u256,
    freeCancelBy: u64,
    releaseDate: u64,
  }),
  z.strictObject({
    ...base,
    type: z.literal('job_quote_sent'),
    termsHash: bytes32,
    compute: commitmentReferenceJson.nullable(),
    price: u256,
  }),
  z.strictObject({ ...base, type: z.literal('job_customer_verifying') }),
  z.strictObject({ ...base, type: z.literal('job_customer_verified'), checks }),
  z.strictObject({
    ...base,
    type: z.literal('job_customer_refused'),
    refusal: customerRefusalJson,
  }),
  z.strictObject({
    ...base,
    type: z.literal('job_commitment_checked'),
    reference: commitmentReferenceJson,
    amount: u256,
    charges: z
      .array(z.strictObject({ kind: chargeKind, amount: u256 }))
      .min(1)
      .max(4),
    releaseDate: u64,
    checks,
    acceptedIn: z.strictObject({ transactionHash: bytes32, blockNumber: u64 }),
  }),
  z.strictObject({
    ...base,
    type: z.literal('job_commitment_refused'),
    code: reasonCodeJson,
    layer: z.enum(COMMITMENT_REFUSAL_LAYERS),
    block: pinnedBlockJson.nullable(),
    index: dependencyIndexJson,
  }),
  z.strictObject({
    ...base,
    type: z.literal('job_work_started'),
    reference: commitmentReferenceJson,
  }),
  z.strictObject({
    ...base,
    type: z.literal('job_delivered'),
    reference: commitmentReferenceJson,
    result: deliveryReportJson.shape.result,
  }),
  z.strictObject({ ...base, type: z.literal('job_paid'), payment: paymentReferenceJson }),
  z.strictObject({
    ...base,
    type: z.literal('job_reserve_released'),
    role: z.enum(['job', 'compute']),
    reference: commitmentReferenceJson,
    release: z.discriminatedUnion('way', [
      z.strictObject({ way: z.literal('consent'), reason: releaseReason }),
      z.strictObject({ way: z.literal('free_cancellation') }),
      z.strictObject({ way: z.literal('release_date') }),
      z.strictObject({ way: z.literal('unaccepted') }),
    ]),
    transactionHash: bytes32,
  }),
] as const

/** Every job event type, in the order a job that runs to the end posts them. */
export const JOB_EVENT_TYPES = [
  'job_order_received',
  'job_compute_secured',
  'job_quote_sent',
  'job_customer_verifying',
  'job_customer_verified',
  'job_customer_refused',
  'job_commitment_checked',
  'job_commitment_refused',
  'job_work_started',
  'job_delivered',
  'job_paid',
  'job_reserve_released',
] as const satisfies readonly JobEvent['type'][]

// Every job event has a schema, and every schema is a job event.
type SchemaType = (typeof JOB_EVENT_SCHEMAS)[number]['shape']['type']['value']
const _sameTypes: [SchemaType, JobEvent['type']] extends [JobEvent['type'], SchemaType]
  ? true
  : { types: SchemaType } = true
void _sameTypes
