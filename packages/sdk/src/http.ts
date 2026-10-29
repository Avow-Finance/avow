import {
  API_PATHS,
  API_REQUEST_MAX_VALIDITY,
  type ApiRequest,
  type AvowDomain,
  describeReason,
  type Enrollment,
  type EnrollmentRequest,
  encodeApiBody,
  isApiAudience,
  newRequestId,
  type Parsed,
  parseApiError,
  parseEnrollment,
  parseReserveApproval,
  parseSponsorship,
  parseSupplierAuthorizationAnswer,
  type ReasonCode,
  type RequestKey,
  type Signed,
  type SupplierAuthorizationAnswer,
  signApiRequest,
} from '@avow-finance/spec'
import type { Address, Hex } from 'viem'
import type { AgentKey } from './agent.js'
import type { AvowApi } from './avow-api.js'

/**
 * Avow's API refused a request, answered with something the client can't use, or gave no definite
 * answer in time. `status` is the HTTP status, 0 when no answer came, and `reason` the reason code
 * Avow gave, or the parser's reason for an answer that doesn't parse. `requestId` names the
 * operation. Sending the same signed bytes again is always safe, since Avow answers an identical
 * repeat without acting again.
 */
export class AvowApiError extends Error {
  readonly status: number
  readonly reason: ReasonCode | null
  readonly requestId: Hex

  constructor(
    message: string,
    details: { status: number; reason: ReasonCode | null; requestId: Hex },
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'AvowApiError'
    this.status = details.status
    this.reason = details.reason
    this.requestId = details.requestId
  }
}

export interface AvowRequestConfig {
  /**
   * The deployment's origin, such as `https://api.testnet.avow.finance`. It is the audience every
   * request is signed for, so it can't carry a path, query or fragment.
   */
  baseUrl: string
  /** The key that signs every request: an agent's through `agentRequestKey`, or a supplier's. */
  key: RequestKey
  /** Seconds each signed request stays valid, two minutes by default. Avow refuses more than five. */
  requestValidity?: bigint
  /**
   * Seconds the client keeps sending the same bytes while no definite answer comes, ten minutes by
   * default. It keeps going past the request's expiry, since Avow answers an identical repeat of a
   * request it has recorded, and says `message.expired` about one it never started.
   */
  retryFor?: bigint
  /** Milliseconds before the first resend, doubling up to 15 seconds. */
  retryWait?: number
  /** Milliseconds one attempt may take before it's abandoned and sent again, 30 seconds by default. */
  attemptTimeout?: number
  /** The clock, in unix seconds. The system clock by default. */
  now?: () => bigint
  fetch?: typeof fetch
  /** Receives each signed request, so the signer can keep the record of what it asked Avow. */
  onSigned?: (request: Signed<ApiRequest>) => void
}

export interface HttpAvowApiConfig extends AvowRequestConfig {
  /** The chain and lock the agent's mandate names. Every request is signed under this domain. */
  domain: AvowDomain
}

/** One operation for Avow's API. */
export interface AvowRequest<T> {
  /** The chain and lock the request is signed under. */
  domain: AvowDomain
  path: string
  body: unknown
  /**
   * Parses the JSON body of a 2xx answer, or gives the reason it can't. Avow answers a repeat with
   * the answer it recorded, so an answer this refuses would come back the same, and it's thrown at
   * once with that reason.
   */
  read: (json: unknown) => Parsed<T>
}

/** The agent's access key as a request signer: its own address and its bare signature. */
export function agentRequestKey(key: AgentKey): RequestKey {
  return {
    address: key.accessKeyAddress,
    signDigest: (hash) => key.sign({ hash, raw: true }),
  }
}

const MAX_WAIT = 15_000
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const describe = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300)
const systemClock = () => BigInt(Math.floor(Date.now() / 1000))

function readJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** The audience a base URL names, or a throw when it names more than an origin. */
function audienceOf(baseUrl: string): string {
  const url = new URL(baseUrl)
  if ((url.pathname !== '/' && url.pathname !== '') || url.search !== '' || url.hash !== '') {
    throw new RangeError(`${baseUrl} has to be an origin, with no path, query or fragment`)
  }
  if (url.username !== '' || url.password !== '') {
    throw new RangeError(`${baseUrl} can't carry a user name or password`)
  }
  if (!isApiAudience(url.origin)) {
    throw new RangeError(`${url.origin} isn't an http or https origin Avow can serve`)
  }
  return url.origin
}

/**
 * Sends operations to Avow's hosted API, each with a fresh request id and signed with `key` for the
 * deployment at `baseUrl`. It sends the same bytes again after no answer, an answer of any status
 * whose body isn't JSON, a 5xx or `request.in_progress`, until Avow answers definitely or
 * `retryFor` runs out. Avow answers with JSON whatever the status, so bytes that aren't JSON never
 * came whole from Avow. Avow answers an identical repeat with its first answer and does nothing
 * again, so a lost answer never turns into a second action. It never follows a redirect, so a
 * signed body goes nowhere but the deployment it was signed for. A refusal, which is any other 4xx
 * with a JSON body, a 2xx answer `read` refuses, or no definite answer in time, throws an
 * `AvowApiError` with the reason.
 */
export function avowRequests(config: AvowRequestConfig) {
  const audience = audienceOf(config.baseUrl)
  const { key } = config
  const validity = config.requestValidity ?? 120n
  if (validity <= 0n || validity > API_REQUEST_MAX_VALIDITY) {
    throw new RangeError(`A request can stay valid for 1 to ${API_REQUEST_MAX_VALIDITY} seconds`)
  }
  const retryFor = config.retryFor ?? 600n
  const firstWait = config.retryWait ?? 1000
  const attemptTimeout = config.attemptTimeout ?? 30_000
  const now = config.now ?? systemClock
  const fetchOnce = config.fetch ?? fetch

  return async function send<T>({ domain, path, body: value, read }: AvowRequest<T>): Promise<T> {
    const body = encodeApiBody(value)
    const requestId = newRequestId()
    const { authorization, request } = await signApiRequest({
      key,
      domain,
      audience,
      method: 'POST',
      path,
      body,
      requestId,
      expiry: now() + validity,
    })
    config.onSigned?.(request)
    const giveUpAt = now() + retryFor
    let wait = firstWait
    let last = 'no attempt was made'
    let lastStatus = 0
    let lastReason: ReasonCode | null = null
    for (;;) {
      try {
        const response = await fetchOnce(`${audience}${path}`, {
          method: 'POST',
          headers: { authorization, 'content-type': 'application/json' },
          body,
          redirect: 'error',
          signal: AbortSignal.timeout(attemptTimeout),
        })
        const json = readJson(await response.text())
        lastStatus = response.status
        if (json === undefined) {
          // Avow answers with JSON whatever the status, its refusals included, so bytes that aren't
          // JSON were cut off or replaced on their way, as by a proxy's error page, and go again.
          last = `The last answer was unreadable, a ${response.status} whose body isn't JSON.`
          lastReason = 'message.invalid'
        } else if (response.ok) {
          const answer = read(json)
          if (answer.ok) return answer.value
          throw new AvowApiError(`Avow's answer can't be used: ${describeReason(answer.reason)}`, {
            status: lastStatus,
            reason: answer.reason,
            requestId,
          })
        } else {
          const error = parseApiError(json)
          lastReason = error?.reason ?? null
          last = error?.message ?? `Avow's API answered ${response.status}`
          if (response.status < 500 && lastReason !== 'request.in_progress') {
            throw new AvowApiError(last, { status: lastStatus, reason: lastReason, requestId })
          }
        }
      } catch (e) {
        if (e instanceof AvowApiError) throw e
        last = `Avow's API didn't answer: ${describe(e)}`
        lastStatus = 0
        lastReason = null
      }
      if (now() >= giveUpAt) {
        throw new AvowApiError(`No definite answer from Avow. ${last}`, {
          status: lastStatus,
          reason: lastReason,
          requestId,
        })
      }
      await sleep(wait)
      wait = Math.min(wait * 2, MAX_WAIT)
    }
  }
}

/**
 * Avow's hosted API as an `AvowApi`, for an agent whose mandate names `domain`. Each call is one
 * operation sent through `avowRequests`, so a lost answer never turns into a second approval or a
 * second co-signature. It serves the reserve check and the relay, and has no `records` until Avow
 * serves its records of cancellations and job starts, so an agent made with it has no `cancel` or
 * `start` to call by accident.
 */
export function httpAvowApi(config: HttpAvowApiConfig): Omit<AvowApi, 'records'> {
  const send = avowRequests(config)
  const { domain } = config
  const expected = { chainId: domain.chainId, lock: domain.verifyingContract }

  return {
    approveReserve: (body) =>
      send({
        domain,
        path: API_PATHS.reserveApprovals,
        body,
        read: (json) => parseReserveApproval(json, expected),
      }),
    sponsor: (transaction) =>
      send({
        domain,
        path: API_PATHS.sponsorships,
        body: { transaction },
        read: (json) => {
          const parsed = parseSponsorship(json)
          return parsed.ok ? { ok: true, value: parsed.value.transaction } : parsed
        },
      }),
  }
}

/**
 * Enrolls an agent with Avow once its key is on the chain with the mandate's hash. The agent signs
 * the request with that key, under the mandate's chain and lock, and gets back what Avow recorded.
 */
export function enrollAgent(
  config: AvowRequestConfig,
  enrollment: EnrollmentRequest,
): Promise<Enrollment> {
  return avowRequests(config)({
    domain: { chainId: enrollment.mandate.chainId, verifyingContract: enrollment.mandate.lock },
    path: API_PATHS.enrollments,
    body: enrollment,
    read: parseEnrollment,
  })
}

/**
 * Asks Avow for a fresh authorization for a commitment's reserve, signed with the supplier's
 * signing key under the buyer's lock. Avow answers with its authorization, the approval the reserve
 * was funded under and the buyer's mandate, which the supplier's verifier checks before it accepts,
 * or with the reason it signed none, such as a reserve not funded yet.
 */
export function requestSupplierAuthorization(
  config: AvowRequestConfig,
  commitment: { chainId: number; lock: Address; commitmentId: Hex },
): Promise<SupplierAuthorizationAnswer> {
  const expected = { chainId: commitment.chainId, lock: commitment.lock }
  return avowRequests(config)({
    domain: { chainId: commitment.chainId, verifyingContract: commitment.lock },
    path: API_PATHS.supplierAuthorizations(commitment.commitmentId),
    body: {},
    read: (json) => parseSupplierAuthorizationAnswer(json, expected),
  })
}
