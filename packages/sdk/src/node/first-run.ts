import { formatUsd, type SessionEvent } from '@avow-finance/spec'
import type { Rail } from '@avow-finance/terminal'
import type { JobOutcome } from '../session/executor.js'
import { JOB_COMMAND, type SessionInput } from '../session/session.js'

/**
 * The guide for the last two steps of a first run, which the agent session runs. Step 3 is the
 * first job, shown as two commitments with nothing prepaid. Step 4 breaks the chain between them:
 * the developer takes one more order with the compute booking held off, and the customer refuses
 * it. The guide draws the steps and holds the switch, and the session does everything else as it
 * does on any run.
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
  /** The developer's input, watched for the job command step 4 asks for. */
  input: SessionInput
}

/** How a job ended, in one line. */
export function outcomeLine(ended: JobOutcome | null): string {
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
  let stage: 'first job' | 'asking' | 'breaking' | 'done' = 'first job'
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
      "You're set up. Type job for another order, or ask your agent why it chose that compute.",
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
        4,
        'Two commitments, nothing prepaid',
        "Avow's test customer offers your agent a job, paid on delivery. Each side sets aside only what breaking its promise would cost, and checks the other's commitment before it moves.",
      )
    },
    watch(event) {
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
          4,
          'Break the chain',
          "The customer's commitment depends on yours. Take the next order without booking compute and see what the customer does. Type job and press Enter.",
        )
        stage = 'asking'
      } else if (stage === 'breaking') {
        rail.stepDone(
          outcome?.kind === 'refused'
            ? "The customer refused. Its commitment depends on your compute commitment, and with none to check, nobody's money moved."
            : `That order ended another way. ${outcomeLine(outcome)}`,
          { keep: true },
        )
        end()
        stage = 'done'
      }
    },
    withoutCompute: () => stage === 'breaking',
    input: {
      inFlight: (what) => deps.input.inFlight(what),
      async next() {
        const line = await deps.input.next()
        if (stage === 'asking' && line !== null && JOB_COMMAND.test(line.trim())) {
          stage = 'breaking'
        }
        return line
      },
    },
  }
}
