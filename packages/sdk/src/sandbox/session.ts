import {
  type AvowDomain,
  type CommitmentReference,
  encodeCommitmentReference,
  isSessionId,
  parseSessionEventAnswer,
  type RequestKey,
  SANDBOX_PATHS,
  type SessionEvent,
  type SessionEventAnswer,
} from '@avow-finance/spec'
import { type Address, isAddress } from 'viem'
import { type AvowRequestConfig, avowRequests } from '../http.js'

/** The testnet sandbox's screen, which shows a session's events and checks a shared commitment. */
export const SANDBOX_SCREEN_URL = 'https://try.testnet.avow.finance'

/** The screen's own origin, without the trailing slash a pasted URL may carry. */
const screenOrigin = (screenUrl: string) => new URL(screenUrl).origin

/** The link to the screen that shows a session's events as they arrive. */
export function sessionUrl(sessionId: string, screenUrl: string = SANDBOX_SCREEN_URL): string {
  if (!isSessionId(sessionId)) throw new RangeError(`${sessionId} isn't a session id`)
  return `${screenOrigin(screenUrl)}/#session=${sessionId}`
}

/**
 * The link anyone can open to check a commitment against the lock it names. Its fragment carries
 * the commitment reference as `encodeCommitmentReference` writes it, and never reaches a server.
 */
export function verifyUrl(
  reference: CommitmentReference,
  screenUrl: string = SANDBOX_SCREEN_URL,
): string {
  return `${screenOrigin(screenUrl)}/#verify=${encodeCommitmentReference(reference)}`
}

export interface SessionRelayConfig extends Omit<AvowRequestConfig, 'key'> {
  /** The session the screen at `sessionUrl(sessionId)` shows. */
  sessionId: string
  /**
   * The key that signs each event, so Avow's API can tell it comes from a registered sandbox
   * business before it relays it to the screen. The agent's process signs with the agent's key,
   * through `agentRequestKey`, and only the runner signs an authority change with the business's
   * root key, through `rootRequestKey`.
   */
  key: RequestKey
  /** The chain and the business's lock, which each event's request is signed under. */
  domain: AvowDomain
}

/** Posts a sandbox business's events to one session. */
export interface SessionRelay {
  readonly sessionId: string
  /** Posts one event and gives its place in the session, counting from 1. */
  post(event: SessionEvent): Promise<SessionEventAnswer>
}

/**
 * Avow's relay for one session's events. Each event is one request through `avowRequests`, signed
 * by `key` under the business's lock, so a lost answer never posts the same event twice. It stops resending after 20 seconds by default, since a screen that shows an event late
 * helps no one, and a refusal throws an `AvowApiError` with Avow's reason.
 */
export function sessionRelay(config: SessionRelayConfig): SessionRelay {
  const { sessionId, key, domain, ...request } = config
  const path = SANDBOX_PATHS.sessionEvents(sessionId)
  const send = avowRequests({ retryFor: 20n, ...request, key })
  return {
    sessionId,
    post: (event) => send({ domain, path, body: { event }, read: parseSessionEventAnswer }),
  }
}

/** Where a session stands with Avow's relay. */
export interface SessionStanding {
  /** The business the session is bound to, or null while no event has reached it. */
  business: { businessId: string; account: Address; lock: Address } | null
  /** When the relay stops taking the session's events, in unix seconds, or null while unbound. */
  endsAt: bigint | null
  /** The highest run number among the session's events, or 0 when it has none. */
  lastRun: number
}

/** One page of a session's events, as the relay's events route answers. */
function readPage(json: unknown): {
  business: SessionStanding['business']
  endsAt: bigint | null
  events: { sequence: number; run: number }[]
} | null {
  if (typeof json !== 'object' || json === null) return null
  const page = json as { business?: unknown; expiresAt?: unknown; events?: unknown }
  const b = page.business as { businessId?: unknown; account?: unknown; lock?: unknown } | null
  const business =
    b === null
      ? null
      : typeof b === 'object' &&
          typeof b.businessId === 'string' &&
          typeof b.account === 'string' &&
          isAddress(b.account) &&
          typeof b.lock === 'string' &&
          isAddress(b.lock)
        ? { businessId: b.businessId, account: b.account, lock: b.lock }
        : undefined
  const endsAt =
    page.expiresAt === null
      ? null
      : (typeof page.expiresAt === 'string' && /^[0-9]{1,20}$/.test(page.expiresAt)) ||
          (typeof page.expiresAt === 'number' && Number.isSafeInteger(page.expiresAt))
        ? BigInt(page.expiresAt)
        : undefined
  if (business === undefined || endsAt === undefined || !Array.isArray(page.events)) return null
  const events = page.events.flatMap((e: unknown) => {
    const row = e as { sequence?: unknown; event?: { run?: unknown } }
    return typeof row?.sequence === 'number' && typeof row.event?.run === 'number'
      ? [{ sequence: row.sequence, run: row.event.run }]
      : []
  })
  return { business, endsAt, events }
}

/**
 * Where a session stands with Avow's relay, read from the route the screen reads, which needs no
 * signature. It reads the session's events a page at a time for the last run number in it.
 */
export async function readSessionStanding(m: {
  apiUrl: string
  sessionId: string
  fetch?: typeof fetch
}): Promise<SessionStanding> {
  const send = m.fetch ?? ((input, init) => fetch(input, init))
  const url = `${m.apiUrl.replace(/\/+$/, '')}${SANDBOX_PATHS.sessionEvents(m.sessionId)}`
  let standing: SessionStanding = { business: null, endsAt: null, lastRun: 0 }
  let after = 0
  // A session holds a few hundred events at most, so this reads all of them well within the bound.
  for (let pages = 0; pages < 100; pages++) {
    const answer = await send(`${url}?after=${after}`)
    if (!answer.ok) throw new Error(`Avow's relay answered ${answer.status} for the session`)
    const page = readPage(await answer.json())
    if (!page)
      throw new Error("Avow's relay answered for the session in a form the SDK doesn't read")
    standing = { ...standing, business: page.business, endsAt: page.endsAt }
    if (page.events.length === 0) break
    for (const e of page.events) {
      standing.lastRun = Math.max(standing.lastRun, e.run)
      after = Math.max(after, e.sequence)
    }
  }
  return standing
}
