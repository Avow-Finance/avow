import {
  type ApprovalAsk,
  type ApprovalRequest,
  type AvowDomain,
  formatUsd,
  isApprovalFinal,
  type Mandate,
  parseApprovalRequest,
  quotedLabel,
  type RaisableLimit,
  SANDBOX_PATHS,
  type SellerMandateTerms,
  sellerMandateTermsProblem,
} from '@avow-finance/spec'
import type { AgentKey } from '../agent.js'
import { agentRequestKey, avowRequests } from '../http.js'
import { approvalRequestLink } from './connect.js'
import { saleWords } from './sale-words.js'
import { sellerMandateWords } from './seller-mandate-words.js'

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

/** The ask to name a supplier, by its Avow business id, on the lock and in the agent's mandate. */
export function supplierAsk(supplier: string): ApprovalAsk {
  return { kind: 'name_supplier', terms: { supplier }, reason: 'new_supplier' }
}

/**
 * The ask to open the business's lock to suppliers listed in the testnet's registry, up to `cap`
 * held with them at once. It reaches every agent of the business whose limits allow a listed
 * supplier, not only the one asking.
 */
export function openModeAsk(cap: bigint): ApprovalAsk {
  if (cap <= 0n) throw new RangeError('Open mode is a cap above zero')
  return { kind: 'open_mode', terms: { cap }, reason: 'listed_suppliers' }
}

/**
 * The ask for a seller's mandate with exactly these terms: the signing key it would bind and every
 * limit on what the agent sells, without the fields that say which mandate it is and whose. The
 * reason is the fixed code for a first mandate, or for other limits than the ones the key holds,
 * so the ask carries no text of the agent's own beyond the names of what it would sell.
 */
export function sellerMandateAsk(terms: SellerMandateTerms, holdsOne: boolean): ApprovalAsk {
  const problem = sellerMandateTermsProblem(terms)
  if (problem) throw new RangeError(`The terms can't be asked for: ${problem}`)
  return {
    kind: 'seller_mandate',
    terms,
    reason: holdsOne ? 'seller_limits' : 'new_seller',
  }
}

/**
 * One row a request's card shows. A change sets a value that stands now beside the one asked for.
 * A request that changes nothing that stood before, such as one sale, states each fact once.
 */
export type ChangeRow =
  | { label: string; before: string; after: string }
  | { label: string; value: string }

/** What a request asks for, in words any card or page can show the same way. */
export interface ChangeWords {
  title: string
  rows: ChangeRow[]
}

const LIMIT_LABELS = {
  per_commitment: 'Most per commitment',
  open_reserves: 'Most reserved at once',
} as const

/**
 * What a request changes, with each value as it stands now beside the value asked for. A request
 * for agent authority has no rows, since the administrator sets its limits when approving. A
 * request for a seller's mandate has a row for every limit it would set, and says only whether
 * each replaces one signed before, since the request carries the earlier mandate's hash alone.
 * Nothing enforces a seller's mandate yet, and a card that shows these before Avow does says so.
 */
export function changeWords(request: ApprovalRequest): ChangeWords {
  switch (request.kind) {
    case 'agent_authority':
      return { title: `Connect ${quotedLabel(request.terms.label)}`, rows: [] }
    case 'raise_limit':
      return {
        title: 'Raise a limit',
        rows: [
          {
            label: LIMIT_LABELS[request.terms.limit],
            before: formatUsd(request.terms.from),
            after: formatUsd(request.terms.to),
          },
        ],
      }
    case 'name_supplier':
      return {
        title: 'Name a supplier',
        rows: [{ label: 'Supplier', before: 'Not named', after: request.terms.supplier }],
      }
    case 'open_mode':
      return {
        title: 'Open the lock to listed suppliers',
        rows: [
          {
            label: 'Most held with listed suppliers at once',
            before: request.basis.openCap === 0n ? 'Closed' : formatUsd(request.basis.openCap),
            after: formatUsd(request.terms.cap),
          },
        ],
      }
    case 'sale':
      // One sale, good once. It changes no limit, and every limit of the mandate still holds it.
      return {
        title: 'Approve one sale',
        rows: saleWords(request.terms),
      }
    case 'seller_mandate': {
      const first = request.basis.sellerMandate === null
      const before = first ? 'Not set' : 'Set by the mandate this replaces'
      return {
        title: first ? 'Let the agent sell' : 'Change what the agent may sell',
        rows: sellerMandateWords(request.terms).map(({ label, value }) => ({
          label,
          before,
          after: value,
        })),
      }
    }
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
 * Whether the agent can act on what it asked for. For a change, approved isn't enough, since the
 * change still has to land, and only an active request is. One sale has no change to land, so it
 * can be made while its request is approved, and an active one was made already.
 */
export const isUsable = (request: ApprovalRequest): boolean =>
  request.status.state === (request.kind === 'sale' ? 'approved' : 'active')

/** Whether a request has stopped moving, so reading it again won't change it. */
export const hasSettled = (request: ApprovalRequest): boolean =>
  isApprovalFinal(request.status.state)
