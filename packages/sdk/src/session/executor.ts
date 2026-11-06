import {
  type ChainedJobTerms,
  type CommitmentReference,
  type CustomerRefusal,
  formatUsd,
  isChainedTerms,
  type JobOffer,
  jobVerificationOf,
  type OrderState,
  type PinnedBlock,
  type QuoteRequest,
  type ReasonCode,
  type SessionEvent,
  SIMULATED_RESULT_LABEL,
} from '@avow-finance/spec'
import { type Hex, keccak256, stringToHex } from 'viem'
import type { JobAcceptance } from '../job/accept.js'
import { sendErrorIn } from '../send.js'
import type { ReservedJob, Verdict } from './service.js'
import type { JobWorld } from './world.js'

/**
 * What happens after a quote goes out, which no model drives. The executor follows the order, posts
 * what the customer says and verifies once each, and at the customer's reserve runs the developer's
 * `checkBeforeWork`. Only a `start` verdict leads to the acceptance, and only an acceptance that
 * landed, or that the lock shows landed, leads to work. Repeated states, states out of order and an
 * acceptance seen twice never verify, accept or start a job twice, since every step is the
 * executor's own and keyed by the order.
 */

export interface ExecutorDeps {
  world: JobWorld
  emit: (event: SessionEvent) => void
  /** Runs the developer's `checkBeforeWork` in a process of its own, with no keys. */
  checkBeforeWork: (job: ReservedJob) => Promise<Verdict | { failed: string }>
  /** Says something to the developer that isn't an event. */
  note: (line: string) => void
  /** What's in flight on the chain or to the customer, or null once nothing is. */
  busy?: (what: string | null) => void
  /** How long to wait between reads of an order, in milliseconds. */
  pollMs?: number
  /** How long the simulated work takes, in milliseconds. */
  workMs?: number
}

/** How a job ended for this run. */
export type JobOutcome =
  | { kind: 'refused'; refusal: CustomerRefusal }
  | { kind: 'not_started'; code: ReasonCode; layer: 'service' | 'avow' | 'relay' | 'lock' }
  | { kind: 'paid' }
  | { kind: 'stopped'; why: string }

/** What a quote that went out carries for the executor. */
export interface Quoted {
  run: number
  order: JobOffer
  quote: QuoteRequest
}

const RANK: Record<OrderState['status'], number> = {
  offered: 0,
  verifying: 1,
  refused: 2,
  reserved: 3,
  accepted: 4,
  delivered: 5,
  paid: 6,
}

const sameHex = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

export class JobExecutor {
  readonly #jobs = new Map<string, Promise<JobOutcome>>()

  constructor(private readonly deps: ExecutorDeps) {}

  /** Follows a quoted order to its end, once however often it's asked. */
  follow(quoted: Quoted): Promise<JobOutcome> {
    const id = quoted.order.orderId
    const running = this.#jobs.get(id)
    if (running) return running
    const job = this.#run(quoted).catch(
      (error): JobOutcome => ({
        kind: 'stopped',
        why: error instanceof Error ? error.message : String(error),
      }),
    )
    this.#jobs.set(id, job)
    return job
  }

  async #run({ run, order, quote }: Quoted): Promise<JobOutcome> {
    const { world, emit, note } = this.deps
    const busy = this.deps.busy ?? (() => {})
    const orderId = order.orderId
    const base = { run, source: 'session' as const, orderId }
    const said = new Set<number>()
    const stated = new Set<number>()
    const posted = new Set<SessionEvent['type']>()
    const once = (event: SessionEvent) => {
      if (posted.has(event.type)) return
      posted.add(event.type)
      emit(event)
    }
    /** The customer's statements each posted once, by index, however often a state repeats them. */
    const statements = (state: OrderState) => {
      for (const s of state.said) {
        if (said.has(s.index)) continue
        said.add(s.index)
        emit({ ...base, type: 'said', speaker: { kind: 'customer', index: s.index }, text: s.text })
      }
      for (const { index, ...fact } of state.facts) {
        if (stated.has(index)) continue
        stated.add(index)
        emit({ ...base, type: 'fact', ...fact })
      }
    }
    const read = async (): Promise<OrderState> => {
      for (let attempt = 0; ; attempt++) {
        try {
          const state = await world.orderState(orderId)
          statements(state)
          return state
        } catch (error) {
          if (attempt >= 5) throw error
          await world.sleep(this.#pollMs * (attempt + 1))
        }
      }
    }
    /** Reads the order until it reaches `at` or is refused, never going back on what it saw. */
    const until = async (at: OrderState['status'], giveUpAt: bigint) => {
      for (;;) {
        const state = await read()
        if (state.status === 'refused' || RANK[state.status] >= RANK[at]) return state
        if (world.now() > giveUpAt) return null
        await world.sleep(this.#pollMs)
      }
    }

    // The customer verifies the quote and the compute booking it names, then reserves.
    const reserved = await until('reserved', order.expiry + 600n)
    if (!reserved)
      return {
        kind: 'stopped',
        why: `The customer didn't answer the quote for order ${orderId} in time.`,
      }
    if (reserved.status === 'refused') {
      once({ ...base, type: 'job_customer_refused', refusal: reserved.refusal })
      return { kind: 'refused', refusal: reserved.refusal }
    }
    if (!('reserve' in reserved)) {
      return { kind: 'stopped', why: `Order ${orderId} went back to ${reserved.status}.` }
    }
    once({ ...base, type: 'job_customer_verified', checks: reserved.checks })

    const refuse = (
      code: ReasonCode,
      layer: 'service' | 'avow' | 'relay' | 'lock',
      block: PinnedBlock | null = null,
      index: number | null = null,
    ): JobOutcome => {
      once({ ...base, type: 'job_commitment_refused', code, layer, block, index })
      return { kind: 'not_started', code, layer }
    }
    // The reserve the customer names has to be the commitment the business quoted.
    const reserve = reserved.reserve
    const c = reserve.reference
    if (
      c.side !== 'buyer' ||
      !sameHex(c.commitmentId, order.commitmentId) ||
      !sameHex(c.termsHash, quote.agreement.termsHash) ||
      !sameHex(c.lock, world.customer.lock) ||
      c.chainId !== world.customer.chainId
    ) {
      return refuse('order.commitment_mismatch', 'service')
    }
    if (!isChainedTerms(quote.terms)) return refuse('dependency.required', 'service')
    const terms = quote.terms as ChainedJobTerms
    const reservedJob: ReservedJob = {
      orderId,
      commitment: c,
      verification: jobVerificationOf(terms, quote.salt, c),
      terms,
      salt: quote.salt,
      supplier: world.supplier,
      token: world.token,
    }

    // The developer's own check, in a process of its own with no keys.
    const verdict = await this.deps.checkBeforeWork(reservedJob)
    if ('failed' in verdict) {
      note(verdict.failed)
      return refuse('service.check_failed', 'service')
    }
    if (!verdict.start) return refuse(verdict.code, 'service', verdict.block, verdict.index)
    const checked = verdict.check
    emit({
      ...base,
      type: 'fact',
      text: `The customer's lock holds its ${formatUsd(checked.reserve)} reserve in full for your business, under the job's terms, and your compute booking stands.`,
      check: 'reserve',
      verifiedBy: 'service',
      reference: c,
      block: checked.block,
      transactionHash: reserve.fundedIn,
    })

    // The acceptance, sent again only when its outcome was unknown, which the lock then decides.
    const sent: Hex[] = []
    let accepted: JobAcceptance | null = null
    let unknown: unknown = null
    busy("your business's acceptance of the customer's commitment")
    try {
      for (let attempt = 0; attempt < 4 && accepted === null; attempt++) {
        try {
          accepted = await world.accept(order, quote)
        } catch (error) {
          unknown = error
          sent.push(...(sendErrorIn(error)?.hashes ?? []))
          await world.sleep(this.#pollMs * (attempt + 1))
        }
      }
    } finally {
      busy(null)
    }
    if (!accepted) {
      return {
        kind: 'stopped',
        why: `The acceptance's outcome is still unknown after four tries (${unknown instanceof Error ? unknown.message : String(unknown)}). The customer's lock decides whether it landed, and no work starts until it shows it.`,
      }
    }
    if (!accepted.ok) return refuse(accepted.code, accepted.layer, accepted.block, accepted.index)
    // An acceptance this run sent and saw land is this run's. One the lock showed accepted came
    // from an earlier attempt, and this run saw its transaction only if it sent it.
    const acceptedIn = accepted.sent
      ? {
          transactionHash: accepted.sent.landed.transactionHash,
          blockNumber: accepted.sent.landed.blockNumber,
        }
      : await world.landed(sent)
    const job: CommitmentReference = c
    once({
      ...base,
      type: 'job_commitment_checked',
      reference: job,
      amount: reserve.amount,
      charges: terms.remedies.charges.map((ch) => ({ kind: ch.kind, amount: ch.amount })),
      releaseDate: terms.backing.releaseDate,
      checks: [...accepted.checks],
      acceptedIn,
    })
    const onLock = await world.read(job as Parameters<JobWorld['read']>[0]).catch(() => null)
    if (onLock) {
      emit({
        ...base,
        type: 'commitment',
        role: 'job',
        reference: job,
        amount: reserve.amount,
        state: onLock.state,
        verifiedBy: 'service',
        block: onLock.block,
        transactionHash: acceptedIn?.transactionHash ?? null,
        verification: reservedJob.verification,
      })
    }

    // The work, which is simulated, starts once the customer's free cancellation ends.
    const startsAt = terms.subject.startsAt
    while (world.now() < startsAt) {
      await world.sleep(Math.min(Number(startsAt - world.now()) * 1000, 5000))
    }
    once({ ...base, type: 'job_work_started', reference: job })
    await world.sleep(this.deps.workMs ?? 15_000)
    const result = {
      label: SIMULATED_RESULT_LABEL,
      hash: keccak256(stringToHex(`${SIMULATED_RESULT_LABEL} for order ${orderId}`)),
    } as const
    busy('the delivery report')
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          await world.deliver(orderId, result)
          break
        } catch (error) {
          if (attempt >= 5) throw error
          await world.sleep(this.#pollMs * (attempt + 1))
        }
      }
    } finally {
      busy(null)
    }
    once({ ...base, type: 'job_delivered', reference: job, result })

    const paid = await until('paid', terms.subject.deliverBy + 1800n)
    if (paid?.status !== 'paid') {
      return { kind: 'stopped', why: `The customer hasn't paid for order ${orderId} yet.` }
    }
    once({ ...base, type: 'job_paid', payment: paid.payment })
    return { kind: 'paid' }
  }

  get #pollMs(): number {
    return this.deps.pollMs ?? 3000
  }
}
