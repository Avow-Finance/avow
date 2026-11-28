import {
  type CommitmentReference,
  type Mandate,
  type RailState,
  type ReasonCode,
  TEST_BUSINESS_SUFFIX,
} from '@avow-finance/spec'
import { type LockedBacking, readBacking } from '@avow-finance/verifier'
import type { Hex } from 'viem'
import { AvowApiError, agentRequestKey, httpAvowApi } from '../http.js'
import { moderatoClient } from '../moderato.js'
import { httpSupplier } from '../supplier.js'
import {
  agentContext,
  type SandboxAgent,
  type SandboxAgentOptions,
  type SandboxBooking,
  type SandboxCommitment,
  sandboxAgent,
} from './agent.js'
import { askForLateCharge, type LateChargeOutcome, type LateChargeReport } from './late-charge.js'
import { micros } from './terms.js'

/**
 * One run of the whole loop on testnet, from an agent its business already approved. The agent
 * books twice with Avow's demo GPU supplier, a test business, within the mandate it holds. It keeps
 * one booking, whose reserve the lock gives back whole at its release date, and cancels the other
 * after free cancellation has ended, so the supplier reports the late-cancellation charge the terms
 * allow and Avow confirms it from its own record of the cancellation. It approves nothing, signs no
 * mandate and never reads the business's key, so a mandate that doesn't allow it stops the run
 * before anything is booked.
 */

/**
 * What each booking asks for, one H100 for four minutes. A window that long gives the no-show charge
 * two minutes' grace, which leaves room to cancel well inside the late window and still finishes
 * the whole loop in about ten minutes.
 */
export const LOOP_RESOURCE = { gpu: 'H100', count: 1, hours: 4 / 60 } as const

/**
 * Seconds Avow keeps between a late cancellation and each moment it's measured against, as the
 * testnet's `clockMargin` publishes it. Avow confirms a late-cancellation charge only for a
 * cancellation at least this far inside the late window and this far before the report, since its
 * records carry its clock and the lock's times are block times, and refers one any closer.
 */
export const AVOW_CLOCK_MARGIN = 30n

/** The reserve of each booking, in dollars, when the run names none. */
export const LOOP_RESERVE = 10

/** Which of the two bookings a step is about. */
export type LoopRole = 'kept' | 'cancelled'

export type LoopStep =
  | { type: 'booking'; role: LoopRole }
  | {
      type: 'booked'
      role: LoopRole
      link: string
      reference: CommitmentReference
      /** In micros. */
      reserve: bigint
      freeCancelBy: bigint
      releaseDate: bigint
    }
  | { type: 'accepted'; role: LoopRole }
  | { type: 'waiting'; until: bigint; for: 'free_cancellation' | 'confirmation' | 'release' }
  | { type: 'cancelled'; cancelledAt: bigint }
  | { type: 'reported'; amount: bigint; transaction: Hex }

/** How the cancelled booking's charge stands when the run stops following it. */
export interface LoopCharge {
  /** In base units of the lock's token. */
  amount: bigint
  transaction: Hex
  outcome: LateChargeOutcome
  /** When the confirmed charge pays the supplier, unless the business contests it first. */
  paysAt: bigint | null
}

export interface LoopOutcome {
  kept: { link: string; reference: CommitmentReference; state: RailState | 'unread' }
  cancelled: {
    link: string
    reference: CommitmentReference
    cancelledAt: bigint
    charge: LoopCharge
  }
}

/** Why the run stopped before it finished, with Avow's reason code where one applies. */
export class LoopStopped extends Error {
  readonly reason: ReasonCode | null
  constructor(message: string, reason: ReasonCode | null, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'LoopStopped'
    this.reason = reason
  }
}

/** What the run stands on, which `sandboxLoop` builds from the agent's folder. */
export interface LoopDeps {
  /** Avow's demo GPU supplier, by its business id, and the name it goes by. */
  supplier: { id: string; name: string }
  /** The reserve of each booking, in dollars. */
  reserve: number
  agent: Pick<
    SandboxAgent,
    'suppliers' | 'mandate' | 'mandateHash' | 'check' | 'left' | 'dailyLeft' | 'book'
  >
  /** Asks Avow to record the business cancelling a commitment, with Avow's own time. */
  cancel(commitmentId: Hex): Promise<{ cancelledAt: bigint }>
  /** Asks the demo supplier to report the late-cancellation charge on one of its bookings. */
  askForLateCharge(commitmentId: Hex, mandate: Mandate): Promise<LateChargeReport>
  /** What the business's lock holds for a commitment now, or null when it holds nothing. */
  backing(commitmentId: Hex): Promise<LockedBacking | null>
  /** Seconds Avow keeps a late cancellation from each moment it's measured against. */
  clockMargin: bigint
  /** Unix seconds. */
  now(): bigint
  sleep(ms: number): Promise<void>
  onStep(step: LoopStep): void
}

const POLL_MS = 5000
/** Seconds past a deadline the run waits for Avow's clock, or its settlement service, to act. */
const SLACK = 10n
/** Seconds Avow takes at most to confirm or refer a report on testnet, with a minute to spare. */
const CONFIRM_WITHIN = 360n
/** Seconds past the release date the run waits for the release before it reports where it stands. */
const RELEASE_WITHIN = 300n

/** Runs the loop, as the module's comment sets out. */
export async function runLoop(d: LoopDeps): Promise<LoopOutcome> {
  const { agent, supplier } = d
  const reserve = micros(d.reserve, 'reserve')
  const booking: SandboxBooking = {
    supplier: supplier.id,
    resource: LOOP_RESOURCE,
    reserve: d.reserve,
  }

  // Everything that would stop the run part way is read first, so nothing is booked for a run
  // that can't finish.
  if (!agent.suppliers.some((s) => s.id === supplier.id)) {
    throw new LoopStopped(
      `Your agent's mandate doesn't name ${supplier.name}, ${supplier.id}, so it can't book there. Ask your administrator to add it to the agent's suppliers in the console, then run this again.`,
      'mandate.supplier_not_allowed',
    )
  }
  if (!agent.mandate.message.actions.includes('cancel')) {
    throw new LoopStopped(
      "Your agent's mandate doesn't let it cancel, so it can't show a late cancellation. Ask your administrator for a mandate that does, then run this again.",
      'mandate.action_not_permitted',
    )
  }
  const checked = await agent.check(booking)
  if (!checked.passes) {
    throw new LoopStopped(
      `A $${d.reserve} booking wouldn't pass right now. The ${checked.layer} refuses it with ${checked.code}.`,
      checked.code,
    )
  }
  const [left, dailyLeft] = await Promise.all([agent.left(), agent.dailyLeft()])
  const toMicros = (dollars: number) => BigInt(Math.round(dollars * 1_000_000))
  if (toMicros(left) < 2n * reserve) {
    throw new LoopStopped(
      `The run books two reserves of $${d.reserve} at once, and your agent has $${left} of authority left. Run it with a smaller --reserve.`,
      'mandate.over_open_reserves_cap',
    )
  }
  if (dailyLeft !== null && toMicros(dailyLeft) < 2n * reserve) {
    throw new LoopStopped(
      `The run moves two reserves of $${d.reserve}, and your agent's key can move $${dailyLeft} more today. Run it with a smaller --reserve, or tomorrow.`,
      'keychain.over_daily_limit',
    )
  }

  // The booking to cancel goes first, so its free cancellation ends first.
  const late = await book(d, 'cancelled', booking)
  const kept = await book(d, 'kept', booking)
  const [lateAccepted, keptAccepted] = await Promise.all([
    late.commitment.accepted(),
    kept.commitment.accepted(),
  ])
  for (const [role, accepted] of [
    ['cancelled', lateAccepted],
    ['kept', keptAccepted],
  ] as const) {
    if (!accepted) {
      throw new LoopStopped(
        `${supplier.name} didn't accept the booking to be ${role} before its deadline, so the lock gives the reserve back and the run stops.`,
        null,
      )
    }
    d.onStep({ type: 'accepted', role })
  }

  // Avow confirms the charge only for a cancellation the clock margin inside the late window, which
  // opens when free cancellation ends and closes when a no-show can be reported, and the margin
  // before the report.
  const margin = d.clockMargin + SLACK
  const cancelFrom = late.freeCancelBy + margin
  const cancelBy = late.noShowFrom - margin
  if (d.now() < cancelFrom) {
    d.onStep({ type: 'waiting', until: cancelFrom, for: 'free_cancellation' })
    await waitUntil(d, cancelFrom)
  }
  if (d.now() > cancelBy) {
    throw new LoopStopped(
      'The late window closed before the run could cancel inside it, so it stops. The lock releases both reserves at their release dates.',
      null,
    )
  }
  const id = late.commitment.reference.commitmentId
  const { cancelledAt } = await cancelOnce(d, id)
  d.onStep({ type: 'cancelled', cancelledAt })
  await waitUntil(d, cancelledAt + margin)
  const report = await d.askForLateCharge(id, late.mandate)
  d.onStep({ type: 'reported', amount: report.amount, transaction: report.transaction })

  const confirmBy = d.now() + CONFIRM_WITHIN
  d.onStep({ type: 'waiting', until: confirmBy, for: 'confirmation' })
  const releaseBy = kept.releaseDate + RELEASE_WITHIN
  const [charge, keptState] = await Promise.all([
    followCharge(d, id, report, confirmBy, late.contestWindow),
    follow(d, kept.commitment.reference.commitmentId, releaseBy, (b) => b?.state === 'released'),
  ])
  return {
    kept: {
      link: kept.commitment.link,
      reference: kept.commitment.reference,
      state: keptState === undefined ? 'unread' : (keptState?.state ?? 'none'),
    },
    cancelled: {
      link: late.commitment.link,
      reference: late.commitment.reference,
      cancelledAt,
      charge,
    },
  }
}

/** One booking, with the mandate it was made under and the times its terms set. */
async function book(d: LoopDeps, role: LoopRole, booking: SandboxBooking) {
  d.onStep({ type: 'booking', role })
  const commitment: SandboxCommitment = await d.agent.book(booking)
  const { terms, agreement } = commitment.commitment
  // The supplier takes a request about a booking only with the mandate its agreement names.
  const mandate = d.agent.mandate
  if (agreement.message.mandateHash.toLowerCase() !== d.agent.mandateHash.toLowerCase()) {
    throw new LoopStopped(
      "Your administrator replaced the agent's mandate while it booked, so the run stops. Run it again.",
      null,
    )
  }
  const freeCancelBy = terms.remedies.freeCancelBy
  const noShow = terms.remedies.charges.find((c) => c.kind === 'noShow')
  const noShowFrom = noShow ? noShow.earliest : terms.remedies.chargeDeadline
  const releaseDate = terms.backing.releaseDate
  d.onStep({
    type: 'booked',
    role,
    link: commitment.link,
    reference: commitment.reference,
    reserve: terms.backing.amount,
    freeCancelBy,
    releaseDate,
  })
  return {
    commitment,
    mandate: mandate.message,
    freeCancelBy,
    noShowFrom,
    releaseDate,
    contestWindow: terms.resolution.contestWindow,
  }
}

/**
 * Asks Avow to record the cancellation, asking again a little later while Avow's clock says free
 * cancellation is still open, since its clock and this machine's can differ by a few seconds.
 */
async function cancelOnce(d: LoopDeps, id: Hex): Promise<{ cancelledAt: bigint }> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await d.cancel(id)
    } catch (error) {
      const early = error instanceof AvowApiError && error.reason === 'commitment.cancel_on_lock'
      if (!early || attempt >= 4) {
        const reason = error instanceof AvowApiError ? error.reason : null
        throw new LoopStopped(
          `Avow didn't record the cancellation: ${error instanceof Error ? error.message : String(error)}`,
          reason,
          { cause: error },
        )
      }
      await d.sleep(POLL_MS * 2)
    }
  }
}

async function waitUntil(d: LoopDeps, at: bigint): Promise<void> {
  while (d.now() < at) {
    const ms = Number(at - d.now()) * 1000
    await d.sleep(Math.min(ms, POLL_MS))
  }
}

/**
 * Reads a commitment on the lock until `done` holds or `until` passes, and gives the last read, or
 * undefined when no read succeeded. A read that fails is read again.
 */
async function follow(
  d: LoopDeps,
  id: Hex,
  until: bigint,
  done: (b: LockedBacking | null) => boolean,
): Promise<LockedBacking | null | undefined> {
  let last: LockedBacking | null | undefined
  for (;;) {
    const read = await d.backing(id).catch(() => undefined)
    if (read !== undefined) last = read
    if (read !== undefined && done(read)) return read
    if (d.now() >= until) return last
    await d.sleep(POLL_MS)
  }
}

/** Follows a report until Avow confirms it or refers it to a ruling, or the wait runs out. */
async function followCharge(
  d: LoopDeps,
  id: Hex,
  report: LateChargeReport,
  until: bigint,
  contestWindow: bigint,
): Promise<LoopCharge> {
  const answered = (b: LockedBacking | null) =>
    b !== null && !(b.state === 'accepted' && b.hasReport)
  const held = await follow(d, id, until, answered)
  const outcome = chargeOutcome(held, report.outcome)
  return {
    amount: report.amount,
    transaction: report.transaction,
    outcome,
    paysAt:
      outcome === 'confirmed' && held && held.chargeStart > 0n
        ? held.chargeStart + contestWindow
        : null,
  }
}

/** What the lock shows of a report, in the supplier's words for it. */
function chargeOutcome(
  held: LockedBacking | null | undefined,
  reported: LateChargeOutcome,
): LateChargeOutcome {
  if (held === undefined) return reported
  if (held === null) return 'ended'
  switch (held.state) {
    case 'accepted':
      return held.hasReport ? 'awaiting_avow' : 'withdrawn'
    case 'charge_pending':
      return 'confirmed'
    case 'charged':
      return 'charged'
    case 'paused':
      return 'ruling'
    default:
      return 'ended'
  }
}

export interface SandboxLoopOptions
  extends Pick<SandboxAgentOptions, 'fetch' | 'store' | 'screenUrl' | 'deployment' | 'log'> {
  /** The reserve of each booking, in dollars, `LOOP_RESERVE` by default. */
  reserve?: number
  onStep?: (step: LoopStep) => void
}

/**
 * Runs the loop from the agent in the store, with only the agent's own key, against the demo GPU
 * supplier the deployment names.
 */
export async function sandboxLoop(options: SandboxLoopOptions = {}): Promise<LoopOutcome> {
  const { send, deployment, agentKey, domain, store, screenUrl } = await agentContext(options)
  const profile = await httpSupplier(deployment.supplierUrl, send)
  const supplierId = profile.profile.businessId
  const agent = await sandboxAgent({
    store,
    screenUrl,
    deployment,
    session: null,
    fetch: send,
    ...(options.log ? { log: options.log } : {}),
  })
  const client = moderatoClient(deployment.rpcUrl)
  const records = httpAvowApi({
    baseUrl: deployment.apiUrl,
    key: agentRequestKey(agentKey),
    domain,
    retryFor: 120n,
    fetch: send,
  }).records
  return runLoop({
    supplier: { id: supplierId, name: `Avow's demo GPU supplier${TEST_BUSINESS_SUFFIX}` },
    reserve: options.reserve ?? LOOP_RESERVE,
    clockMargin: AVOW_CLOCK_MARGIN,
    agent,
    cancel: (commitmentId) => records.cancel({ commitmentId }),
    askForLateCharge: (commitmentId, mandate) =>
      askForLateCharge({
        supplierUrl: deployment.supplierUrl,
        key: agentRequestKey(agentKey),
        domain,
        commitmentId,
        mandate,
        fetch: send,
      }),
    backing: (commitmentId) => readBacking(client, domain.verifyingContract, commitmentId, 'buyer'),
    now: () => BigInt(Math.floor(Date.now() / 1000)),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    onStep: options.onStep ?? (() => {}),
  })
}
