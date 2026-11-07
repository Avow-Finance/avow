import { SCRIPTED_MODEL } from '@avow-finance/spec'
import type {
  ChatTurn,
  ModelProvider,
  ModelReply,
  ModelToolCall,
  ReplyRequest,
} from './provider.js'

/**
 * Scripted decisions in place of a model, so a run is the same every time. It reads the tool
 * results the session gave it and decides as a careful agent would: the cheapest firm offer that
 * holds the job's GPUs for its whole run within the budget, then a quote naming that booking. It
 * speaks as `scripted`, so nothing it says can pass for a model's words.
 */

/** What the session says when an order comes in, which starts a job's run. */
export const ORDER_PROMPT = 'New order'
/** What the session says when the developer switched compute off and still wants a quote. */
export const SWITCH_OFF_PROMPT = 'switched compute off'
/** How the session's prompt starts when the customer refused a quote and the agent explains it. */
export const CUSTOMER_REFUSED_PROMPT = 'The customer refused the quote'

interface OfferSeen {
  id: string
  gpusPerBooking: string
  windowStarts: string
  windowEnds: string
  pricePerGpuHour: string
  freeCancellation: string
}

interface ListingSeen {
  offers: OfferSeen[]
  limits: { computeBudgetPerGpuHour: string; computeSwitch: 'on' | 'off' }
}

interface OrderSeen {
  orderId: string
  needs: { gpu: string; gpus: number }
  deliverBy: string
}

const dollars = (text: string) => Number(text.replace(/[^0-9.]/g, ''))

/** Minutes after the job starts that a time the tool layer wrote names, negative before it. */
function minutesFromStart(text: string): number | null {
  if (text.includes('when the job starts')) return 0
  const m = /(\d+) min (before|after) the job starts/.exec(text)
  if (!m) return null
  return Number(m[1]) * (m[2] === 'before' ? -1 : 1)
}

/** Whether an offer takes a booking of `count` GPUs, as the tool layer wrote its range. */
function takes(offer: OfferSeen, count: number): boolean {
  const exactly = /^exactly (\d+)$/.exec(offer.gpusPerBooking)
  if (exactly) return Number(exactly[1]) === count
  const range = /^(\d+) to (\d+)$/.exec(offer.gpusPerBooking)
  return range ? count >= Number(range[1]) && count <= Number(range[2]) : false
}

/** The offer a careful agent books for the order, or why there's none. */
export function chooseOffer(
  order: OrderSeen,
  listing: ListingSeen,
): { offer: OfferSeen } | { none: string } {
  const due = minutesFromStart(order.deliverBy) ?? 0
  const budget = dollars(listing.limits.computeBudgetPerGpuHour)
  const fits = listing.offers.filter((o) => {
    const from = minutesFromStart(o.windowStarts)
    const to = minutesFromStart(o.windowEnds)
    return (
      o.freeCancellation.startsWith('none') &&
      from !== null &&
      to !== null &&
      from <= 0 &&
      to >= due &&
      takes(o, order.needs.gpus)
    )
  })
  if (fits.length === 0) {
    return { none: 'none of the offers is firm and holds the GPUs for the whole job' }
  }
  const affordable = fits.filter((o) => dollars(o.pricePerGpuHour) <= budget)
  const [cheapest] = [...affordable].sort(
    (a, b) => dollars(a.pricePerGpuHour) - dollars(b.pricePerGpuHour),
  )
  if (!cheapest)
    return { none: `every offer that fits costs more than the $${budget.toFixed(2)} budget` }
  return { offer: cheapest }
}

/** The turns since the latest thing the developer or the session said. */
function sinceAsked(turns: readonly ChatTurn[]) {
  let i = turns.length - 1
  while (i >= 0 && turns[i]?.role !== 'user') i--
  const asked = turns[i]
  return {
    prompt: asked?.role === 'user' ? asked.text : '',
    results: turns
      .slice(i + 1)
      .filter((t): t is Extract<ChatTurn, { role: 'tool' }> => t.role === 'tool'),
  }
}

/** The latest result of a tool anywhere in the conversation, as the JSON it carried. */
function latest<T>(turns: readonly ChatTurn[], tool: string, ok = true): T | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]
    if (t?.role === 'tool' && t.call.name === tool && t.ok === ok) {
      try {
        return JSON.parse(t.content) as T
      } catch {
        return null
      }
    }
  }
  return null
}

let nextCall = 1
const call = (name: string, input: Record<string, unknown> = {}): ModelToolCall => ({
  id: `scripted_${nextCall++}`,
  name,
  input,
})

/**
 * A refusal a tool gave, said as its layer and code and what would let it pass. The refusal's own
 * sentence is already on the screen, so only its last sentence, which says what would let the same
 * thing pass, is said again.
 */
function refusalLine(content: string): string {
  try {
    const r = JSON.parse(content) as {
      layer?: string
      code?: string
      sentence?: string
      why?: string
    }
    const passes = (r.sentence ?? r.why ?? '').split(/(?<=\.)\s+/).at(-1) ?? ''
    return `It was refused at the ${r.layer} layer with ${r.code}. ${passes}`.trim()
  } catch {
    return 'It was refused.'
  }
}

/** The next step for the run the latest prompt started, given what the tools gave back so far. */
function decide(turns: readonly ChatTurn[]): { text: string; calls: ModelToolCall[] } {
  const { prompt, results } = sinceAsked(turns)
  const last = results.at(-1)
  const done = (tool: string) => results.find((r) => r.call.name === tool)

  if (prompt.startsWith(ORDER_PROMPT) || prompt.includes(SWITCH_OFF_PROMPT)) {
    if (!done('read_order')) return { text: '', calls: [call('read_order')] }
    if (!done('compute_offers')) return { text: '', calls: [call('compute_offers')] }
    const order = latest<OrderSeen>(turns, 'read_order')
    const listing = latest<ListingSeen>(turns, 'compute_offers')
    if (!order || !listing) return { text: "I couldn't read the order or the offers.", calls: [] }
    const quoted = done('submit_quote')
    if (quoted) {
      return quoted.ok
        ? {
            text: `I quoted order ${order.orderId}. The customer checks the quote and the booking it names before it commits.`,
            calls: [],
          }
        : { text: `The quote didn't go out. ${refusalLine(quoted.content)}`, calls: [] }
    }
    if (listing.limits.computeSwitch === 'off') {
      return {
        text: 'The compute switch in service.ts is off, so I book nothing and quote without a booking, as you asked. The customer requires a compute booking, so I expect it to refuse.',
        calls: [call('submit_quote')],
      }
    }
    const booked = done('book_compute')
    if (!booked) {
      const choice = chooseOffer(order, listing)
      if ('none' in choice) return { text: `I booked nothing, since ${choice.none}.`, calls: [] }
      return {
        text: `I'll book ${order.needs.gpus} ${order.needs.gpu} of ${choice.offer.id} at ${choice.offer.pricePerGpuHour} per GPU-hour, the cheapest firm offer that holds the GPUs from the job's start past its deadline.`,
        calls: [call('book_compute', { offer: choice.offer.id, quantity: order.needs.gpus })],
      }
    }
    if (!booked.ok)
      return { text: `I couldn't book the compute. ${refusalLine(booked.content)}`, calls: [] }
    const booking = (JSON.parse(booked.content) as { booking: string }).booking
    return { text: '', calls: [call('submit_quote', { booking })] }
  }

  // The quote went out and the customer answered it, so the agent explains and quotes nothing again.
  if (prompt.startsWith(CUSTOMER_REFUSED_PROMPT)) {
    const refused = /with ([a-z_.]+), at the ([a-z]+) layer/.exec(prompt)
    return {
      text: refused
        ? `The customer refused my quote with ${refused[1]} at the ${refused[2]} layer, so no work started and nothing was charged. The order is closed, and the next one comes with job.`
        : 'The customer refused my quote, so no work started and nothing was charged.',
      calls: [],
    }
  }

  if (/\bwhy\b/i.test(prompt)) {
    const booking = latest<{ booking: string; offer: string; reserve: string }>(
      turns,
      'book_compute',
    )
    const listing = latest<ListingSeen>(turns, 'compute_offers')
    if (!booking || !listing) return { text: "I haven't booked any compute yet.", calls: [] }
    const chosen = listing.offers.find((o) => o.id === booking.offer)
    const others = listing.offers.filter((o) => o.id !== booking.offer)
    const why = others.map((o) =>
      !o.freeCancellation.startsWith('none')
        ? `${o.id} could still be cancelled for free, and the customer won't rely on that`
        : !takes(o, 1)
          ? `${o.id} only takes ${o.gpusPerBooking} GPUs in one booking`
          : `${o.id} doesn't hold the GPUs for the whole job`,
    )
    return {
      text: `I chose ${booking.offer} at ${chosen?.pricePerGpuHour ?? 'its rate'} per GPU-hour, under the ${listing.limits.computeBudgetPerGpuHour} budget in service.ts, with a ${booking.reserve} reserve inside my authority. ${why.join('. ')}.`,
      calls: [],
    }
  }

  const gpus = /(\d+)\s*(?:H100s?|GPUs?)/i.exec(prompt)
  if (gpus) {
    if (last?.call.name === 'book_compute') {
      return last.ok
        ? { text: 'That booking went through.', calls: [] }
        : { text: `I couldn't book ${gpus[1]} GPUs. ${refusalLine(last.content)}`, calls: [] }
    }
    const listing = latest<ListingSeen>(turns, 'compute_offers')
    const offer = listing?.offers.find(
      (o) => takes(o, Number(gpus[1])) && o.freeCancellation.startsWith('none'),
    )
    if (!offer) return { text: `No offer I've seen takes ${gpus[1]} GPUs.`, calls: [] }
    return {
      text: `I'll try to book ${gpus[1]} GPUs of ${offer.id}.`,
      calls: [call('book_compute', { offer: offer.id, quantity: Number(gpus[1]) })],
    }
  }

  if (/\bquote\b/i.test(prompt)) {
    if (last?.call.name === 'submit_quote') {
      return last.ok
        ? { text: 'The quote went out, and the customer checks it now.', calls: [] }
        : { text: `The quote didn't go out. ${refusalLine(last.content)}`, calls: [] }
    }
    const listing = latest<ListingSeen>(turns, 'compute_offers')
    const booking = latest<{ booking: string }>(turns, 'book_compute')
    const off = listing?.limits.computeSwitch === 'off'
    return {
      text: off ? 'I quote without a booking, since compute is switched off.' : '',
      calls: [call('submit_quote', off || !booking ? {} : { booking: booking.booking })],
    }
  }

  return {
    text: "I take orders from Avow's test customer, compare compute offers, book compute and quote. Ask me why I chose an offer, or ask for a booking.",
    calls: [],
  }
}

export function scriptedProvider(): ModelProvider {
  return {
    kind: 'scripted',
    model: SCRIPTED_MODEL,
    line: 'scripted decisions, the same every run, with no model and no charge',
    reaches: 'this machine',
    async reply(request: ReplyRequest): Promise<ModelReply> {
      const started = performance.now()
      const { text, calls } = decide(request.turns)
      if (text) request.onText(text)
      return {
        text,
        calls,
        native: null,
        stop: calls.length > 0 ? 'tools' : 'end',
        timing: {
          firstTokenMs: 0,
          tokens: null,
          generatingMs: null,
          totalMs: performance.now() - started,
        },
      }
    },
  }
}
