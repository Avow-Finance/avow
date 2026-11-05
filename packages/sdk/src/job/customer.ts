import type { ReasonCode } from '@avow-finance/spec'
import {
  type DeliveryReport,
  type JobOffer,
  type OrderAnswer,
  type OrderState,
  type Parsed,
  parseApiError,
  parseJobOffer,
  parseOrderAnswer,
  parseOrderState,
  parseTestCustomerProfile,
  type QuoteRequest,
  type SupplierProfile,
  TEST_CUSTOMER_PATHS,
  type TestCustomerProfile,
} from '@avow-finance/spec'
import { type AvowRequestConfig, avowRequests } from '../http.js'

/** The test customer's refusal of a GET, or an answer to one that doesn't read. */
export class TestCustomerError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason: ReasonCode | null,
  ) {
    super(message)
    this.name = 'TestCustomerError'
  }
}

/**
 * Avow's test customer as the developer's job process reaches it. Orders arrive by pull: the
 * process asks for one, quotes it, polls it while the customer checks the quote and reserves, and
 * reports delivery. Every POST is signed with the supplier's signing key under the customer's lock,
 * and resent with the same bytes until the customer answers, as `avowRequests` does for Avow's API.
 */
export interface TestCustomer {
  /** The customer's profile, labelled as Avow's test customer, read when the client connected. */
  readonly profile: TestCustomerProfile
  /** Asks for a new order for this supplier, the developer's business as Avow registered it. */
  order(supplier: SupplierProfile): Promise<JobOffer>
  /** Sends the quote for an order. The customer answers while it checks it. */
  quote(orderId: string, quote: QuoteRequest): Promise<OrderAnswer>
  /** Where an order stands now. */
  state(orderId: string): Promise<OrderState>
  /** Reports the job delivered, handing over its result. The customer answers, then pays. */
  delivery(orderId: string, report: DeliveryReport): Promise<OrderAnswer>
}

/** What a test customer client needs: the signed-request settings and the chain expected. */
export interface TestCustomerConfig extends AvowRequestConfig {
  /** The chain the customer's lock has to be on. */
  chainId: number
}

/** Reads a GET's JSON, throwing the customer's refusal or an unreadable answer as an error. */
async function getJson<T>(
  url: string,
  fetchOnce: typeof fetch,
  read: (json: unknown) => Parsed<T>,
): Promise<T> {
  const answer = await fetchOnce(url, {
    redirect: 'error',
    headers: { accept: 'application/json' },
  })
  const json: unknown = await answer.json().catch(() => null)
  if (!answer.ok) {
    const refusal = parseApiError(json)
    const message = refusal?.message ?? `The test customer answered ${answer.status}`
    throw new TestCustomerError(message, answer.status, refusal?.reason ?? null)
  }
  const parsed = read(json)
  if (!parsed.ok) {
    throw new TestCustomerError(`The answer at ${url} doesn't read`, answer.status, parsed.reason)
  }
  return parsed.value
}

/**
 * Connects to Avow's test customer at `config.baseUrl`, the sandbox deployment's `customerUrl`,
 * with `config.key` the supplier's signing key. It reads the customer's profile first and refuses
 * one on another chain. An offer has to name the supplier that asked for it and the customer the
 * profile names, and an order's state has to be the order asked about.
 */
export async function connectTestCustomer(config: TestCustomerConfig): Promise<TestCustomer> {
  const fetchOnce = config.fetch ?? fetch
  const origin = new URL(config.baseUrl).origin
  const profile = await getJson(
    `${origin}${TEST_CUSTOMER_PATHS.profile}`,
    fetchOnce,
    parseTestCustomerProfile,
  )
  if (profile.chainId !== config.chainId) {
    throw new Error(`The test customer is on chain ${profile.chainId}, not ${config.chainId}`)
  }
  const send = avowRequests(config)
  const domain = { chainId: profile.chainId, verifyingContract: profile.lock }
  const fromThisCustomer = (businessId: string) => businessId === profile.businessId
  return {
    profile,
    order: (supplier) =>
      send({
        domain,
        path: TEST_CUSTOMER_PATHS.orders,
        body: { supplier },
        read: (json): Parsed<JobOffer> => {
          const offer = parseJobOffer(json)
          if (!offer.ok) return offer
          const ours =
            offer.value.supplierBusinessId === supplier.businessId &&
            fromThisCustomer(offer.value.customer.businessId)
          return ours ? offer : { ok: false, reason: 'message.invalid' }
        },
      }),
    quote: (orderId, quote) =>
      send({
        domain,
        path: TEST_CUSTOMER_PATHS.quote(orderId),
        body: quote,
        read: parseOrderAnswer,
      }),
    state: (orderId) =>
      getJson(`${origin}${TEST_CUSTOMER_PATHS.order(orderId)}`, fetchOnce, (json) => {
        const state = parseOrderState(json)
        if (!state.ok) return state
        return state.value.orderId === orderId ? state : { ok: false, reason: 'message.invalid' }
      }),
    delivery: (orderId, report) =>
      send({
        domain,
        path: TEST_CUSTOMER_PATHS.delivery(orderId),
        body: report,
        read: parseOrderAnswer,
      }),
  }
}
