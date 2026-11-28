import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  formatUsd,
  offerVersionId,
  PAYMENT_ROUTES,
  type PaymentRoute,
  parseServiceOfferVersion,
  SERVICE_QUANTITY_MAX,
  type SellerMandateTerms,
  type ServiceOfferVersion,
  type ServiceOrder,
  sellerMandateTermsJson,
  serviceOfferQuote,
  toWire,
} from '@avow-finance/spec'
import type { Hex } from 'viem'
import { SELLER_LIMITS_UNENFORCED } from '../sandbox/seller-mandate.js'
import {
  type SandboxServices,
  type ServiceBuyOutcome,
  type ServiceOfferDraft,
  sandboxServices,
} from '../sandbox/services.js'
import { fileStore } from './platform.js'

/**
 * Services from a terminal, and the words the command line and the MCP server both say about an
 * offer and an order. A supplier's agent publishes an offer and hands the buyer's agent the file,
 * and the buyer's agent orders from that file.
 */

const HOUR = 3600
const DAY = 24 * HOUR

/** What an offer's inputs are called, in the units a person sets them in. */
export interface OfferInput {
  name?: unknown
  summary?: unknown
  /** Dollars for one unit. */
  price?: unknown
  evidence?: unknown
  /** What cancelling late can cost, as a percentage of the price. */
  late_cancellation_percent?: unknown
  /** What not being there to take delivery can cost, as a percentage of the price. */
  no_show_percent?: unknown
  lead_hours?: unknown
  max_per_booking?: unknown
  per_day?: unknown
  free_cancel_hours?: unknown
  payment?: unknown
  payment_due_days?: unknown
}

/** The most each input takes, so an offer always reads back from the folder it's kept in. */
const MOST = { dollars: 1_000_000_000, hours: 24 * 365, days: 365 }

/** A number from zero to `most`, exact to `step`, or null. Left out, it's `otherwise`. */
function amount(v: unknown, most: number, step: number, otherwise: number | null): number | null {
  if (v === undefined) return otherwise
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > most) return null
  // 12.345% or a price past six decimals would be rounded without saying so, so it's refused.
  const steps = v / step
  return Math.abs(steps - Math.round(steps)) < 1e-6 ? v : null
}

/**
 * An offer as its supplier sets it, in dollars, percentages, hours and days, turned into the draft
 * the template takes. Both charges are asked for, since they set the reserve a booking takes, and
 * nothing else has to be given. The template's own rules are checked when it's published.
 */
export function readOfferInput(input: OfferInput): ServiceOfferDraft | { error: string } {
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  const name = text(input.name)
  const summary = text(input.summary)
  const evidence = text(input.evidence)
  if (!name) return { error: 'Name what the offer sells.' }
  if (!summary) return { error: 'Say in a sentence what the buyer gets.' }
  if (!evidence) return { error: 'Say what counts as delivery.' }
  const price = amount(input.price, MOST.dollars, 0.000001, null)
  if (price === null || price === 0) {
    return {
      error: 'Give the price of one unit in dollars, above zero and to six decimals at most.',
    }
  }
  const late = amount(input.late_cancellation_percent, 100, 0.01, null)
  const noShow = amount(input.no_show_percent, 100, 0.01, null)
  if (late === null || noShow === null) {
    return {
      error:
        'Give both charges as percentages of the price from 0 to 100, to two decimals at most, what cancelling late can cost and what not being there to take delivery can cost.',
    }
  }
  const lead = amount(input.lead_hours, MOST.hours, 1 / 3600, 24)
  const free = amount(input.free_cancel_hours, MOST.hours, 1 / 3600, 0)
  const due = amount(input.payment_due_days, MOST.days, 1 / 86_400, 7)
  if (lead === null || free === null || due === null) {
    return { error: 'Hours run from zero to a year, and days to pay from zero to 365.' }
  }
  const most = amount(input.max_per_booking, SERVICE_QUANTITY_MAX, 1, 1)
  const perDay = amount(input.per_day, SERVICE_QUANTITY_MAX, 1, 10)
  if (!most || !perDay) {
    return { error: 'Units a booking and bookings a day are whole numbers from 1 up.' }
  }
  const route = input.payment === undefined ? 'transfer' : input.payment
  if (!(PAYMENT_ROUTES as readonly unknown[]).includes(route)) {
    return { error: `Payment is ${PAYMENT_ROUTES.join(' or ')}.` }
  }
  return {
    item: { name, summary },
    currency: 'USD',
    unitPrice: BigInt(Math.round(price * 1_000_000)),
    rules: {
      evidence,
      leadTime: BigInt(Math.round(lead * HOUR)),
      maxPerBooking: most,
      dailyCapacity: perDay,
      freeCancelWindow: BigInt(Math.round(free * HOUR)),
      lateCancellationBps: Math.round(late * 100),
      noShowBps: Math.round(noShow * 100),
      payment: { route: route as PaymentRoute, dueAfterDelivery: BigInt(Math.round(due * DAY)) },
    },
  }
}

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

/** A length of time in the largest unit that reads whole, such as `2 hours` or `90 minutes`. */
function span(seconds: bigint): string {
  const s = Number(seconds)
  if (s % DAY === 0) return count(s / DAY, 'day')
  if (s % HOUR === 0) return count(s / HOUR, 'hour')
  return count(Math.round(s / 60), 'minute')
}

const percent = (bps: number) => `${bps / 100}%`

/** An offer in sentences, with every rule that sets what a booking costs and reserves. */
export function offerSentences(v: ServiceOfferVersion): string[] {
  const r = v.rules
  const charges = [
    r.lateCancellationBps > 0 ? `${percent(r.lateCancellationBps)} for cancelling late` : null,
    r.noShowBps > 0 ? `${percent(r.noShowBps)} for not being there to take delivery` : null,
  ].filter((c) => c !== null)
  return [
    `${v.item.name} from ${v.supplier}. ${v.item.summary}.`.replace(/\.\.$/, '.'),
    `${formatUsd(v.unitPrice)} a unit, up to ${count(r.maxPerBooking, 'unit')} a booking, delivered within ${span(r.leadTime)} of booking.`,
    `Delivery is shown by this evidence. ${r.evidence}.`.replace(/\.\.$/, '.'),
    r.payment.route === 'transfer'
      ? `The price is paid by transfer within ${span(r.payment.dueAfterDelivery)} of the delivery deadline, and the reserve doesn't secure it.`
      : `The supplier invoices the price, due within ${span(r.payment.dueAfterDelivery)} of the delivery deadline, and the reserve doesn't secure it.`,
    `The supplier can charge ${charges.join(' and ')}, as a share of the whole price, and a booking reserves the larger.`,
    r.freeCancelWindow === 0n
      ? 'No booking is free to cancel.'
      : `Cancelling is free for ${span(r.freeCancelWindow)} after booking.`,
  ]
}

/** What booking a quantity of an offer comes to, in a sentence. */
export function bookingSentence(v: ServiceOfferVersion, quantity: number): string {
  const quote = serviceOfferQuote(v, quantity)
  return `${count(quantity, 'unit')} of ${v.item.name} from ${v.supplier} costs ${formatUsd(quote.total)} and reserves ${formatUsd(quote.reserve)}.`
}

/** Where an order stands, in a sentence a person or a model can act on. */
export function orderSentence(order: ServiceOrder): string {
  const what = `Order ${order.orderId}, ${count(order.quantity, 'unit')} of ${order.offer.item.name} from ${order.offer.supplier} for ${order.buyer.businessId}`
  if (order.status === 'requested') {
    return `${what}, waits for the supplier's quote until ${new Date(Number(order.expiry) * 1000).toISOString()}. Nothing is reserved.`
  }
  if (order.status === 'expired') return `${what}, lapsed with nothing reserved.`
  if (order.status === 'quoted') return `${what}, is quoted and waits for the buyer to fund it.`
  if (order.status === 'reserved') {
    return `${what}, is funded and waits for the supplier to accept by ${new Date(Number(order.reserve.acceptBy) * 1000).toISOString()}.`
  }
  return `${what}, is accepted.`
}

/** How buying ended, in a sentence. */
export function outcomeSentence(outcome: ServiceBuyOutcome): string {
  if (outcome.ok) return 'The supplier accepted, so the commitment stands.'
  if (outcome.reason === 'order.expired') return 'The order lapsed, and nothing was reserved.'
  if (outcome.reason === 'acceptance.missed') {
    return "The supplier didn't accept in time, so the reserve goes back to the business."
  }
  return outcome.order.status === 'reserved'
    ? `The order stopped after it was funded, with reason code ${outcome.reason}.`
    : `The order was refused with reason code ${outcome.reason}, and nothing was reserved.`
}

/** An offer read from what a supplier shared, as an object or as its JSON text. */
export function readSharedOffer(shared: unknown): ServiceOfferVersion | null {
  let json = shared
  if (typeof shared === 'string') {
    try {
      json = JSON.parse(shared)
    } catch {
      return null
    }
  }
  const offer = parseServiceOfferVersion(json)
  return offer.ok ? offer.value : null
}

/**
 * The unfinished order this agent already sent for an offer and quantity, to pick up. One past its
 * expiry is left alone, since a new order is what's wanted then.
 */
export async function unfinishedFor(
  services: SandboxServices,
  offer: ServiceOfferVersion,
  quantity: number,
): Promise<string | null> {
  const id = offerVersionId(offer)
  const now = BigInt(Math.floor(Date.now() / 1000))
  const left = (await services.unfinished()).find(
    (r) => r.quantity === quantity && r.expiry > now && offerVersionId(r.offer) === id,
  )
  return left?.orderId ?? null
}

const fail = (message: string): never => {
  console.error(message)
  process.exit(1)
}

/** The flags `offer publish` takes, each with the input it sets and whether it's a number. */
const PUBLISH_FLAGS: Record<string, [keyof OfferInput, 'text' | 'number']> = {
  '--name': ['name', 'text'],
  '--summary': ['summary', 'text'],
  '--price': ['price', 'number'],
  '--evidence': ['evidence', 'text'],
  '--late-cancellation': ['late_cancellation_percent', 'number'],
  '--no-show': ['no_show_percent', 'number'],
  '--lead-hours': ['lead_hours', 'number'],
  '--max': ['max_per_booking', 'number'],
  '--per-day': ['per_day', 'number'],
  '--free-cancel-hours': ['free_cancel_hours', 'number'],
  '--payment': ['payment', 'text'],
  '--due-days': ['payment_due_days', 'number'],
}

/** What `offer publish` was given, read from its flags, or why it can't run. */
export function readPublishArgs(args: readonly string[]): OfferInput | { error: string } {
  const input: OfferInput = {}
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i] as string
    const value = args[i + 1]
    const known = Object.hasOwn(PUBLISH_FLAGS, flag) ? PUBLISH_FLAGS[flag] : undefined
    if (!known) return { error: `offer publish doesn't take ${flag}` }
    if (value === undefined || value.startsWith('--')) return { error: `${flag} needs a value` }
    if (known[1] === 'number' && !/^[0-9]+(\.[0-9]+)?$/.test(value)) {
      return { error: `${flag} takes a number` }
    }
    input[known[0]] = known[1] === 'number' ? Number(value) : value
  }
  return input
}

const fileName = (name: string) =>
  `${
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'offer'
  }.offer.json`

/** The `offer` verbs that act on Avow's listing of one version, named by its id. */
const AVOW_VERBS = ['list-with-avow', 'withdraw-from-avow'] as const
const OFFER_VERBS = ['publish', 'list', 'withdraw', ...AVOW_VERBS, 'listed-with-avow'] as const
type OfferVerb = (typeof OFFER_VERBS)[number]
const isOfferVerb = (v: string | undefined): v is OfferVerb =>
  (OFFER_VERBS as readonly (string | undefined)[]).includes(v)

/** What `offer` was asked to do, read from its arguments before the folder is read. */
export type OfferAsk =
  | { verb: 'publish'; draft: ServiceOfferDraft }
  | { verb: 'list' | 'listed-with-avow' }
  | { verb: 'withdraw' | (typeof AVOW_VERBS)[number]; id: Hex }

/** What `offer` was asked to do, or why it can't run, so a mistyped flag is the first thing said. */
export function readOfferArgs(args: readonly string[]): OfferAsk | { error: string } {
  const [verb, ...rest] = args
  if (!isOfferVerb(verb)) {
    return { error: `offer takes ${OFFER_VERBS.slice(0, -1).join(', ')} or ${OFFER_VERBS.at(-1)}` }
  }
  if (verb === 'publish') {
    const input = readPublishArgs(rest)
    if ('error' in input) return input
    const draft = readOfferInput(input)
    return 'error' in draft ? draft : { verb, draft }
  }
  if (verb === 'list' || verb === 'listed-with-avow') {
    return rest.length === 0 ? { verb } : { error: `offer ${verb} takes nothing more` }
  }
  const [id, ...more] = rest
  if (!id || more.length > 0 || !/^0x[0-9a-fA-F]{64}$/.test(id)) {
    return { error: `offer ${verb} takes the id of an offer` }
  }
  return { verb, id: id as Hex }
}

/**
 * `avow-sandbox offer publish | list | withdraw <id>`, which keep offers in `.avow`, and
 * `list-with-avow <id> | withdraw-from-avow <id> | listed-with-avow`, which list a published
 * version in Avow's directory, take it away and show what Avow lists. Publishing writes the offer
 * to a file beside `.avow`, which is what a buyer's agent orders from, and sends nothing to Avow.
 */
export async function offerCommand(args: readonly string[]): Promise<void> {
  const ask = readOfferArgs(args)
  if ('error' in ask) return fail(ask.error)
  const services = await sandboxServices({ store: fileStore() })
  if (ask.verb === 'list') {
    const published = await services.published()
    if (published.length === 0) console.log('This business has published no offers.')
    for (const version of published) {
      console.log(`${offerVersionId(version)}\n  ${offerSentences(version).join('\n  ')}`)
    }
    return
  }
  if (ask.verb === 'list-with-avow') {
    const listed = await services.listWithAvow(ask.id)
    if (!listed.ok) return fail(listed.notice)
    console.log(
      [
        `Listed offer ${listed.listing.id} with Avow, checked against seller's mandate ${listed.listing.sellerMandate}.`,
        ...(listed.listing.replaced
          ? [`It replaces ${listed.listing.replaced}, which Avow no longer lists.`]
          : []),
        "Avow holds it as the item's current listing. A listing grants nothing, and every order is checked again.",
      ].join('\n'),
    )
    return
  }
  if (ask.verb === 'withdraw-from-avow') {
    const { id } = await services.withdrawFromAvow(ask.id)
    console.log(
      `Avow no longer lists ${id}. It stays published here, and a booking already accepted stands.`,
    )
    return
  }
  if (ask.verb === 'listed-with-avow') {
    const listed = await services.listedWithAvow()
    if (listed.length === 0) console.log('Avow lists no offers for this business.')
    for (const { id, version } of listed) {
      console.log(`${id}\n  ${offerSentences(version).join('\n  ')}`)
    }
    return
  }
  if (ask.verb === 'withdraw') {
    const gone = await services.withdraw(ask.id)
    console.log(
      gone
        ? 'Withdrawn. An order for it is no longer quoted, and a booking already accepted stands.'
        : 'This business has no published offer with that id.',
    )
    return
  }
  if (ask.verb !== 'publish') return
  const { version, id, standing } = await services.publish(ask.draft)
  const file = resolve(fileName(version.item.name))
  writeFileSync(file, `${JSON.stringify(toWire(version), null, 2)}\n`)
  console.log(
    [
      `Published offer ${id}.`,
      ...(standing ? [standing.notice] : []),
      ...offerSentences(version),
      `The offer is in ${file}. Give that file to a buyer's agent, which orders with`,
      `  npx avow-sandbox order --offer ${fileName(version.item.name)} --quantity 1`,
      'Run npx avow-sandbox listen here to quote and accept the orders that come.',
    ].join('\n'),
  )
}

/** What `order --offer` takes, read from its arguments, or why it can't run. */
export function readServiceOrderArgs(
  args: readonly string[],
): { offer: string; quantity: number; expiresIn: bigint | null } | { error: string } {
  let offer: string | null = null
  let quantity = 1
  let expiresIn: bigint | null = null
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]
    const value = args[i + 1]
    if (value === undefined || value.startsWith('--')) return { error: `${flag} needs a value` }
    if (flag === '--offer') offer = value
    else if (flag === '--quantity' && /^[1-9][0-9]{0,6}$/.test(value)) quantity = Number(value)
    else if (flag === '--quantity') return { error: '--quantity takes a whole number of units' }
    else if (flag === '--expires-in' && /^[1-9][0-9]{0,4}$/.test(value)) expiresIn = BigInt(value)
    else if (flag === '--expires-in') return { error: '--expires-in takes whole seconds' }
    else return { error: `order doesn't take ${flag} with --offer` }
  }
  if (!offer) return { error: 'order needs --offer, the file the supplier gave you' }
  return { offer, quantity, expiresIn }
}

/**
 * `avow-sandbox order --offer <file> [--quantity n]`. Orders units of a supplier's offer and sees
 * the order through: waits for the quote, checks it against the order, funds the commitment under
 * the agent's mandate and waits for the acceptance. An order for the same offer and quantity this
 * agent sent and didn't see through is picked up instead.
 */
export async function orderServiceCommand(args: readonly string[]): Promise<void> {
  const read = readServiceOrderArgs(args)
  if ('error' in read) return fail(read.error)
  let text: string
  try {
    text = readFileSync(resolve(read.offer), 'utf8')
  } catch {
    return fail(`There's no file ${read.offer} to read the offer from.`)
  }
  const offer = readSharedOffer(text)
  if (!offer) return fail(`${read.offer} doesn't hold an offer the service template takes.`)
  const stop = new AbortController()
  process.once('SIGINT', () => stop.abort(new Error('Stopped waiting')))
  const services = await sandboxServices({ store: fileStore() })
  console.log(bookingSentence(offer, read.quantity))
  const left = await unfinishedFor(services, offer, read.quantity)
  if (left) console.log(`Picking up order ${left}, sent before this agent stopped.`)
  const outcome = await services.buy({
    ...(left ? { resume: left } : { offer, quantity: read.quantity }),
    ...(read.expiresIn === null ? {} : { expiresIn: read.expiresIn }),
    signal: stop.signal,
    onStep: (step) => {
      if (step.step === 'ordered') console.log(orderSentence(step.order))
      else if (step.step === 'quoted') console.log('Quoted. Checking the terms against the order.')
      else if (step.step === 'reserved') console.log('Funded. Waiting for the supplier to accept.')
      else console.log('Accepted.')
    },
  })
  if (!outcome.ok) fail(outcomeSentence(outcome))
}

/** The terms file `ask-to-sell` names, or what's wrong with its arguments. */
export function readAskToSellArgs(args: readonly string[]): { file: string } | { error: string } {
  const at = args.indexOf('--terms')
  const file = at >= 0 ? args[at + 1] : undefined
  const unknown = args.filter((_, i) => i !== at && i !== at + 1)
  if (!file || file.startsWith('--') || unknown.length > 0) {
    return { error: 'ask-to-sell takes --terms <file>' }
  }
  return { file }
}

/** A seller's mandate's terms from the text of a file, or what's wrong with it. */
export function readTermsText(
  file: string,
  text: string,
): { terms: SellerMandateTerms } | { error: string } {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { error: `${file} doesn't hold JSON` }
  }
  const terms = sellerMandateTermsJson.safeParse(json)
  return terms.success
    ? { terms: terms.data }
    : {
        error: `${file} doesn't hold a seller's mandate's terms as the spec writes them, with amounts and times as decimal strings`,
      }
}

/** What `ask-to-sell` uses beyond its arguments, which a test replaces. */
export interface AskToSellDeps {
  services: () => Promise<Pick<SandboxServices, 'askToSell' | 'awaitSellRequest'>>
  readFile: (file: string) => string
  log: (line: string) => void
  fail: (message: string) => void
  signal: AbortSignal
}

/**
 * `avow-sandbox ask-to-sell --terms <file>`. Asks the business's administrator for a seller's
 * mandate with the terms in the file, as the spec writes them, signed with the agent's own key.
 * It prints the link for the person who decides, then reads where the request stands every few
 * seconds and says when it moves, until it settles or is active, or until Ctrl+C stops it. It
 * only asks: nothing here approves it. Avow doesn't take these requests yet, and then it says so.
 */
export async function askToSellCommand(
  args: readonly string[],
  deps: AskToSellDeps = defaultAskDeps(),
): Promise<void> {
  const read = readAskToSellArgs(args)
  if ('error' in read) return deps.fail(read.error)
  let text: string
  try {
    text = deps.readFile(read.file)
  } catch {
    return deps.fail(`${read.file} can't be read`)
  }
  const terms = readTermsText(read.file, text)
  if ('error' in terms) return deps.fail(terms.error)
  const services = await deps.services()
  const outcome = await services.askToSell(terms.terms)
  if (!outcome.ok) {
    deps.log(outcome.notice)
    return
  }
  const { request, link } = outcome.asked
  deps.log(`Asked for a seller's mandate, request ${request.id}.`)
  deps.log(`Send your person this link to decide it with their passkey: ${link}`)
  deps.log('Waiting for the decision. Stop with Ctrl+C, and the request keeps waiting.')
  let last = ''
  const settled = await services.awaitSellRequest(request.id, {
    signal: deps.signal,
    onRead: ({ request: r }) => {
      if (r.status.state !== last) deps.log(`The request is ${r.status.state}.`)
      last = r.status.state
    },
  })
  if (settled.request.status.state === 'active') {
    deps.log(
      `The seller's mandate is in force. This agent holds itself to it before it publishes, quotes or accepts. ${SELLER_LIMITS_UNENFORCED}`,
    )
  }
}

function defaultAskDeps(): AskToSellDeps {
  const stop = new AbortController()
  process.once('SIGINT', () => stop.abort())
  return {
    services: () => sandboxServices({ store: fileStore() }),
    readFile: (file) => readFileSync(file, 'utf8'),
    log: (line) => console.log(line),
    fail,
    signal: stop.signal,
  }
}
