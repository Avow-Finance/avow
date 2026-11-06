import {
  type CommitmentReference,
  DECISIVE_SENTENCE,
  formatUsd,
  jobEventSentence,
  RECOVERED_DECISIVE_SENTENCE,
  refusalSentence,
  type SessionEvent,
  SIMULATED_LINE,
  TEST_CUSTOMER_LABEL,
} from '@avow-finance/spec'
import { type Evidence, type Look, type Rail, setApart } from '@avow-finance/terminal'
import { verifyUrl } from '../sandbox/session.js'
import type { SessionView } from '../session/session.js'

/**
 * The session drawn on the rail. Each event draws as the session makes it, so the terminal and the
 * screen show the same things. Speech draws under its speaker's name and evidence draws as facts
 * and receipts with their block and reference, never the one as the other. A fixture world's facts
 * and receipts draw as plain lines that say they're the fixture's, so none can pass for a read of
 * the chain.
 */

const JOB_STATES = ['reserved', 'accepted', 'released'] as const

function evidenceOf(
  e: {
    verifiedBy: Evidence['verifiedBy']
    block: { number: bigint }
    transactionHash: string | null
  },
  reference: CommitmentReference,
): Evidence {
  return {
    verifiedBy: e.verifiedBy,
    block: e.block.number,
    reference: {
      chain: reference.chainId,
      lock: reference.lock,
      commitmentId: reference.commitmentId,
      side: reference.side,
    },
    ...(e.transactionHash ? { transactionHash: e.transactionHash as `0x${string}` } : {}),
  }
}

/** Who checked, as the rail says it for a chain read, here for the fixture world's own lines. */
const WHO = {
  service: 'checked by your service.ts',
  customer: "Avow's test customer says it checked",
  avow: "checked by Avow's API",
}

export function railView(
  rail: Rail,
  look: Look,
  options: { fixture: boolean; write: (text: string) => void },
): SessionView {
  const { fixture } = options
  const fixtureLine = (
    e: { verifiedBy: keyof typeof WHO; block: { number: bigint } },
    text: string,
  ) => rail.line(`In the fixture world at block ${e.block.number}, ${WHO[e.verifiedBy]}. ${text}`)

  function draw(e: SessionEvent): void {
    switch (e.type) {
      case 'said':
        // A model's words drew as they arrived. The customer's draw now, under its name.
        if (e.speaker.kind === 'customer') rail.said(TEST_CUSTOMER_LABEL, e.text)
        return
      case 'tool_call':
        rail.call(e.tool, e.summary)
        return
      case 'tool_result':
        if (e.recalled) return
        rail.returned(e.ok, e.ok ? e.summary : `${e.summary} (${e.layer}, ${e.code})`)
        return
      case 'fact':
        if (fixture) fixtureLine(e, e.text)
        else rail.fact({ ...evidenceOf(e, e.reference), text: e.text })
        return
      case 'commitment': {
        const title =
          e.role === 'job'
            ? "The job: the customer's commitment to your business"
            : 'Your compute booking'
        if (fixture) {
          fixtureLine(e, `${title} is ${e.state}, with ${formatUsd(e.amount)} reserved.`)
          return
        }
        const at = JOB_STATES.indexOf(e.state as (typeof JOB_STATES)[number])
        rail.receipt({
          title,
          lines: [
            e.role === 'job'
              ? `Avow's test customer reserved ${formatUsd(e.amount)} in its own lock for your business.`
              : `Your business reserved ${formatUsd(e.amount)} in its own lock for the GPU supplier.`,
          ],
          states: JOB_STATES.map((name, i) => ({ name, reached: at >= i })),
          evidence: evidenceOf(e, e.reference),
          link: verifyUrl(e.reference, undefined),
        })
        return
      }
      case 'refused':
        rail.fail(refusalSentence(e))
        return
      case 'job_commitment_checked': {
        const sentence = e.acceptedIn === null ? RECOVERED_DECISIVE_SENTENCE : DECISIVE_SENTENCE
        rail.settle()
        options.write(`${setApart(look, [sentence])}\n`)
        return
      }
      case 'job_commitment_refused':
      case 'job_customer_refused':
        rail.fail(jobEventSentence(e))
        return
      case 'job_work_started':
        rail.done(jobEventSentence(e))
        rail.quiet(SIMULATED_LINE)
        return
      default:
        if (e.type.startsWith('job_'))
          rail.done(jobEventSentence(e as Parameters<typeof jobEventSentence>[0]))
    }
  }

  return {
    intro(lines) {
      if (fixture)
        rail.stage(
          'The fixture world, in memory, for tests and the eval. Nothing here is on chain.',
        )
      for (const line of lines) rail.quiet(line)
    },
    event: draw,
    speak(model) {
      let speech: ReturnType<Rail['speak']> | null = null
      return {
        write: (piece) => {
          if (!piece) return
          speech ??= rail.speak(model)
          speech.write(piece)
        },
        end: () => speech?.end(),
      }
    },
    quiet: (line) => rail.quiet(line),
    fail: (line) => rail.fail(line),
    evidence: (table) => rail.table({ ...table, notes: [...table.notes] }),
  }
}
