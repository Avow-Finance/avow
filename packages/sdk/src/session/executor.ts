import {
  type ChainedJobTerms,
  type CommitmentReference,
  type CustomerRefusal,
  formatUsd,
  isChainedTerms,
  type JobOffer,
  jobVerificationOf,
  type OrderScenario,
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
import type { ChargeStanding, JobWorld, ReportedCharge } from './world.js'

/**
 * What happens after a quote goes out, which no model drives. The executor follows the order, posts
 * what the customer says and verifies once each, and at the customer's reserve runs the developer's
 * `checkBeforeWork`. Only a `start` verdict leads to the acceptance, and only an acceptance that
 * landed, or that the lock shows landed, leads to work. Repeated states, states out of order and an
 * acceptance seen twice never verify, accept or start a job twice, since every step is the
 * executor's own and keyed by the order.
 *
 * A customer that cancels after the start breaks its promise. The executor stops the work, reports
 * the late-cancellation charge the job's terms allow, and follows the charge on the customer's
 * lock: reported, then confirmed by Avow, then paid once its contest window closes, or paused for
 * a ruling. The job ends for the session once Avow has answered, and the executor goes on following
 * the charge until it's paid or paused, without holding anything else up.
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
  /**
   * The customer cancelled after the start. `charge` is where the reported charge stood when the
   * job ended for the session, or the reason no report could be filed.
   */
  | {
      kind: 'cancelled'
      charge: { amount: bigint; standing: ChargeStanding } | { refused: ReasonCode }
    }
  | { kind: 'stopped'; why: string }

/** What a quote that went out carries for the executor. */
export interface Quoted {
  run: number
  order: JobOffer
  quote: QuoteRequest
  /** The scenario the order was asked for, when it was asked for one. */
  scenario?: OrderScenario
}

const RANK: Record<OrderState['status'], number> = {
  offered: 0,
  verifying: 1,
  refused: 2,
  reserved: 3,
  accepted: 4,
  cancelled: 5,
  delivered: 6,
  paid: 7,
}

/** How long the simulated work runs, in milliseconds, unless a test sets another. */
const WORK_MS = 15_000

const sameHex = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

export class JobExecutor {
  readonly #jobs = new Map<string, Promise<JobOutcome>>()
  /** Charges still being followed to their end after their jobs ended for the session. */
  readonly #charges = new Set<Promise<void>>()
  #stopped = false

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

  /** Stops following charges, so a session that ends doesn't wait out a contest window. */
  stop(): void {
    this.#stopped = true
  }

  /** Resolves once every charge being followed has been paid, paused or ended. */
  async charges(): Promise<void> {
    await Promise.allSettled([...this.#charges])
  }

  async #run({ run, order, quote, scenario }: Quoted): Promise<JobOutcome> {
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
        if (state.status === 'refused' || state.status === 'cancelled') return state
        if (RANK[state.status] >= RANK[at]) return state
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
    if (!('reserve' in reserved) || reserved.status === 'cancelled') {
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
    // The customer can cancel while the work runs. An order asked to cancel late is worked on
    // until the customer's cancellation can no longer change the charge, so the work never ends
    // before the cancellation it was asked for.
    const workEnds = world.now() + BigInt(Math.ceil((this.deps.workMs ?? WORK_MS) / 1000))
    const noShow = terms.remedies.charges.find((ch) => ch.kind === 'noShow')
    const worksUntil =
      scenario === 'cancels_late' && noShow && noShow.earliest > workEnds
        ? noShow.earliest
        : workEnds
    while (world.now() < worksUntil) {
      const state = await read()
      if (state.status === 'cancelled') return this.#charge(base, order, job, state, once)
      await world.sleep(Math.min(this.#pollMs, Number(worksUntil - world.now()) * 1000))
    }
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
    if (paid?.status === 'cancelled') return this.#charge(base, order, job, paid, once)
    if (paid?.status !== 'paid') {
      return { kind: 'stopped', why: `The customer hasn't paid for order ${orderId} yet.` }
    }
    once({ ...base, type: 'job_paid', payment: paid.payment })
    return { kind: 'paid' }
  }

  /**
   * The broken promise. The customer says it cancelled, so the work stops and the business reports
   * the late-cancellation charge. Avow answers from its own record of the customer's signed
   * cancellation, so a customer that only says it cancelled gets the report referred to a ruling.
   */
  async #charge(
    base: { run: number; source: 'session'; orderId: string },
    order: JobOffer,
    job: CommitmentReference,
    cancelled: Extract<OrderState, { status: 'cancelled' }>,
    once: (event: SessionEvent) => void,
  ): Promise<JobOutcome> {
    const { world } = this.deps
    const busy = this.deps.busy ?? (() => {})
    once({
      ...base,
      type: 'job_customer_cancelled',
      reference: job,
      cancelledAt: cancelled.cancellation.cancelledAt,
    })
    busy('the report of the cancellation charge')
    let reported: Awaited<ReturnType<JobWorld['reportCharge']>>
    try {
      reported = await world.reportCharge(order, 'lateCancellation')
    } finally {
      busy(null)
    }
    if (!reported.ok) {
      this.deps.note(
        `The report of the charge wasn't filed (${reported.code}, at the ${reported.layer} layer), so the customer's reserve stands as it was.`,
      )
      return { kind: 'cancelled', charge: { refused: reported.code } }
    }
    const { amount, reportNumber, transactionHash, reportedAt } = reported
    const report: ReportedCharge = { amount, reportNumber, transactionHash, reportedAt }
    once({
      ...base,
      type: 'job_charge_reported',
      reference: job,
      kind: 'lateCancellation',
      amount,
      reportNumber,
      transactionHash,
    })
    /** Posts where the charge stands, and says whether that's its end. */
    const post = (standing: ChargeStanding): boolean => {
      if (standing.state === 'confirmed') {
        once({
          ...base,
          type: 'job_charge_confirmed',
          reference: job,
          amount,
          contestableUntil: standing.contestableUntil,
        })
        return false
      }
      if (standing.state === 'paused') {
        once({ ...base, type: 'job_charge_paused', reference: job, cause: standing.cause })
      } else if (standing.state === 'paid') {
        once({ ...base, type: 'job_charge_paid', reference: job, amount })
      }
      return standing.state !== 'waiting'
    }
    /** Reads the charge until `done` says to stop, the session ends or the terms' last date passes. */
    const follow = async (done: (standing: ChargeStanding) => boolean): Promise<ChargeStanding> => {
      const giveUpAt =
        order.terms.backing.releaseDate + order.terms.resolution.contestWindow + 3600n
      let standing: ChargeStanding = { state: 'waiting' }
      for (;;) {
        standing = await world.charge(order, report).catch(() => standing)
        const ended = post(standing)
        if (done(standing) || ended || this.#stopped || world.now() > giveUpAt) return standing
        await world.sleep(this.#pollMs)
      }
    }
    // The job ends for the session once Avow has answered the report, one way or the other.
    const standing = await follow((s) => s.state !== 'waiting')
    if (standing.state === 'confirmed') {
      // A confirmed charge pays, or pauses on a contest, after the session has moved on.
      const rest = follow(() => false).then(() => undefined)
      this.#charges.add(rest)
      void rest.finally(() => this.#charges.delete(rest))
    }
    return { kind: 'cancelled', charge: { amount, standing } }
  }

  get #pollMs(): number {
    return this.deps.pollMs ?? 3000
  }
}
