import {
  API_AUDIENCE_PATTERN,
  API_PATHS,
  API_REQUEST_MAX_VALIDITY,
  type ApiRequest,
  type AvowDomain,
  newRequestId,
  parseApiError,
  parseReserveApproval,
  parseSponsorship,
  type ReasonCode,
  type RequestKey,
  type Signed,
  signApiRequest,
  toWire,
} from '@avow-finance/spec'
import type { AgentKey } from './agent.js'
import type { AvowApi } from './avow-api.js'

/**
 * Avow's API refused a request or couldn't be reached. `status` is the HTTP status, 0 when no
 * answer came, and `reason` the reason code Avow gave, when it gave one.
 */
export class AvowApiError extends Error {
  readonly status: number
  readonly reason: ReasonCode | null

  constructor(
    message: string,
    status: number,
    reason: ReasonCode | null,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'AvowApiError'
    this.status = status
    this.reason = reason
  }
}

export interface HttpAvowApiConfig {
  /** Avow's API, such as `https://api.testnet.avow.finance`. Each request is signed for its origin. */
  baseUrl: string
  /** The key that signs every request, the agent's own through `agentRequestKey`. */
  key: RequestKey
  /** The chain and lock the agent's mandate names. Every request is signed under this domain. */
  domain: AvowDomain
  /** Seconds each signed request stays valid, two minutes by default. Avow refuses more than five. */
  requestValidity?: bigint
  /** How many times the same signed bytes go again after no answer, a 5xx or `request.in_progress`. */
  retries?: number
  /** Milliseconds between those tries. */
  retryWait?: number
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const describe = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300)
const systemClock = () => BigInt(Math.floor(Date.now() / 1000))

function readJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * Avow's hosted API as an `AvowApi`. Each call is one operation with a fresh request id, signed with
 * the agent's key for the deployment at `baseUrl`. When no answer comes, or Avow answers with a 5xx
 * or says it's still answering, the client sends the same bytes again while the request is valid.
 * Avow answers an identical repeat with its first answer and repeats nothing, so a lost answer never
 * turns into a second approval or a second co-signature. Cancelling and starting a job come with the
 * start-request and cancellation records, and until then those calls throw.
 */
export function httpAvowApi(config: HttpAvowApiConfig): AvowApi {
  // The audience is the origin of the configured URL, which the URL parser writes in lower case.
  const origin = new URL(config.baseUrl).origin
  if (!API_AUDIENCE_PATTERN.test(origin)) {
    throw new RangeError(`${origin} isn't an http or https origin Avow can serve`)
  }
  const { key, domain } = config
  const validity = config.requestValidity ?? 120n
  if (validity <= 0n || validity > API_REQUEST_MAX_VALIDITY) {
    throw new RangeError(`A request can stay valid for 1 to ${API_REQUEST_MAX_VALIDITY} seconds`)
  }
  const retries = config.retries ?? 4
  const retryWait = config.retryWait ?? 1000
  const now = config.now ?? systemClock
  const send = config.fetch ?? fetch
  const expected = { chainId: domain.chainId, lock: domain.verifyingContract }

  async function post(path: string, body: unknown): Promise<unknown> {
    const bytes = new TextEncoder().encode(JSON.stringify(toWire(body)))
    const expiry = now() + validity
    const { authorization, request } = await signApiRequest({
      key,
      domain,
      audience: origin,
      method: 'POST',
      path,
      body: bytes,
      requestId: newRequestId(),
      expiry,
    })
    config.onSigned?.(request)
    for (let attempt = 0; ; attempt++) {
      // Decided after each try, since the request may have expired while it was out.
      const again = () => attempt < retries && now() < expiry
      let response: Response
      try {
        response = await send(`${origin}${path}`, {
          method: 'POST',
          headers: { authorization, 'content-type': 'application/json' },
          body: bytes,
        })
      } catch (e) {
        if (again()) {
          await sleep(retryWait)
          continue
        }
        throw new AvowApiError(`Avow's API didn't answer: ${describe(e)}`, 0, null, { cause: e })
      }
      const json = readJson(await response.text())
      if (response.ok) return json
      const error = parseApiError(json)
      const reason = error.ok ? error.value.error.reason : null
      if (again() && (response.status >= 500 || reason === 'request.in_progress')) {
        await sleep(retryWait)
        continue
      }
      const message = error.ok
        ? error.value.error.message
        : `Avow's API answered ${response.status}`
      throw new AvowApiError(message, response.status, reason)
    }
  }

  const unreadable = (reason: ReasonCode) =>
    new AvowApiError(`Avow's answer doesn't parse (${reason})`, 200, reason)
  const notYet = (what: string) => async () => {
    throw new Error(`Avow's hosted API doesn't ${what} yet`)
  }

  return {
    async approveReserve(request) {
      const parsed = parseReserveApproval(await post(API_PATHS.reserveApprovals, request), expected)
      if (!parsed.ok) throw unreadable(parsed.reason)
      return parsed.value
    },
    async sponsor(transaction) {
      const parsed = parseSponsorship(await post(API_PATHS.sponsorships, { transaction }))
      if (!parsed.ok) throw unreadable(parsed.reason)
      return parsed.value.transaction
    },
    cancel: notYet('record cancellations'),
    requestStart: notYet('timestamp start requests'),
    recordStart: notYet('record start receipts'),
  }
}
