import {
  type CardClock,
  type CommitmentCard,
  type CommitmentReference,
  commitmentCards,
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

/** A moment as the terminal says it, in the clock of the machine it runs on. */
export const localClock: CardClock = (seconds) =>
  new Date(Number(seconds) * 1000).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })

const CARD_NAMES: Record<CommitmentCard['role'], string> = { job: 'JOB', compute: 'COMPUTE' }

/** The tools whose result a code-written job line already says, so a brief view leaves it out. */
const SAID_BY_JOB_LINES = new Set(['read_order', 'book_compute', 'submit_quote', 'cancel_compute'])

/** A 32-character id, such as an order's, cut to its first six characters for a brief view. */
const LONG_ID = /\b([0-9a-f]{6})[0-9a-f]{26}\b/g

/**
 * The rail view. Each commitment draws as a card once it's accepted, the compute booking when its
 * supplier accepted it and the job when the business's own code did. A brief view, the default,
 * draws each thing once beside the cards, in the job lines code writes, and leaves the tool calls,
 * the customer's words and the commitment receipts to the details and to the screen, which shows
 * everything.
 */
export function railView(
  rail: Rail,
  look: Look,
  options: {
    fixture: boolean
    write: (text: string) => void
    brief?: boolean
    /** How a card says a moment, the machine's own clock by default. */
    clock?: CardClock
  },
): SessionView {
  const { fixture } = options
  const brief = options.brief === true
  const clock = options.clock ?? localClock
  /** Every event so far, which a card's rows are read from. */
  const seen: SessionEvent[] = []
  /** Draws the card of an order's commitment, saying so when it's the fixture world's. */
  const card = (orderId: string, role: CommitmentCard['role']) => {
    const drawn = commitmentCards(seen, orderId, clock).find((c) => c.role === role)
    if (!drawn) return
    rail.card({
      name: CARD_NAMES[role],
      from: drawn.from,
      to: drawn.to,
      state: fixture ? `${drawn.promise} in the fixture world` : drawn.promise,
      ...(drawn.promise === 'broken' ? { broken: true } : {}),
      rows: drawn.rows,
    })
  }
  const shown = (text: string) => (brief ? text.replace(LONG_ID, '$1') : text)
  /** The last refusal drawn, so a brief view leaves out the tool result that says it again. */
  let refusal: string | null = null
  const fixtureLine = (
    e: { verifiedBy: keyof typeof WHO; block: { number: bigint } },
    text: string,
  ) => rail.line(`In the fixture world at block ${e.block.number}, ${WHO[e.verifiedBy]}. ${text}`)

  function draw(e: SessionEvent): void {
    seen.push(e)
    switch (e.type) {
      case 'said':
        // A model's words drew as they arrived. The customer's draw now, under its name.
        if (e.speaker.kind === 'customer' && !brief) rail.said(TEST_CUSTOMER_LABEL, e.text)
        return
      case 'tool_call':
        if (!brief) rail.call(e.tool, e.summary)
        return
      case 'tool_result':
        if (e.recalled) return
        if (brief && e.ok && SAID_BY_JOB_LINES.has(e.tool)) return
        if (brief && !e.ok && refusal?.startsWith(e.summary)) return
        rail.returned(e.ok, shown(e.ok ? e.summary : `${e.summary} (${e.layer}, ${e.code})`))
        return
      case 'fact':
        // A brief view leaves each check's own line to the details, since the cards carry them.
        if (brief) return
        if (fixture) fixtureLine(e, e.text)
        else rail.fact({ ...evidenceOf(e, e.reference), text: e.text })
        return
      case 'commitment': {
        const title =
          e.role === 'job'
            ? "The job: the customer's commitment to your business"
            : 'Your compute booking'
        if (brief) return
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
        refusal = refusalSentence(e)
        rail.fail(shown(refusal))
        return
      case 'job_customer_verifying':
        // The customer's answer follows at once, so a brief view waits for it.
        if (!brief) rail.done(jobEventSentence(e))
        return
      case 'job_compute_secured':
        // The card says what the sentence does, so a brief view draws the card alone.
        if (!brief) rail.done(jobEventSentence(e))
        card(e.orderId, 'compute')
        return
      case 'job_commitment_checked': {
        const sentence = e.acceptedIn === null ? RECOVERED_DECISIVE_SENTENCE : DECISIVE_SENTENCE
        card(e.orderId, 'job')
        if (brief) {
          rail.done(sentence)
          return
        }
        rail.settle()
        options.write(`${setApart(look, [sentence])}\n`)
        return
      }
      case 'job_commitment_refused':
      case 'job_customer_refused':
        rail.fail(shown(jobEventSentence(e)))
        return
      case 'job_charge_confirmed':
      case 'job_charge_paused':
      case 'job_charge_paid':
        // The card says the promise is broken and where the money stands, each on its own row.
        rail.done(shown(jobEventSentence(e)))
        card(e.orderId, 'job')
        return
      case 'job_work_started':
        rail.done(shown(jobEventSentence(e)))
        rail.quiet(SIMULATED_LINE)
        return
      default:
        if (e.type.startsWith('job_'))
          rail.done(shown(jobEventSentence(e as Parameters<typeof jobEventSentence>[0])))
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
          speech.write(shown(piece))
        },
        end: () => speech?.end(),
      }
    },
    quiet: (line) => rail.quiet(line),
    fail: (line) => rail.fail(line),
    evidence: (table) => rail.table({ ...table, notes: [...table.notes] }),
  }
}
