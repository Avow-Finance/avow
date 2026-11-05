import {
  type ComputeOffer,
  type ComputeOffers,
  computeOfferCost,
  formatUsd,
  isFirmOffer,
  type JobOffer,
  type JobTool,
  offerTakes,
  type QuoteRequest,
  type ReasonCode,
  type RefusalAmounts,
  type RefusalLayer,
  refusalSentence,
  type SessionEvent,
  type ToolLimits,
} from '@avow-finance/spec'
import { verifyUrl } from '../sandbox/session.js'
import type { ServicePolicy } from './service.js'
import { readToolInput, type ToolInput } from './tools.js'
import type { AuthorityNow, JobWorld, WorldBooking } from './world.js'

/**
 * The tool layer: it reads a model's tool call, applies the developer's policy from `service.ts`,
 * calls the world, and writes every result in code. The model sees only what this returns, which is
 * public data, and every event it emits says what happened, apart from anything the model said.
 */

/** Where a tool call runs: its run, the run's order, and the call's number in the run. */
export interface CallContext {
  run: number
  orderId: string | null
  call: number
}

/** What a tool returned to the model, and whether it succeeded. */
export interface ToolOutcome {
  ok: boolean
  /** What the model reads, as JSON text. */
  content: string
}

/** A result the session recorded, so it can show it again as evidence beside an answer. */
export interface Recorded {
  run: number
  call: number
  tool: JobTool
  event: Extract<SessionEvent, { type: 'tool_result' }>
  /** The offer a booking call named, or null for any other result. */
  offer: string | null
}

/** What the session keeps between tool calls. */
export interface SessionState {
  /** The order the current job is for, or the last one. */
  order: JobOffer | null
  /** The latest listing the model saw, with the call that listed it. */
  listing: { run: number; call: number; listing: ComputeOffers; limits: ToolLimits } | null
  /** Every compute booking the session made, by its id. */
  bookings: Map<string, WorldBooking>
  /** Each order's quote once it went out, with the booking it named. */
  quotes: Map<string, { quote: QuoteRequest; booking: WorldBooking | null; run: number }>
  /** The results of compute_offers and book_compute, for the evidence beside an answer. */
  recorded: Recorded[]
}

export function newSessionState(): SessionState {
  return { order: null, listing: null, bookings: new Map(), quotes: new Map(), recorded: [] }
}

const json = (value: unknown) =>
  JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v))
const iso = (unix: bigint) => new Date(Number(unix) * 1000).toISOString().replace('.000Z', 'Z')

/** A time said against the job's start, so a model never has to subtract timestamps. */
function againstStart(unix: bigint, order: JobOffer | null): string {
  if (!order) return iso(unix)
  const start = order.terms.subject.startsAt
  const minutes = Number((unix - start) / 60n)
  if (minutes === 0) return `${iso(unix)}, when the job starts`
  return `${iso(unix)}, ${Math.abs(minutes)} min ${minutes < 0 ? 'before' : 'after'} the job starts`
}

/** An offer as the model reads it. */
function offerView(o: ComputeOffer, listedAt: bigint, order: JobOffer | null) {
  const windowEnd = o.startsAt + BigInt(Math.round(o.hours * 3600))
  return {
    id: o.id,
    gpu: o.gpu,
    region: o.region,
    gpusPerBooking:
      o.gpus.min === o.gpus.max ? `exactly ${o.gpus.min}` : `${o.gpus.min} to ${o.gpus.max}`,
    windowStarts: againstStart(o.startsAt, order),
    windowEnds: againstStart(windowEnd, order),
    pricePerGpuHour: formatUsd(o.pricePerGpuHour),
    reservePerGpu: formatUsd(o.reservePerGpu),
    freeCancellation: isFirmOffer(o, listedAt)
      ? 'none, firm: it had ended when the offer was listed'
      : `until ${againstStart(o.freeCancelBy, order)}`,
  }
}

export class Toolbox {
  #nextBooking = 1

  constructor(
    private readonly world: JobWorld,
    private readonly policy: () => ServicePolicy,
    private readonly emit: (event: SessionEvent) => void,
    readonly state: SessionState,
  ) {}

  /** Runs one tool call the model made, and gives the model what it returned. */
  async run(tool: JobTool, input: unknown, ctx: CallContext): Promise<ToolOutcome> {
    const read = readToolInput(tool, input)
    const base = {
      run: ctx.run,
      source: 'session' as const,
      orderId: ctx.orderId,
      type: 'tool_call' as const,
      call: ctx.call,
      summary: summarizeCall(read, tool),
    }
    // A booking call names its offer and quantity, both null when its input didn't read.
    this.emit(
      tool !== 'book_compute'
        ? { ...base, tool }
        : read?.tool === 'book_compute'
          ? { ...base, tool, offer: read.offer, quantity: read.quantity }
          : { ...base, tool, offer: null, quantity: null },
    )
    if (!read)
      return this.#refuse(
        ctx,
        tool,
        'message.invalid',
        'service',
        'The input for this tool is not in the form it takes.',
      )
    switch (read.tool) {
      case 'read_order':
        return this.#readOrder(ctx)
      case 'compute_offers':
        return this.#offers(ctx)
      case 'book_compute':
        return this.#book(ctx, read.offer, read.quantity)
      case 'cancel_compute':
        return this.#cancel(ctx, read.booking)
      case 'submit_quote':
        return this.#quote(ctx, read.booking)
      case 'authority':
        return this.#authority(ctx)
      case 'commitments':
        return this.#commitments(ctx)
    }
  }

  async #readOrder(ctx: CallContext): Promise<ToolOutcome> {
    const order = this.state.order
    if (!order) {
      return this.#refuse(
        ctx,
        'read_order',
        'order.unknown',
        'service',
        'No order has come in yet.',
      )
    }
    const t = order.terms
    const charges = t.remedies.charges.map((c) => ({
      kind: c.kind === 'lateCancellation' ? 'late cancellation after work starts' : 'no-show',
      cap: formatUsd(c.amount),
    }))
    const content = {
      orderId: order.orderId,
      customer: order.customer.label,
      work: t.subject.work,
      needs: {
        gpu: t.subject.compute.gpu,
        gpus: t.subject.compute.count,
        region: t.subject.compute.region,
      },
      startsAt: iso(t.subject.startsAt),
      deliverBy: againstStart(t.subject.deliverBy, order),
      price: `${formatUsd(t.consideration.kind === 'fixed' ? t.consideration.amount : 0n)}, paid by a transfer on delivery`,
      customerReserveBacks: charges,
      requirement:
        'The customer accepts a quote only when it names your accepted compute booking that holds the GPUs from the job start to its deadline and is past its free cancellation when the customer checks it.',
      offerExpires: iso(order.expiry),
    }
    this.#result(
      ctx,
      'read_order',
      true,
      `Order ${order.orderId}: ${t.subject.work.kind} on ${t.subject.compute.count} ${t.subject.compute.gpu} for ${content.price.split(',')[0]}`,
    )
    return { ok: true, content: json(content) }
  }

  async #limits(): Promise<{ limits: ToolLimits; authority: AuthorityNow }> {
    const authority = await this.world.authority()
    const policy = this.policy()
    return {
      authority,
      limits: {
        budgetPerGpuHour: policy.budgetPerGpuHour,
        computeSwitch: policy.computeSwitch,
        capPerCommitment: authority.capPerCommitment,
        capOpenReserves: authority.capOpenReserves,
        openReservesLeft: authority.openReservesLeft,
      },
    }
  }

  async #offers(ctx: CallContext): Promise<ToolOutcome> {
    const order = this.state.order
    if (!order) {
      return this.#refuse(
        ctx,
        'compute_offers',
        'order.unknown',
        'service',
        'No order has come in, so there is no window to list offers for.',
      )
    }
    const listing = await this.world.offers(order)
    const { limits } = await this.#limits()
    const event = this.#result(
      ctx,
      'compute_offers',
      true,
      `${listing.offers.length} offers from ${listing.supplier}`,
      { listing, limits },
    )
    this.state.listing = { run: ctx.run, call: ctx.call, listing, limits }
    this.state.recorded.push({
      run: ctx.run,
      call: ctx.call,
      tool: 'compute_offers',
      event,
      offer: null,
    })
    return {
      ok: true,
      content: json({
        supplier: listing.supplier,
        offers: listing.offers.map((o) => offerView(o, listing.listedAt, order)),
        limits: {
          computeBudgetPerGpuHour: formatUsd(limits.budgetPerGpuHour),
          computeSwitch: limits.computeSwitch,
          mostForOneCommitment: formatUsd(limits.capPerCommitment),
          mostHeldAtOnce: formatUsd(limits.capOpenReserves),
          leftToHold: formatUsd(limits.openReservesLeft),
        },
      }),
    }
  }

  async #book(ctx: CallContext, offerId: string, quantity: number): Promise<ToolOutcome> {
    const offer = this.state.listing?.listing.offers.find((o) => o.id === offerId)
    if (!offer) {
      return this.#refuse(
        ctx,
        'book_compute',
        'service.unknown_offer',
        'service',
        `No offer in the latest listing has the id ${offerId}. Call compute_offers for the current ones.`,
      )
    }
    const policy = this.policy()
    const needed = offerTakes(offer, quantity) ? computeOfferCost(offer, quantity).reserve : 0n
    if (policy.computeSwitch === 'off') {
      return this.#policyRefusal(ctx, 'service.compute_off', needed)
    }
    if (offer.pricePerGpuHour > policy.budgetPerGpuHour) {
      return this.#policyRefusal(ctx, 'service.over_budget', needed)
    }
    if (!offerTakes(offer, quantity)) {
      return this.#refuse(
        ctx,
        'book_compute',
        'service.quantity_unavailable',
        'service',
        `Offer ${offer.id} takes ${offer.gpus.min === offer.gpus.max ? `exactly ${offer.gpus.min}` : `${offer.gpus.min} to ${offer.gpus.max}`} GPUs in one booking.`,
      )
    }
    const outcome = await this.world.book(offer, quantity)
    if (!outcome.ok) return this.#bookingRefused(ctx, outcome.code, outcome.layer, outcome.amounts)
    const booking: WorldBooking = { ...outcome.booking, id: `b${this.#nextBooking++}` }
    this.state.bookings.set(booking.id, booking)
    const base = { run: ctx.run, source: 'session' as const, orderId: ctx.orderId }
    if (ctx.orderId) {
      this.emit({
        ...base,
        orderId: ctx.orderId,
        type: 'job_compute_secured',
        reference: booking.reference,
        supplier: offer.supplier,
        amount: booking.reserve,
        freeCancelBy: booking.read.freeCancelBy,
        releaseDate: booking.read.releaseDate,
      } as SessionEvent)
    }
    this.emit({
      ...base,
      type: 'commitment',
      role: 'compute',
      reference: booking.reference,
      amount: booking.reserve,
      state: booking.read.state,
      verifiedBy: 'service',
      block: booking.read.block,
      transactionHash: booking.reservedIn,
      verification: null,
    })
    const event = this.#result(
      ctx,
      'book_compute',
      true,
      `Booked ${quantity} ${offer.gpu} of ${offer.id} as ${booking.id}, reserving ${formatUsd(booking.reserve)}, and ${offer.supplier} accepted`,
    )
    this.state.recorded.push({
      run: ctx.run,
      call: ctx.call,
      tool: 'book_compute',
      event,
      offer: offer.id,
    })
    return {
      ok: true,
      content: json({
        booking: booking.id,
        offer: offer.id,
        gpus: quantity,
        reserve: formatUsd(booking.reserve),
        usagePrice: `${formatUsd(booking.price)} for the window, paid separately`,
        state: `${booking.read.state} by ${offer.supplier}, read at block ${booking.read.block.number}`,
        freeCancellation:
          booking.read.freeCancelBy <= booking.read.block.timestamp
            ? 'ended, so cancelling now costs what its terms charge'
            : `until ${iso(booking.read.freeCancelBy)}`,
        verify: verifyUrl(booking.reference),
      }),
    }
  }

  /** A booking the developer's policy refused, which posts a refusal with its amounts. */
  async #policyRefusal(ctx: CallContext, code: ReasonCode, needed: bigint): Promise<ToolOutcome> {
    const { authority } = await this.#limits()
    return this.#bookingRefused(ctx, code, 'service', {
      needed,
      left: authority.openReservesLeft,
      authority: authority.capOpenReserves,
      capPerCommitment: authority.capPerCommitment,
      dailyLimit: authority.dailyLimit,
      dailyLeft: authority.dailyLeft,
    })
  }

  #bookingRefused(
    ctx: CallContext,
    code: ReasonCode,
    layer: RefusalLayer,
    amounts: RefusalAmounts,
  ): ToolOutcome {
    this.emit({ run: ctx.run, source: 'session', type: 'refused', code, layer, amounts })
    const sentence = refusalSentence({ code, layer, amounts })
    const event = this.#result(
      ctx,
      'book_compute',
      false,
      sentence.split('. ')[0] ?? sentence,
      null,
      { code, layer },
    )
    this.state.recorded.push({
      run: ctx.run,
      call: ctx.call,
      tool: 'book_compute',
      event,
      offer: null,
    })
    return { ok: false, content: json({ refused: true, layer, code, sentence, moneyMoved: false }) }
  }

  async #cancel(ctx: CallContext, bookingId: string): Promise<ToolOutcome> {
    const booking = this.state.bookings.get(bookingId)
    if (!booking) {
      return this.#refuse(
        ctx,
        'cancel_compute',
        'service.unknown_booking',
        'service',
        `No booking this session made has the id ${bookingId}.`,
      )
    }
    const outcome = await this.world.cancel(booking)
    if (!outcome.ok)
      return this.#refuse(ctx, 'cancel_compute', outcome.code, outcome.layer, outcome.why)
    this.#result(ctx, 'cancel_compute', true, `Your business cancelled ${booking.id}`)
    return {
      ok: true,
      content: json({ cancelled: booking.id, transaction: outcome.transactionHash }),
    }
  }

  async #quote(ctx: CallContext, bookingId: string | null): Promise<ToolOutcome> {
    const order = this.state.order
    if (!order) {
      return this.#refuse(
        ctx,
        'submit_quote',
        'order.unknown',
        'service',
        'No order is open to quote.',
      )
    }
    if (this.state.quotes.has(order.orderId)) {
      return this.#refuse(
        ctx,
        'submit_quote',
        'order.out_of_step',
        'service',
        `Order ${order.orderId} has been quoted already, and the customer answers after your turn.`,
      )
    }
    const policy = this.policy()
    if (policy.computeSwitch === 'off' && bookingId !== null) {
      return this.#refuse(
        ctx,
        'submit_quote',
        'service.compute_off',
        'service',
        'The compute switch in service.ts is off, so a quote names no booking. Call submit_quote with no booking.',
      )
    }
    if (policy.computeSwitch === 'on' && bookingId === null) {
      return this.#refuse(
        ctx,
        'submit_quote',
        'service.booking_required',
        'service',
        'service.ts books compute for every quote while its compute switch is on, so name the booking.',
      )
    }
    const booking = bookingId === null ? null : (this.state.bookings.get(bookingId) ?? null)
    if (bookingId !== null && !booking) {
      return this.#refuse(
        ctx,
        'submit_quote',
        'service.unknown_booking',
        'service',
        `No booking this session made has the id ${bookingId}.`,
      )
    }
    const outcome = await this.world.quote(order, booking)
    if (!outcome.ok) {
      return this.#refuse(
        ctx,
        'submit_quote',
        outcome.code,
        outcome.layer,
        `The customer refused the quote before checking it.`,
      )
    }
    this.state.quotes.set(order.orderId, { quote: outcome.quote, booking, run: ctx.run })
    const base = { run: ctx.run, source: 'session' as const, orderId: order.orderId }
    this.emit({
      ...base,
      type: 'job_quote_sent',
      termsHash: outcome.quote.agreement.termsHash,
      compute: booking?.reference ?? null,
      price: order.terms.consideration.kind === 'fixed' ? order.terms.consideration.amount : 0n,
    } as SessionEvent)
    this.emit({ ...base, type: 'job_customer_verifying' } as SessionEvent)
    this.#result(
      ctx,
      'submit_quote',
      true,
      booking
        ? `Quoted ${order.orderId}, naming ${booking.id}`
        : `Quoted ${order.orderId}, naming no compute booking`,
    )
    return {
      ok: true,
      content: json({
        quoted: order.orderId,
        names: booking ? booking.id : 'no compute booking',
        next: "The customer is checking the quote now. Its answer comes after your turn, and the developer's code checks the customer's commitment before any work starts.",
      }),
    }
  }

  async #authority(ctx: CallContext): Promise<ToolOutcome> {
    const { authority } = await this.#limits()
    this.#result(
      ctx,
      'authority',
      true,
      `${formatUsd(authority.openReservesLeft)} left of ${formatUsd(authority.capOpenReserves)} held at once`,
    )
    return {
      ok: true,
      content: json({
        mostForOneCommitment: formatUsd(authority.capPerCommitment),
        mostHeldAtOnce: formatUsd(authority.capOpenReserves),
        leftToHold: formatUsd(authority.openReservesLeft),
        keyMovesPerDay:
          authority.dailyLimit === null ? 'no daily limit' : formatUsd(authority.dailyLimit),
        keyCanStillMoveToday:
          authority.dailyLeft === null ? 'unread' : formatUsd(authority.dailyLeft),
        suppliers: authority.suppliers,
      }),
    }
  }

  async #commitments(ctx: CallContext): Promise<ToolOutcome> {
    const list = await Promise.all(
      [...this.state.bookings.values()].map(async (b) => {
        const now = await this.world.read(b.reference).catch(() => null)
        return {
          booking: b.id,
          role: 'compute',
          reserve: formatUsd(b.reserve),
          state: now ? `${now.state} at block ${now.block.number}` : 'unread',
          verify: verifyUrl(b.reference),
        }
      }),
    )
    this.#result(
      ctx,
      'commitments',
      true,
      `${list.length} compute booking${list.length === 1 ? '' : 's'} in this session`,
    )
    return { ok: true, content: json({ commitments: list }) }
  }

  /** A refusal of the tool call itself, with its code, layer and a code-written sentence. */
  #refuse(
    ctx: CallContext,
    tool: JobTool,
    code: ReasonCode,
    layer: RefusalLayer,
    why: string,
  ): ToolOutcome {
    this.#result(ctx, tool, false, why, null, { code, layer })
    return { ok: false, content: json({ refused: true, layer, code, why }) }
  }

  /** Posts a tool's result, written by code, and gives the event. */
  #result(
    ctx: CallContext,
    tool: JobTool,
    ok: boolean,
    summary: string,
    listing: { listing: ComputeOffers; limits: ToolLimits } | null = null,
    refusal: { code: ReasonCode; layer: RefusalLayer } | null = null,
  ): Extract<SessionEvent, { type: 'tool_result' }> {
    const event = {
      run: ctx.run,
      source: 'session',
      orderId: ctx.orderId,
      type: 'tool_result',
      call: ctx.call,
      tool,
      summary: summary.slice(0, 500),
      recalled: null,
      listing: listing?.listing ?? null,
      limits: listing?.limits ?? null,
      ...(ok || !refusal ? { ok: true as const } : { ok: false as const, ...refusal }),
    } as Extract<SessionEvent, { type: 'tool_result' }>
    this.emit(event)
    return event
  }
}

/** A tool call's summary, written by code from what the model passed. */
function summarizeCall(read: ToolInput | null, tool: JobTool): string {
  if (!read) return `${tool} with input not in the form it takes`
  switch (read.tool) {
    case 'book_compute':
      return `${read.quantity} GPU${read.quantity === 1 ? '' : 's'} of ${read.offer}`
    case 'cancel_compute':
      return `cancel ${read.booking}`
    case 'submit_quote':
      return read.booking ? `quote naming ${read.booking}` : 'quote naming no booking'
    case 'read_order':
      return 'the order'
    case 'compute_offers':
      return "the supplier's offers for the order"
    case 'authority':
      return 'what the agent can commit now'
    case 'commitments':
      return "the business's commitments"
  }
}
