import type {
  BuyerSideReference,
  ChargeKind,
  ChargePauseCause,
  ComputeOffer,
  ComputeOffers,
  DeliveryResult,
  GpuReservationTerms,
  JobOffer,
  OrderScenario,
  OrderState,
  PinnedBlock,
  QuoteRequest,
  RailState,
  ReasonCode,
  RefusalAmounts,
  RefusalLayer,
  TestCustomerProfile,
} from '@avow-finance/spec'
import type { Hex } from 'viem'
import type { JobAcceptance } from '../job/accept.js'
import type { ReservedJob } from './service.js'
import type { ChainSnapshot } from './service-check.js'

/**
 * Everything the agent session does to the outside world, behind one seam. The live sandbox
 * implements it with the SDK, Avow's API, the test customer and Tempo's testnet. The fixture world
 * implements it in memory with the same rules for tests and the eval, and anything it draws says
 * so. The tool layer, the executor and the session run the same code against either. Nothing here
 * hands out a key, and every result is public data.
 */
export interface JobWorld {
  /** `live` on testnet, or `fixture` in memory for tests and the eval. */
  readonly kind: 'live' | 'fixture'
  /** Avow's test customer, as its profile names it. */
  readonly customer: TestCustomerProfile
  /** The supplier the agent books compute from. */
  readonly computeSupplier: string
  /** The business as the job's supplier, which the customer's lock has to name. */
  readonly supplier: ReservedJob['supplier']
  /** The token the business's and the customer's locks hold. */
  readonly token: ReservedJob['token']
  /**
   * Asks the test customer for a new order. With a scenario, the customer plays it out, as when it
   * cancels the job after its start.
   */
  pullOrder(scenario?: OrderScenario): Promise<JobOffer>
  /** The compute supplier's offers for an order's window. */
  offers(order: JobOffer): Promise<ComputeOffers>
  /**
   * Books `gpus` of an offer through the SDK, which checks the mandate, has Avow approve, funds the
   * reserve and waits for the supplier's acceptance. A refusal names its layer, and no money moved.
   */
  book(offer: ComputeOffer, gpus: number): Promise<BookOutcome>
  /** The agent's authority now, from the lock and the account's keychain. */
  authority(): Promise<AuthorityNow>
  /** Reads a commitment on its lock at the latest finalized block. */
  read(reference: BuyerSideReference): Promise<LockRead | null>
  /**
   * Quotes an order with terms naming the booking, or none, signed by the supplier signing key. A
   * refusal is the customer's, before it started checking.
   */
  quote(order: JobOffer, booking: WorldBooking | null): Promise<QuoteOutcome>
  /** Where an order stands now, as the test customer reports it. */
  orderState(orderId: string): Promise<OrderState>
  /**
   * Checks the customer's commitment again with Avow's authorization and accepts it on the
   * customer's lock, as `acceptJob` does. A send whose outcome is unknown throws.
   */
  accept(order: JobOffer, quote: QuoteRequest): Promise<JobAcceptance>
  /** Which of these transactions landed and succeeded, with its block, or null for none. */
  landed(hashes: readonly Hex[]): Promise<{ transactionHash: Hex; blockNumber: bigint } | null>
  /** Reports delivery, handing over the result. */
  deliver(orderId: string, result: DeliveryResult): Promise<void>
  /**
   * Reports a charge of one kind on the customer's reserve for an order, for the most the job's
   * terms allow, signed by the supplier signing key. The verifier builds the report only when the
   * lock would take it. A send whose outcome is unknown throws.
   */
  reportCharge(order: JobOffer, kind: ChargeKind): Promise<ChargeReport>
  /** Where a report stands on the customer's lock now. */
  charge(order: JobOffer, report: ReportedCharge): Promise<ChargeStanding>
  /**
   * Cancels a booking on the lock, which needs the business's root key, or says why it can't here.
   */
  cancel(booking: WorldBooking): Promise<CancelOutcome>
  /** Where `checkBeforeWork` reads the chain from, in its own process. */
  chainFor(job: ReservedJob): Promise<ChildChain>
  /** The clock, in unix seconds. */
  now(): bigint
  /** Waits, so a fixture world can run its clock instead. */
  sleep(ms: number): Promise<void>
}

/**
 * Where the process that runs `checkBeforeWork` reads the chain. A live run gives it Tempo's RPC
 * to read for itself. The fixture world's chain lives in memory, so it hands over what it holds at
 * one block, which the checks read through the same interfaces.
 */
export type ChildChain =
  | { kind: 'rpc'; url: string; chainId: number; factory: Hex }
  | { kind: 'snapshot'; snapshot: ChainSnapshot }

/** A compute booking the session made, with what anyone can check about it. */
export interface WorldBooking {
  /** The session's own name for it, which the model uses. */
  id: string
  offer: ComputeOffer
  gpus: number
  reference: BuyerSideReference
  terms: GpuReservationTerms
  salt: Hex
  /** The reserve, in micros. */
  reserve: bigint
  /** The usage price for the whole window, in micros, paid apart from the reserve. */
  price: bigint
  /** The transaction that funded the reserve, when the chain showed it. */
  reservedIn: Hex | null
  /** The booking on its lock once the supplier accepted, as read then. */
  read: LockRead
}

/** A commitment as its lock held it at one block. */
export interface LockRead {
  state: RailState
  block: PinnedBlock
  freeCancelBy: bigint
  releaseDate: bigint
}

export type BookOutcome =
  | { ok: true; booking: Omit<WorldBooking, 'id'> }
  | { ok: false; code: ReasonCode; layer: RefusalLayer; amounts: RefusalAmounts }

export type QuoteOutcome =
  | { ok: true; quote: QuoteRequest }
  | { ok: false; code: ReasonCode; layer: 'customer' | 'service' }

/** A report the customer's lock took. */
export interface ReportedCharge {
  /** The charge reported, in micros. */
  amount: bigint
  /** Which of the commitment's reports it is, 1 or 2. */
  reportNumber: number
  transactionHash: Hex
  /** The time of the block the report landed in, which Avow's deadline to answer counts from. */
  reportedAt: bigint
}

export type ChargeReport =
  | ({ ok: true } & ReportedCharge)
  | { ok: false; code: ReasonCode; layer: 'service' | 'lock' }

/**
 * Where a reported charge stands. `waiting` is a report Avow hasn't answered. `confirmed` is one
 * Avow confirmed, which the customer can contest until `contestableUntil` and which is payable
 * then. `paused` waits for a ruling. `paid` reached the business, and `ended` is a report withdrawn
 * or a commitment that ended another way.
 */
export type ChargeStanding =
  | { state: 'waiting' }
  | { state: 'confirmed'; contestableUntil: bigint }
  | { state: 'paused'; cause: ChargePauseCause }
  | { state: 'paid' }
  | { state: 'ended' }

export type CancelOutcome =
  | { ok: true; transactionHash: Hex }
  | { ok: false; code: ReasonCode; layer: RefusalLayer; why: string }

/** The agent's limits now, in micros. */
export interface AuthorityNow {
  capPerCommitment: bigint
  capOpenReserves: bigint
  openReservesLeft: bigint
  dailyLimit: bigint | null
  dailyLeft: bigint | null
  suppliers: readonly string[]
}
