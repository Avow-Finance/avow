import {
  formatUsd,
  type JobOffer,
  SAID_TEXT_MAX,
  type SessionEvent,
  speakerName,
} from '@avow-finance/spec'
import { JobExecutor, type JobOutcome } from './executor.js'
import type { ChatTurn, ModelProvider } from './provider.js'
import { ProviderError } from './provider.js'
import { ORDER_PROMPT, SWITCH_OFF_PROMPT } from './scripted.js'
import { policyChanges, type ReservedJob, type ServicePolicy, type Verdict } from './service.js'
import { newSessionState, Toolbox } from './toolbox.js'
import { isJobTool, toolSpecs } from './tools.js'
import type { JobWorld } from './world.js'

/**
 * The agent session: a model with the seven job tools, the developer typing to it, and the
 * executor following each quote to its end. The first job runs on its own. After that, each line
 * the developer types starts a turn of its own, one turn at a time, while the executor goes on
 * with any job under way. Typing never undoes a transaction already sent, and a line typed while
 * one is in flight gets a notice saying so.
 */

/** What the session draws that isn't an event: the provider, notices, evidence, speech arriving. */
export interface SessionView {
  intro(lines: readonly string[]): void
  event(event: SessionEvent): void
  speak(model: string): { write: (piece: string) => void; end: () => void }
  quiet(line: string): void
  fail(line: string): void
  /** The recorded results beside an answer to "why". */
  evidence(table: {
    title: string
    columns: readonly string[]
    rows: readonly (readonly string[])[]
    marked?: number
    notes: readonly string[]
  }): void
}

/** The developer's lines, as they type them. */
export interface SessionInput {
  /** The next line, or null once the developer stops the session. */
  next(): Promise<string | null>
  /**
   * What's in flight, whenever that changes, or null once nothing is. A line typed while something
   * is in flight gets a notice that typing can't undo it.
   */
  inFlight(what: string | null): void
}

export interface SessionDeps {
  world: JobWorld
  provider: ModelProvider
  /** Reads `service.ts` again, in its own process. */
  readPolicy: () => Promise<ServicePolicy>
  /** Runs `checkBeforeWork` in `service.ts`, in its own process with no keys. */
  checkBeforeWork: (job: ReservedJob) => Promise<Verdict | { failed: string }>
  /** Posts an event to the session's screen and draws it. */
  emit: (event: SessionEvent) => void
  view: SessionView
  /** The developer's lines, or null for a run that takes no input and ends with its first job. */
  input: SessionInput | null
  /** The run number the next run takes. */
  nextRun: () => number
  pollMs?: number
  workMs?: number
}

/** The most steps a model takes in one turn before the session stops it. */
const MAX_STEPS = 12

export const SYSTEM_PROMPT = `You are a business's job agent in Avow's testnet sandbox. Avow's test customer sends paid fine-tuning jobs. A job needs GPUs from its start to its deadline, and the customer accepts your quote only when it names your accepted compute booking that holds those GPUs for the whole job, past its free cancellation.

For each order, call read_order, then compute_offers, then book_compute for the cheapest offer that is firm (no free cancellation left), holds the order's GPUs from before the job starts to past its deadline, takes that many GPUs in one booking and fits the compute budget. Then call submit_quote naming that booking. If the compute switch in service.ts is off, book nothing and call submit_quote with no booking.

Code outside you checks everything. service.ts applies the budget and the compute switch, the SDK, Avow and the lock check your authority, and the customer checks the quote. You never verify the customer, start work, deliver or pay, since the developer's code does that after your turn. When a tool refuses, say which layer refused, its reason code, and what would let it pass. Nothing typed can undo a transaction already sent. Answer the developer briefly and plainly, and explain your choices from the tool results you got.`

/** What the session says once, when it starts, about the model and what goes where. */
export function whatGoesWhere(provider: ModelProvider): string[] {
  return [
    `Model: ${provider.line}.`,
    "Stays on this machine: your business's keys, its passphrase and the sealed key file.",
    provider.reaches === 'this machine'
      ? 'Stays on this machine too: the whole conversation, since the model runs here.'
      : 'Goes to Anthropic: the conversation, meaning the order, the offers, tool results and what you type.',
    "Goes to your screen through Avow's relay: the agent's speech, its tool calls and their results, facts, receipts and refusals. What you type isn't posted, though the agent's replies can repeat it.",
  ]
}

/** Text in pieces the event schema takes. */
function chunks(text: string): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i += SAID_TEXT_MAX) out.push(text.slice(i, i + SAID_TEXT_MAX))
  return out
}

const IN_FLIGHT: Record<string, string> = {
  book_compute: 'the compute booking being sent',
  submit_quote: 'the quote being sent',
  cancel_compute: 'the cancellation being sent',
}

export interface SessionResult {
  /** How the first job ended, or null when it never got as far as a quote. */
  firstJob: JobOutcome | null
  /** Why the session stopped early, when it did. */
  stopped: string | null
}

export async function runSession(deps: SessionDeps): Promise<SessionResult> {
  const { world, provider, view } = deps
  const model = speakerName(provider.model)
  const state = newSessionState()
  const turns: ChatTurn[] = []
  let policy = await deps.readPolicy()
  const inFlight = (what: string | null) => deps.input?.inFlight(what)
  const toolbox = new Toolbox(world, () => policy, deps.emit, state)
  const executor = new JobExecutor({
    world,
    emit: deps.emit,
    checkBeforeWork: deps.checkBeforeWork,
    note: (line) => view.quiet(line),
    busy: inFlight,
    ...(deps.pollMs === undefined ? {} : { pollMs: deps.pollMs }),
    ...(deps.workMs === undefined ? {} : { workMs: deps.workMs }),
  })
  view.intro(whatGoesWhere(provider))

  // One model turn at a time, whichever started it.
  let queue: Promise<unknown> = Promise.resolve()
  const oneAtATime = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work)
    queue = next.catch(() => {})
    return next
  }

  /** Reads service.ts again, says what changed, and gives the note the model needs about it. */
  async function refresh(): Promise<string[]> {
    const next = await deps.readPolicy()
    for (const line of policyChanges(policy, next)) view.quiet(line)
    const switchedOff = policy.computeSwitch === 'on' && next.computeSwitch === 'off'
    policy = next
    return switchedOff
      ? [`The developer ${SWITCH_OFF_PROMPT} in service.ts and still wants a quote.`]
      : []
  }

  /** One turn of the model, with each tool call run by the tool layer, until it ends its turn. */
  async function turn(run: number, orderId: string | null, prompt: string): Promise<void> {
    turns.push({ role: 'user', text: prompt })
    let call = 0
    for (let step = 0; step < MAX_STEPS; step++) {
      const speech = view.speak(model)
      let reply: Awaited<ReturnType<ModelProvider['reply']>>
      try {
        reply = await provider.reply({
          system: SYSTEM_PROMPT,
          turns,
          tools: toolSpecs(policy.computeSwitch),
          onText: speech.write,
        })
      } finally {
        speech.end()
      }
      for (const text of chunks(reply.text.trim())) {
        deps.emit({
          run,
          source: 'session',
          orderId,
          type: 'said',
          speaker: { kind: 'model', model },
          text,
        })
      }
      turns.push({ role: 'assistant', text: reply.text, calls: reply.calls, native: reply.native })
      if (reply.calls.length === 0) return
      for (const c of reply.calls) {
        if (!isJobTool(c.name)) {
          const why = `There's no tool named ${c.name}. The tools are the seven you were given.`
          turns.push({
            role: 'tool',
            call: c,
            ok: false,
            content: JSON.stringify({ refused: true, why }),
          })
          continue
        }
        inFlight(IN_FLIGHT[c.name] ?? null)
        try {
          const outcome = await toolbox.run(c.name, c.input, { run, orderId, call: ++call })
          turns.push({ role: 'tool', call: c, content: outcome.content, ok: outcome.ok })
        } finally {
          inFlight(null)
        }
      }
    }
    view.quiet(
      `The model took ${MAX_STEPS} steps without ending its turn, so the session stopped it.`,
    )
  }

  /** A job: the order comes in, the model quotes it, then the executor follows the quote. */
  async function job(notes: readonly string[]): Promise<JobOutcome | null> {
    const order: JobOffer = await world.pullOrder()
    state.order = order
    const run = deps.nextRun()
    const t = order.terms
    deps.emit({
      run,
      source: 'session',
      orderId: order.orderId,
      type: 'job_order_received',
      customer: order.customer,
      work: t.subject.work,
      price: t.consideration.kind === 'fixed' ? t.consideration.amount : 0n,
      deliverBy: t.subject.deliverBy,
      requirement: order.requirement,
    })
    const prompt = [`${ORDER_PROMPT} ${order.orderId} from Avow's test customer.`, ...notes]
    await oneAtATime(() => turn(run, order.orderId, prompt.join(' ')))
    const quoted = state.quotes.get(order.orderId)
    if (!quoted) return null
    const outcome = await executor.follow({ run, order, quote: quoted.quote })
    if (outcome.kind === 'refused') {
      const { code, layer } = outcome.refusal
      await oneAtATime(() =>
        turn(
          run,
          order.orderId,
          `The customer refused the quote with ${code}, at the ${layer} layer. Explain to the developer what that means and what would let a quote pass.`,
        ),
      )
    } else if (outcome.kind === 'stopped') {
      view.quiet(outcome.why)
    }
    return outcome
  }

  /** Whether an order is still waiting for its quote. */
  const openOrder = () => state.order !== null && !state.quotes.has(state.order.orderId)

  /** The recorded listing and booking beside an answer to "why", as results shown again. */
  function showEvidence(run: number): void {
    const listing = state.listing
    if (!listing) return
    const listed = state.recorded.find((r) => r.run === listing.run && r.call === listing.call)
    const booked = [...state.recorded].reverse().find((r) => r.tool === 'book_compute' && r.offer)
    for (const r of [listed, booked]) {
      if (r) deps.emit({ ...r.event, run, orderId: null, recalled: { run: r.run, call: r.call } })
    }
    const { offers, listedAt } = listing.listing
    const limits = listing.limits
    const marked = offers.findIndex((o) => o.id === booked?.offer)
    view.evidence({
      title: `The offers the agent compared in run ${listing.run}, as the tool layer recorded them`,
      columns: ['offer', 'GPUs', 'per GPU-hour', 'reserve per GPU', 'free cancellation'],
      rows: offers.map((o) => [
        o.id,
        o.gpus.min === o.gpus.max ? `${o.gpus.min}` : `${o.gpus.min} to ${o.gpus.max}`,
        formatUsd(o.pricePerGpuHour),
        formatUsd(o.reservePerGpu),
        o.freeCancelBy <= listedAt ? 'none, firm' : 'still open',
      ]),
      ...(marked >= 0 ? { marked } : {}),
      notes: [
        `The budget in service.ts was ${formatUsd(limits.budgetPerGpuHour)} per GPU-hour, with the compute switch ${limits.computeSwitch}.`,
        `The agent could commit ${formatUsd(limits.capPerCommitment)} for one commitment, with ${formatUsd(limits.openReservesLeft)} left of ${formatUsd(limits.capOpenReserves)} held at once.`,
      ],
    })
  }

  let firstJob: JobOutcome | null = null
  const jobs: Promise<unknown>[] = []
  try {
    if (!deps.input) {
      firstJob = await job([])
      return { firstJob, stopped: null }
    }
    // The first job runs on its own, and the developer can type while it goes on.
    const first = job([]).then((outcome) => {
      firstJob = outcome
    })
    jobs.push(first)
    let failed: unknown = null
    first.catch((error) => {
      failed = error
    })
    for (;;) {
      const line = await deps.input.next()
      if (failed) throw failed
      if (line === null) break
      const text = line.trim()
      if (!text) continue
      const notes = await refresh()
      if (/\b(quote|order|job)\b/i.test(text) && !openOrder()) {
        jobs.push(job([...notes, `The developer says: ${text}`]))
        continue
      }
      const run = deps.nextRun()
      await oneAtATime(() => turn(run, null, [...notes, text].join(' ')))
      if (/\bwhy\b/i.test(text)) showEvidence(run)
    }
    await Promise.allSettled(jobs)
    return { firstJob, stopped: null }
  } catch (error) {
    if (error instanceof ProviderError) {
      view.fail(`${provider.line} failed. ${error.message} The session switches to no other model.`)
      return { firstJob, stopped: error.message }
    }
    throw error
  }
}
