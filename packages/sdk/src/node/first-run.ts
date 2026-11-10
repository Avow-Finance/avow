import { formatUsd, type OrderScenario, type SessionEvent } from '@avow-finance/spec'
import type { Rail } from '@avow-finance/terminal'
import type { JobOutcome } from '../session/executor.js'
import { JOB_COMMAND, type SessionInput } from '../session/session.js'

/** How many steps a first run has, two of setup's and three of the agent session's. */
export const FIRST_RUN_STEPS = 5

/**
 * The guide for the last three steps of a first run, which the agent session runs. Step 3 is the
 * first job, shown as two commitments with nothing prepaid. Step 4 is a broken promise: the
 * developer takes an order the customer cancels after work starts, and the charge its terms allow
 * is reported and confirmed while its contest window stays open. Step 5 breaks the chain between
 * the two commitments: one more order with the compute booking held off, which the customer
 * refuses. The guide draws the steps, asks for the scenario and holds the switch, and the session
 * does everything else as it does on any run.
 */
export interface FirstRunGuide {
  /** Opens step 3, before the first job. */
  start(): void
  /** Sees each event, for the amounts and dates the step's last line says. */
  watch(event: SessionEvent): void
  /** How a job ended, which closes the step it belonged to. */
  afterJob(outcome: JobOutcome | null): void
  /** Whether the order being taken goes without a compute booking. */
  withoutCompute(): boolean
  /** The scenario the order being taken is asked for, or null for none. */
  scenario(): OrderScenario | null
  /** The developer's input, watched for the job command steps 4 and 5 ask for. */
  input: SessionInput
}

const PAUSED_SINCE = {
  contested: 'the customer contested it',
  referred: "Avow's records didn't support the report",
  unanswered: "Avow didn't answer the report in time",
} as const

/** Where a cancelled job's charge stands, in one or two sentences. */
function chargeLine(
  ended: Extract<JobOutcome, { kind: 'cancelled' }>,
  clock: (unixSeconds: bigint) => string,
): string {
  const broke = 'The customer cancelled after work started.'
  if ('refused' in ended.charge) {
    return `${broke} Your code couldn't report the charge (${ended.charge.refused}), so the customer's reserve stands as it was.`
  }
  const { amount, standing } = ended.charge
  const charge = `${formatUsd(amount)} charge`
  switch (standing.state) {
    case 'confirmed':
      return `${broke} Your code reported the ${charge} its terms allow, and Avow confirmed it from its record of the customer's signed cancellation. The customer can contest it until ${clock(standing.contestableUntil)}, which would pause it for a ruling, and it's payable to you then if it hasn't.`
    case 'paid':
      return `${broke} The ${charge} was reported, confirmed and paid to your business.`
    case 'paused':
      return `${broke} Your code reported the ${charge}, and it's paused for a ruling since ${PAUSED_SINCE[standing.cause]}. Nothing pays until a ruling is posted.`
    default:
      return `${broke} Your code reported the ${charge}, and Avow hasn't answered the report yet.`
  }
}

const utc = (seconds: bigint) =>
  `${new Date(Number(seconds) * 1000).toISOString().slice(11, 16)} UTC`

/** How a job ended, in one line. */
export function outcomeLine(
  ended: JobOutcome | null,
  clock: (unixSeconds: bigint) => string = utc,
): string {
  if (ended?.kind === 'cancelled') return chargeLine(ended, clock)
  return ended?.kind === 'paid'
    ? 'The job is done and paid. Both reserves come back by themselves at their release dates.'
    : ended?.kind === 'refused'
      ? `The customer refused the quote with ${ended.refusal.code}, so no work started.`
      : ended?.kind === 'not_started'
        ? `Your side didn't accept the job, with ${ended.code} at the ${ended.layer} layer, so no work started.`
        : ended?.kind === 'stopped'
          ? ended.why
          : 'No quote went out, so the job ended there.'
}

export function firstRunGuide(deps: {
  rail: Rail
  input: SessionInput
  /** How the guide says a moment. */
  clock: (unixSeconds: bigint) => string
  /** Writes a line the rail doesn't wrap, so a link stays whole. */
  write: (text: string) => void
  /** A transaction's page in the chain's explorer, or null where there's no chain to show. */
  transactionUrl: ((hash: `0x${string}`) => string) | null
  /** How to get a model, said at the end when the scripted decisions ran for want of one. */
  modelHelp: string | null
}): FirstRunGuide {
  const { rail } = deps
  let stage: 'first job' | 'asking to cancel' | 'cancelling' | 'asking' | 'breaking' | 'done' =
    'first job'
  /** The transaction that carried the report of the charge, once there is one. */
  let reportedIn: `0x${string}` | null = null
  /** What the first job's events said, for the line that closes step 3. */
  const job: {
    price: bigint | null
    reserves: bigint[]
    releases: bigint[]
    payment: `0x${string}` | null
  } = { price: null, reserves: [], releases: [], payment: null }

  /** The first job's last line: what was paid, that nothing was prepaid, and when reserves return. */
  function firstJobLine(outcome: JobOutcome | null): string {
    if (outcome?.kind !== 'paid' || job.price === null || job.releases.length === 0) {
      return outcomeLine(outcome)
    }
    const latest = job.releases.reduce((a, b) => (b > a ? b : a))
    const set =
      job.reserves.length === 2
        ? `The ${formatUsd(job.reserves[0] as bigint)} and ${formatUsd(job.reserves[1] as bigint)} set aside`
        : 'What each side set aside'
    return `Delivered, and paid ${formatUsd(job.price)} on delivery with nothing prepaid. ${set} never moved, and go back on their own by ${deps.clock(latest)}.`
  }

  function end(): void {
    rail.quiet(
      "You're set up. Type job for another order, job cancels for one the customer cancels, or ask your agent why it chose that compute.",
    )
    rail.quiet(
      "npm run bypass tries your agent's key against the chain without Avow's SDK, and npm run mcp:claude-code lets Claude drive your agent. Ctrl+C ends the session.",
    )
    if (deps.modelHelp) rail.quiet(deps.modelHelp)
  }

  return {
    start() {
      rail.step(
        3,
        FIRST_RUN_STEPS,
        'Two commitments, nothing prepaid',
        "Avow's test customer offers your agent a job, paid on delivery. Each side sets aside only what breaking its promise would cost, and checks the other's commitment before it moves.",
      )
    },
    watch(event) {
      if (event.type === 'job_charge_reported') reportedIn = event.transactionHash
      if (stage !== 'first job') return
      if (event.type === 'job_order_received') job.price = event.price
      else if (event.type === 'job_compute_secured' || event.type === 'job_commitment_checked') {
        // The customer's reserve is said first, so it goes ahead of the compute reserve.
        if (event.type === 'job_commitment_checked') job.reserves.unshift(event.amount)
        else job.reserves.push(event.amount)
        job.releases.push(event.releaseDate)
      } else if (event.type === 'job_paid') job.payment = event.payment.transactionHash
    },
    afterJob(outcome) {
      if (stage === 'first job') {
        rail.stepDone(firstJobLine(outcome), { keep: true })
        if (outcome?.kind === 'paid' && job.payment && deps.transactionUrl) {
          rail.quiet('The payment, on chain for anyone to check:')
          rail.settle()
          deps.write(`${rail.prefix}${deps.transactionUrl(job.payment)}\n`)
        }
        rail.step(
          4,
          FIRST_RUN_STEPS,
          'A broken promise',
          'A promise counts when breaking it costs something. On the next order the customer cancels after your work starts, and its reserve backs a charge for that. Type job and press Enter.',
        )
        stage = 'asking to cancel'
      } else if (stage === 'cancelling') {
        rail.stepDone(
          outcome?.kind === 'cancelled'
            ? outcomeLine(outcome, deps.clock)
            : `That order ended another way. ${outcomeLine(outcome, deps.clock)}`,
          { keep: true },
        )
        if (reportedIn && deps.transactionUrl) {
          rail.quiet('The report of the charge, on chain for anyone to check:')
          rail.settle()
          deps.write(`${rail.prefix}${deps.transactionUrl(reportedIn)}\n`)
        }
        rail.step(
          5,
          FIRST_RUN_STEPS,
          'Break the chain',
          "While that window runs, see what holds the two commitments together. The customer's commitment depends on yours. Take the next order without booking compute and see what the customer does. Type job and press Enter.",
        )
        stage = 'asking'
      } else if (stage === 'breaking') {
        rail.stepDone(
          outcome?.kind === 'refused'
            ? "The customer refused, and nobody's money moved. Its commitment depends on your compute commitment, and it found none to check. Its check verifies the money and the terms behind your promise. It doesn't promise the compute gets delivered."
            : `That order ended another way. ${outcomeLine(outcome, deps.clock)}`,
          { keep: true },
        )
        end()
        stage = 'done'
      }
    },
    withoutCompute: () => stage === 'breaking',
    scenario: () => (stage === 'cancelling' ? 'cancels_late' : null),
    input: {
      inFlight: (what) => deps.input.inFlight(what),
      async next() {
        const line = await deps.input.next()
        if (line !== null && JOB_COMMAND.test(line.trim())) {
          if (stage === 'asking to cancel') stage = 'cancelling'
          else if (stage === 'asking') stage = 'breaking'
        }
        return line
      },
    },
  }
}
