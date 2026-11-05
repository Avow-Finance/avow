import type { PinnedBlock } from './dependencies.js'
import type { ChargeKind } from './eip712.js'
import type { CommitmentRefusalLayer, JobCharge, JobEvent, JobRelease } from './job-session.js'
import { describeReason, type ReasonCode } from './reasons.js'
import { formatUsd } from './sandbox.js'
import { type CustomerRefusalLayer, TEST_CUSTOMER_LABEL } from './test-customer.js'

/**
 * The words a job's terminal and its screen both say, so the two never tell the story
 * differently. Every statement matches a check that ran, and a check's statement names the block
 * it read and says nothing beyond it.
 */

/**
 * The decisive moment. The customer made its reserve, the developer's code checked it, and the
 * customer accepted only after it verified the compute booking.
 */
export const DECISIVE_SENTENCE =
  "Your code verified the customer's commitment and checked its reserve. Work can now begin. The customer accepted after verifying your compute booking."

/** What a compute booking proves, and what it doesn't. */
export const COMPUTE_PROVES =
  "Your compute booking proves a required input is committed. It doesn't prove your agent will finish the job."

/** The two reserves stay apart. */
export const SEPARATE_RESERVES =
  "The customer's reserve backs the job, and your reserve backs the compute. Naming a booking moves no money and compensates nobody automatically. Nothing backs your own delivery promise with money in v1."

/** What a check of a booking relied on proves. */
export const CHECK_BOUNDARY =
  'Each check proves the state at the block it read. Nothing makes the steps atomic, and nothing in Avow stops your business cancelling its compute after the customer accepted.'

/** What holds when the compute goes away after the customer accepted. */
export const AFTER_ACCEPTANCE =
  "If your compute is cancelled or fails after the customer accepted, the job commitment stands, and your business still answers to the customer under the job's own terms. It finds other capacity or releases the job with the reason supplier failed."

/** What's simulated and what's real, said in one plain line wherever the work appears. */
export const SIMULATED_LINE =
  'The GPUs and the training are simulated. Every commitment, reserve, check and payment is a real testnet operation.'

/** The label of the result a delivery hands over, which says plainly that it's a placeholder. */
export const SIMULATED_RESULT_LABEL =
  'Simulated fine-tuning result, a placeholder, since no model was trained'

/** The first challenge, which the prescribed edit answers. */
export const REFUSAL_CHALLENGE = 'Remove the compute booking. Would the customer still accept?'

/** The file and the flag beside the one line that books the compute. */
export const REFUSAL_EDIT = { file: 'service.ts', flag: 'bookCompute' } as const

/** How to make the prescribed refusal. */
export const REFUSAL_INSTRUCTION = `Delete the marked line in ${REFUSAL_EDIT.file} that books the compute, or set ${REFUSAL_EDIT.flag} to false beside it, then run npm run job again.`

/** Each charge kind as the job's words name it, with its cap. */
const CHARGE_WORDS: Record<ChargeKind, (cap: string) => string> = {
  lateCancellation: (cap) => `a late cancellation after work has started, up to ${cap}`,
  noShow: (cap) =>
    `a no-show, up to ${cap}, if the customer doesn't hand over the work's inputs in time`,
}

/**
 * What the customer's reserve backs. It backs only what the job's terms let the developer charge
 * if the customer walks away, and never the price, which arrives as its own transfer.
 */
export function reserveLine(charges: readonly JobCharge[]): string {
  const named = charges.map((c) => CHARGE_WORDS[c.kind](formatUsd(c.amount)))
  return `The customer's reserve backs what the job's terms let you charge if the customer walks away. That's ${named.join(', or ')}. The job's price arrives as a separate transfer on delivery, and the reserve doesn't secure it.`
}

/** A block as a statement names it. */
export const atBlock = (block: Pick<PinnedBlock, 'number'>) => `at block ${block.number}`

const CUSTOMER_WHO: Record<CustomerRefusalLayer, string> = {
  customer: 'The customer refused your quote',
  avow: "Avow refused to approve the customer's reserve",
  relay: "Avow's relay refused to send the customer's reserve",
  lock: "The customer's lock refused its reserve",
  keychain: "The customer's keychain refused its reserve",
  unknown: "The customer's reserve never landed",
}

const SUPPLIER_WHO: Record<CommitmentRefusalLayer, string> = {
  supplier: "Your code refused the customer's commitment",
  relay: "Avow's relay refused to send your acceptance",
  lock: "The customer's lock refused your acceptance",
}

const RELEASED: Record<JobRelease['way'], string> = {
  consent: "by its supplier's consent",
  free_cancellation: 'by free cancellation',
  release_date: 'at its release date',
  unaccepted: 'in full, since nobody accepted it',
}

function released(release: JobRelease): string {
  if (release.way !== 'consent') return RELEASED[release.way]
  const reason = release.reason === 'kept' ? 'kept' : 'supplier failed'
  return `${RELEASED.consent}, which gave the reason ${reason}`
}

const refusalTail = (code: ReasonCode, block: PinnedBlock | null) =>
  `${describeReason(code)}${block ? `, ${atBlock(block)}` : ''}.`

/** The one sentence the terminal prints and the screen shows for a job's event. */
export function jobEventSentence(event: JobEvent): string {
  switch (event.type) {
    case 'job_order_received':
      return `${TEST_CUSTOMER_LABEL} offered a job for ${formatUsd(event.price)}. Before it accepts, it needs to verify the compute your quote relies on.`
    case 'job_compute_secured':
      return `Your agent booked compute from ${event.supplier}, which accepted it. Your business reserved ${formatUsd(event.amount)} for it in its own lock.`
    case 'job_quote_sent':
      return event.compute
        ? 'Your code quoted the job, naming your compute booking.'
        : 'Your code quoted the job without naming any compute booking.'
    case 'job_customer_verifying':
      return 'The customer is verifying the compute booking your quote names.'
    case 'job_customer_verified': {
      const blocks = [...new Set(event.checks.map((c) => c.block.number))]
      return `${TEST_CUSTOMER_LABEL} says it verified your compute booking at block ${blocks.join(' and ')}.`
    }
    case 'job_customer_refused':
      return `${CUSTOMER_WHO[event.refusal.layer]}. ${refusalTail(event.refusal.code, event.refusal.block)}`
    case 'job_commitment_checked':
      return DECISIVE_SENTENCE
    case 'job_commitment_refused':
      return `${SUPPLIER_WHO[event.layer]}. ${refusalTail(event.code, event.block)}`
    case 'job_work_started':
      return "Work started, and the customer's free cancellation has ended."
    case 'job_delivered':
      return 'Your code reported delivery to the customer and handed over a placeholder result, since the training is simulated.'
    case 'job_paid':
      return "The customer paid the job's price by a transfer whose memo names the job commitment. Anyone can check it on chain as a payment reference."
    case 'job_reserve_released':
      return event.role === 'job'
        ? `The customer's reserve came back to it ${released(event.release)}.`
        : `Your compute reserve came back to your business ${released(event.release)}.`
  }
}
