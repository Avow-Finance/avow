import { approvalLink, connectToBusiness, savedRequest } from '../sandbox/connect.js'
import { type AgentItem, loadAgentItem, type SandboxStore } from '../sandbox/store.js'

/** The name an agent asks under when the model gives none, the same as the terminal's. */
export const DEFAULT_LABEL = 'My agent'

/** Where this folder's agent stands with a business, as the connect and status tools tell it. */
export type Connection =
  | { at: 'none' }
  /** A request this folder made earlier, which nothing in this server is waiting on now. */
  | { at: 'saved'; businessId: string; label: string | null }
  | {
      at: 'waiting'
      businessId: string
      label: string
      pairingCode: string
      link: string
      /** When Avow lets the request lapse, in seconds since 1970. */
      expiresAt: number
    }
  /** Approved, and picking up its authority from Avow. */
  | { at: 'enrolling'; businessId: string; agentId: string }
  | { at: 'connected'; businessId: string; agentId: string; expiry: number }
  | { at: 'failed'; businessId: string; reason: string }

export interface ConnectAsk {
  businessId: string
  label: string | null
  sell: boolean
}

const connected = (item: AgentItem): Extract<Connection, { at: 'connected' }> => {
  const m = item.mandate.message
  return { at: 'connected', businessId: m.businessId, agentId: m.agentId, expiry: Number(m.expiry) }
}

/**
 * The agent's connection to its business, for an MCP server that stays running while the
 * administrator approves. `start` asks the business and answers as soon as Avow holds the request,
 * with the pairing code and the approval link, and keeps waiting in the background. The agent's key
 * stays in the store the whole time, and nothing here returns it.
 *
 * It asks one business at a time. Asking the same business again while it waits answers with the
 * same request, and asking again after a restart resumes the request saved in the folder, with the
 * same key and pairing code.
 */
export function mcpConnection(o: {
  store: SandboxStore
  connect?: typeof connectToBusiness
  fetch?: typeof fetch
  pollEvery?: number
}) {
  const connect = o.connect ?? connectToBusiness
  let run: { businessId: string; started: Promise<Connection> } | null = null
  let latest: Connection | null = null

  async function state(): Promise<Connection> {
    if (latest && latest.at !== 'failed' && latest.at !== 'connected') return latest
    const item = await loadAgentItem(o.store)
    if (item) return connected(item)
    if (latest) return latest
    const saved = await savedRequest(o.store)
    return saved ? { at: 'saved', ...saved } : { at: 'none' }
  }

  function begin(ask: ConnectAsk): Promise<Connection> {
    return new Promise((resolve, reject) => {
      let answered = false
      let asked: { pairingCode: string; link: string } | null = null
      const tell = (c: Connection) => {
        latest = c
        if (!answered) {
          answered = true
          resolve(c)
        }
      }
      const go = async () => {
        const item = await loadAgentItem(o.store)
        if (item) return tell(connected(item))
        const saved = await savedRequest(o.store)
        const label =
          ask.label ?? (saved?.businessId === ask.businessId ? saved.label : null) ?? DEFAULT_LABEL
        const done = await connect({
          store: o.store,
          businessId: ask.businessId,
          label,
          sell: ask.sell,
          ...(o.fetch ? { fetch: o.fetch } : {}),
          ...(o.pollEvery ? { pollEvery: o.pollEvery } : {}),
          onEvent: (e) => {
            if (e.type === 'asked') {
              asked = { pairingCode: e.pairingCode, link: approvalLink(e.agentKey) }
            } else if (e.type === 'waiting' && asked) {
              tell({
                at: 'waiting',
                businessId: ask.businessId,
                label,
                ...asked,
                expiresAt: Number(e.expiresAt),
              })
            } else if (e.type === 'approved') {
              tell({ at: 'enrolling', businessId: ask.businessId, agentId: e.agentId })
            }
          },
        })
        tell(connected(done))
      }
      go().catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error)
        latest = { at: 'failed', businessId: ask.businessId, reason }
        if (!answered) {
          answered = true
          reject(new Error(reason))
        }
      })
    })
  }

  return {
    state,
    /**
     * Asks the business, or answers with the request already running. It rejects when the ask
     * fails before Avow holds it, such as for a business Avow doesn't know.
     */
    async start(ask: ConnectAsk): Promise<Connection> {
      // Checked before any await, so two calls at once never ask with two keys.
      if (run && latest?.at !== 'failed') {
        if (latest?.at === 'connected' || run.businessId === ask.businessId) {
          return latest?.at === 'connected' ? latest : run.started
        }
        throw new Error(
          `This agent is already asking ${run.businessId} for authority, and asks one business at a time.`,
        )
      }
      latest = null
      run = { businessId: ask.businessId, started: begin(ask) }
      return run.started
    },
  }
}
