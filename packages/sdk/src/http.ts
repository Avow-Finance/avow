import {
  API_PATHS,
  API_REQUEST_MAX_VALIDITY,
  type ApiRequest,
  type AvowDomain,
  encodeApiBody,
  isApiAudience,
  newRequestId,
  parseApiError,
  parseReserveApproval,
  parseSponsorship,
  type ReasonCode,
  type RequestKey,
  type Signed,
  signApiRequest,
} from '@avow-finance/spec'
import type { Hex } from 'viem'
import type { AgentKey } from './agent.js'
import type { AvowApi } from './avow-api.js'

/**
 * Avow's API refused a request, or no definite answer came in time. `status` is the HTTP status,
 * 0 when no answer came, and `reason` the reason code Avow gave, when it gave one. `requestId`
 * names the operation. Sending the same signed bytes again is always safe, since Avow answers an
 * identical repeat without acting again.
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

export interface HttpAvowApiConfig {
  /**
   * The deployment's origin, such as `https://api.testnet.avow.finance`. It is the audience every
   * request is signed for, so it can't carry a path, query or fragment.
   */
  baseUrl: string
  /** The key that signs every request, the agent's own through `agentRequestKey`. */
  key: RequestKey
  /** The chain and lock the agent's mandate names. Every request is signed under this domain. */
  domain: AvowDomain
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
  /** Receives each signed request, so the agent can keep the record of what it asked Avow. */
  onSigned?: (request: Signed<ApiRequest>) => void
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
 * Avow's hosted API as an `AvowApi`. Each call is one operation with a fresh request id, signed with
 * the agent's key for the deployment at `baseUrl`. The client sends the same bytes again after no
 * answer, a broken answer, a 5xx or `request.in_progress`, until Avow answers definitely or
 * `retryFor` runs out. Avow answers an identical repeat with its first answer and does nothing
 * again, so a lost answer never turns into a second approval or a second co-signature. It never
 * follows a redirect, so a signed body goes nowhere but the deployment it was signed for.
 * Cancelling and starting a job come with the start-request and cancellation records, and until
 * then those calls throw.
 */
export function httpAvowApi(config: HttpAvowApiConfig): AvowApi {
  const audience = audienceOf(config.baseUrl)
  const { key, domain } = config
  const validity = config.requestValidity ?? 120n
  if (validity <= 0n || validity > API_REQUEST_MAX_VALIDITY) {
    throw new RangeError(`A request can stay valid for 1 to ${API_REQUEST_MAX_VALIDITY} seconds`)
  }
  const retryFor = config.retryFor ?? 600n
  const firstWait = config.retryWait ?? 1000
  const attemptTimeout = config.attemptTimeout ?? 30_000
  const now = config.now ?? systemClock
  const send = config.fetch ?? fetch
  const expected = { chainId: domain.chainId, lock: domain.verifyingContract }

  /**
   * Sends one operation until Avow answers it definitely, and returns the answer `read` parses.
   * `read` returns null for a body it can't parse, which counts as no answer.
   */
  async function post<T>(
    path: string,
    value: unknown,
    read: (json: unknown) => T | null,
  ): Promise<T> {
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
        const response = await send(`${audience}${path}`, {
          method: 'POST',
          headers: { authorization, 'content-type': 'application/json' },
          body,
          redirect: 'error',
          signal: AbortSignal.timeout(attemptTimeout),
        })
        const json = readJson(await response.text())
        lastStatus = response.status
        if (response.ok) {
          const answer = read(json)
          if (answer !== null) return answer
          last = "Avow's answer doesn't parse"
          lastReason = 'message.invalid'
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

  const notYet = (what: string) => async () => {
    throw new Error(`Avow's hosted API doesn't ${what} yet`)
  }

  return {
    approveReserve: (request) =>
      post(API_PATHS.reserveApprovals, request, (json) => {
        const parsed = parseReserveApproval(json, expected)
        return parsed.ok ? parsed.value : null
      }),
    sponsor: (transaction) =>
      post(API_PATHS.sponsorships, { transaction }, (json) => {
        const parsed = parseSponsorship(json)
        return parsed.ok ? parsed.value.transaction : null
      }),
    cancel: notYet('record cancellations'),
    requestStart: notYet('timestamp start requests'),
    recordStart: notYet('record start receipts'),
  }
}
