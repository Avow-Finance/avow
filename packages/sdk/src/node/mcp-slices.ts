import { join } from 'node:path'
import type { Address } from 'viem'
import type { AgentDelegation, DelegatedWorker, WorkerLimitsAsk } from '../sandbox/delegation.js'
import { toDollars } from '../sandbox/terms.js'
import { delegationOnThisMachine, workerFolders } from './delegation.js'
import type { ToolAnswer } from './mcp.js'
import { SANDBOX_DIR } from './platform.js'

/**
 * The tools for workers the agent starts. `delegate` hands a worker a narrower slice of the
 * agent's own authority, `slices` lists them with what each holds, and `end_slice` ends one for
 * good. None widens a limit: a slice only divides what the agent holds, and the administrator
 * changes or revokes any of them from the console.
 */
export const SLICE_TOOLS = ['delegate', 'slices', 'end_slice'] as const
export type SliceTool = (typeof SLICE_TOOLS)[number]

/** What every answer about a slice says about who holds a worker to it. */
const HELD_BY =
  "A slice's limits are held by the SDK and Avow only, while the lock and the keychain hold your agent and every worker together to the mandate your person signed."

const dollarsField = (what: string) => ({
  type: 'number',
  exclusiveMinimum: 0,
  description: `${what}, in dollars. Left out, it's your own.`,
})

export const SLICE_TOOL_DEFS = [
  {
    name: 'delegate',
    title: 'Hand a worker a slice of your authority',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    description: `Makes a key for a worker you start, keeps it in a folder of its own under this agent's on this machine, and hands it a slice of your own authority, signed with your key and taken by Avow. A slice can only be narrower than what you hold: each limit you leave out is your own, and one wider than yours is refused with nothing signed. The worker runs on this machine with sandboxWorkerOnThisMachine and the id this gives, and this server signs and funds its bookings with your key, only inside its slice, while it runs. A worker on another machine needs a mandate of its own from your person. ${HELD_BY}`,
    inputSchema: {
      type: 'object',
      properties: {
        label: {
          type: 'string',
          maxLength: 60,
          description: 'What the worker does, for you and your person',
        },
        perCommitment: dollarsField('The most one commitment may reserve'),
        atOnce: dollarsField('The most the worker may hold at once'),
        suppliers: {
          type: 'array',
          items: { type: 'string' },
          description:
            'The suppliers the worker may commit to, from your own. Left out, all of yours.',
        },
        days: {
          type: 'number',
          exclusiveMinimum: 0,
          description: 'How many days the slice lasts, never past your mandate',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'slices',
    title: "List your workers' slices",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    description: `Lists every worker you handed a slice, with its id, its limits and what it holds as Avow counts it. Avow counts a reserve as open until its approval lapsed unfunded or the lock shows it released, so what it shows can run high. ${HELD_BY}`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'end_slice',
    title: "End a worker's slice",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    description:
      "Ends a worker's key, its slice and every slice it handed out below it, for good, signed with your key. Commitments it already made keep their terms. A worker that needs authority again starts over with a new key through delegate.",
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The worker id, from delegate or slices' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
] as const

const shownLimits = (w: DelegatedWorker) => {
  if (!w.held.ok) return null
  const level = w.held.answer.slices.levels[w.held.answer.slices.levels.length - 1]
  const s = level?.current.message
  if (!s) return null
  const at = w.held.answer.holdings.openReserves.slices.length - 1
  return {
    perCommitment: toDollars(s.capPerCommitment),
    atOnce: toDollars(s.capOpenReserves),
    held: toDollars(w.held.answer.holdings.openReserves.slices[at] ?? 0n),
    suppliers: [...s.suppliers],
    until: new Date(Number(s.expiry) * 1000).toISOString(),
    heldBy: 'the SDK and Avow only',
  }
}

/**
 * The slice tools for the agent in `dir`. The agent's signer for its workers starts with the first
 * of them, or with `start` when the server finds workers already in the folder, and serves the
 * socket in `.avow` until the server stops.
 */
export function sliceTools(dir: string, options: { fetch?: typeof fetch } = {}) {
  let running: Promise<AgentDelegation> | null = null
  const delegation = () => {
    running ??= delegationOnThisMachine(dir, options).catch((error: unknown) => {
      running = null
      throw error
    })
    return running
  }

  async function delegate(args: Record<string, unknown>): Promise<ToolAnswer> {
    const suppliers = Array.isArray(args.suppliers)
      ? args.suppliers.filter((s): s is string => typeof s === 'string')
      : undefined
    const label =
      typeof args.label === 'string' && args.label.trim() !== '' ? args.label.trim() : null
    const ask: WorkerLimitsAsk & { label: string | null } = { label }
    if (typeof args.perCommitment === 'number') ask.perCommitment = args.perCommitment
    if (typeof args.atOnce === 'number') ask.atOnce = args.atOnce
    if (typeof args.days === 'number') ask.days = args.days
    if (suppliers) ask.suppliers = suppliers
    const handed = await (await delegation()).delegate(ask)
    const s = handed.slice.message
    return {
      text: `Handed worker ${handed.id}${label ? ` ("${label}")` : ''} a slice: up to ${toDollars(s.capPerCommitment)} dollars a commitment and ${toDollars(s.capOpenReserves)} dollars at once, until ${new Date(Number(s.expiry) * 1000).toISOString()}. Start it on this machine with sandboxWorkerOnThisMachine('${handed.id}'), and keep this server running so its bookings can be signed. ${HELD_BY}`,
      structured: {
        id: handed.id,
        subKey: handed.subKey,
        perCommitment: toDollars(s.capPerCommitment),
        atOnce: toDollars(s.capOpenReserves),
        until: Number(s.expiry),
        heldBy: 'the SDK and Avow only',
      },
      isError: false,
    }
  }

  async function slices(): Promise<ToolAnswer> {
    const workers = await (await delegation()).workers()
    if (workers.length === 0) {
      return {
        text: 'You have handed no worker a slice. delegate hands one out.',
        structured: { workers: [] },
        isError: false,
      }
    }
    const rows = workers.map((w) => ({
      id: w.id,
      label: w.label,
      subKey: w.subKey,
      limits: shownLimits(w),
      problem: w.held.ok ? null : w.held.problem,
    }))
    const lines = rows.map((r) =>
      r.limits
        ? `${r.id}${r.label ? ` ("${r.label}")` : ''}: up to ${r.limits.perCommitment} a commitment, ${r.limits.held} of ${r.limits.atOnce} dollars held, until ${r.limits.until}.`
        : `${r.id}: ${r.problem}`,
    )
    return { text: `${lines.join(' ')} ${HELD_BY}`, structured: { workers: rows }, isError: false }
  }

  async function endSlice(args: Record<string, unknown>): Promise<ToolAnswer> {
    const id = typeof args.id === 'string' ? args.id : ''
    const ended: { revoked: Address } = await (await delegation()).end(id)
    return {
      text: `Ended worker ${id}'s key ${ended.revoked}, its slice and every slice below it, for good. Commitments it made keep their terms.`,
      structured: { id, revoked: ended.revoked },
      isError: false,
    }
  }

  return {
    /** Starts the signer at once when the folder already holds workers. */
    async start(): Promise<void> {
      const ids = await workerFolders(join(dir, SANDBOX_DIR)).ids()
      if (ids.length > 0) await delegation()
    },
    async call(name: SliceTool, args: Record<string, unknown>): Promise<ToolAnswer> {
      if (name === 'delegate') return delegate(args)
      if (name === 'slices') return slices()
      return endSlice(args)
    },
  }
}
