import {
  type AvowDomain,
  type CommitmentReference,
  encodeCommitmentReference,
  isSessionId,
  parseSessionEventAnswer,
  SANDBOX_PATHS,
  type SessionEvent,
  type SessionEventAnswer,
} from '@avow-finance/spec'
import type { Account as TempoAccount } from 'viem/tempo'
import { type AvowRequestConfig, avowRequests, rootRequestKey } from '../http.js'

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
   * The sandbox business's root key. It signs each event, so Avow's API can tell the event comes
   * from a registered sandbox business before it relays it to the screen.
   */
  root: TempoAccount.RootAccount
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
 * Avow's relay for one session's events. Each event is one request through `avowRequests`,
 * signed by the business's root key under its lock, so a lost answer never posts the same event
 * twice. It stops resending after 20 seconds by default, since a screen that shows an event late
 * helps no one, and a refusal throws an `AvowApiError` with Avow's reason.
 */
export function sessionRelay(config: SessionRelayConfig): SessionRelay {
  const { sessionId, root, domain, ...request } = config
  const path = SANDBOX_PATHS.sessionEvents(sessionId)
  const send = avowRequests({ retryFor: 20n, ...request, key: rootRequestKey(root) })
  return {
    sessionId,
    post: (event) => send({ domain, path, body: { event }, read: parseSessionEventAnswer }),
  }
}
