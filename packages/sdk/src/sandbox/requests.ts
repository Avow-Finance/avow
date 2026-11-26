import {
  type ApprovalAsk,
  type ApprovalRequest,
  type AvowDomain,
  isApprovalFinal,
  type Mandate,
  parseApprovalRequest,
  type RaisableLimit,
  SANDBOX_PATHS,
} from '@avow-finance/spec'
import type { AgentKey } from '../agent.js'
import { agentRequestKey, avowRequests } from '../http.js'
import { approvalRequestLink } from './connect.js'

/** Where the agent's requests go, and the key it signs them with. */
export interface RequestContext {
  apiUrl: string
  agentKey: AgentKey
  domain: AvowDomain
  send: typeof fetch
}

/** A request the agent made, and the link its person opens to decide it. */
export interface AskedChange {
  request: ApprovalRequest
  link: string
}

/**
 * The ask to raise one of the agent's limits from what its current mandate holds. The starting
 * value comes from that mandate, since Avow takes an ask only when it matches where the agent
 * stands now, and the reason is the fixed code for that limit, so the ask carries no text of the
 * agent's own.
 */
export function raiseAsk(current: Mandate, limit: RaisableLimit, to: bigint): ApprovalAsk {
  const from = limit === 'per_commitment' ? current.capPerCommitment : current.capOpenReserves
  if (to <= from) throw new RangeError('A raise has to ask for more than the limit holds now')
  return {
    kind: 'raise_limit',
    terms: { limit, from, to },
    reason: limit === 'per_commitment' ? 'over_commitment_limit' : 'reserves_limit_full',
  }
}

const readRequest = (json: unknown) => parseApprovalRequest(json)

/**
 * Asks the agent's business for a change to its authority, signed with the agent's own key. It
 * asks and nothing more: only the business's administrator decides, with their passkey, on the
 * page the link opens. Asking again while the same request waits answers with that request.
 */
export async function askForChange(c: RequestContext, ask: ApprovalAsk): Promise<AskedChange> {
  const send = avowRequests({
    baseUrl: c.apiUrl,
    key: agentRequestKey(c.agentKey),
    fetch: c.send,
  })
  const request = await send({
    domain: c.domain,
    path: SANDBOX_PATHS.approvalRequests,
    body: ask,
    read: readRequest,
  })
  return { request, link: approvalRequestLink(request.id) }
}

/** Where one of the agent's own requests stands, as Avow holds it. */
export async function readOwnRequest(c: RequestContext, id: string): Promise<AskedChange> {
  const send = avowRequests({
    baseUrl: c.apiUrl,
    key: agentRequestKey(c.agentKey),
    retryFor: 10n,
    fetch: c.send,
  })
  const request = await send({
    domain: c.domain,
    path: SANDBOX_PATHS.approvalRequest(id),
    body: {},
    read: readRequest,
  })
  return { request, link: approvalRequestLink(request.id) }
}

/**
 * Whether the agent can act on what it asked for. Approved isn't enough, since the change still
 * has to land: only an active request is.
 */
export const isUsable = (request: ApprovalRequest): boolean => request.status.state === 'active'

/** Whether a request has stopped moving, so reading it again won't change it. */
export const hasSettled = (request: ApprovalRequest): boolean =>
  isApprovalFinal(request.status.state)
