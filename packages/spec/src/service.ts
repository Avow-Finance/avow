import { type Address, encodeAbiParameters, type Hex, keccak256 } from 'viem'
import { z } from 'zod'
import { canonicalJson } from './canonical.js'
import { u64, u256 } from './json-fields.js'
import type { ReasonCode } from './reasons.js'
import { isFilled } from './text.js'
import {
  AMOUNT_DECIMALS,
  CURRENCIES,
  type Currency,
  type RemedyCharge,
  TERMS_VERSION,
  type TermsOf,
} from './types.js'
import type { Parsed } from './wire.js'

/**
 * A service sold by quantity at a fixed price per unit, delivered by a deadline. Version 1 takes
 * one-off services only. Subscriptions, usage billing and physical shipping aren't services under
 * it, and a supplier that sells them doesn't list them. Its meaning is fixed, and a change of
 * meaning would be `service/2`.
 *
 * The terms book one version of a supplier's offer, which `serviceOfferTerms` turns into terms,
 * and `serviceTermsMatchOffer` says whether terms are exactly the ones that version gives. The
 * buyer's reserve backs only what the buyer owes if it cancels late or isn't there to take
 * delivery. The price is the consideration, which the lock never reads. It's paid by the route and
 * deadline the terms name, and the reserve doesn't secure it.
 */
export const SERVICE = 'service/1' as const

/**
 * The mandate category every service booking falls under. A mandate allows services by naming
 * it, and service terms under any other category are refused as `terms.category_mismatch`.
 */
export const SERVICE_CATEGORY = 'service' as const

/** The unit a service's price is charged per, one of the quantity the terms name. */
export const SERVICE_UNIT = 'unit' as const

/** The longest item name a service names. */
export const SERVICE_NAME_MAX = 120

/** The longest summary, or description of delivery evidence, a service names. */
export const SERVICE_TEXT_MAX = 280

/** The most units one booking of a service can take. */
export const SERVICE_QUANTITY_MAX = 1_000_000

/** The longest a supplier's business id is in an offer. */
const SUPPLIER_ID_MAX = 100

/**
 * How the buyer pays the price, which the lock never reads. `transfer` is a transfer of the
 * terms' currency to the supplier's payee on the commitment's chain. `invoice` is the supplier
 * billing by its own means, which nothing on chain shows.
 */
export const PAYMENT_ROUTES = ['transfer', 'invoice'] as const
export type PaymentRoute = (typeof PAYMENT_ROUTES)[number]

const isPaymentRoute = (v: unknown): v is PaymentRoute =>
  (PAYMENT_ROUTES as readonly unknown[]).includes(v)

/** The whole price of a number of units at a unit price, the one rule terms and quotes share. */
const totalOf = (unitPrice: bigint, quantity: number): bigint => unitPrice * BigInt(quantity)

/** The reserve a service booking takes, its larger charge, the one rule terms and quotes share. */
const reserveOf = (lateCancellation: bigint, noShow: bigint): bigint =>
  lateCancellation > noShow ? lateCancellation : noShow

/** What a service booking promises: which offer, what and how many, and how it's delivered and paid. */
export interface ServiceSubject {
  /** The id of the offer version booked, which `offerVersionId` gives. */
  offer: Hex
  /** What the supplier delivers, with a short name and one sentence on what it is. */
  item: { name: string; summary: string }
  /** How many units are booked. */
  quantity: number
  /** When the supplier delivers by, and what counts as evidence that it did. */
  delivery: { by: bigint; evidence: string }
  /** How the buyer pays the price, and by when. */
  payment: { route: PaymentRoute; dueBy: bigint }
}

/** Service terms, version 2. */
export type ServiceTerms = TermsOf<ServiceSubject, typeof SERVICE>

/** What a service booking states, in micros and unix seconds, before the template builds its terms. */
export interface ServiceInput {
  offer: Hex
  item: ServiceSubject['item']
  quantity: number
  currency: Currency
  /** The price of one unit, paid by the payment route. The reserve doesn't secure it. */
  unitPrice: bigint
  deliverBy: bigint
  evidence: string
  payment: ServiceSubject['payment']
  acceptBy: bigint
  freeCancelBy: bigint
  /** The most the supplier can charge when the buyer cancels after free cancellation ends. */
  lateCancellation: bigint
  /** The most the supplier can charge when the buyer isn't there to take delivery. */
  noShow: bigint
  chargeDeadline: bigint
  contestWindow: bigint
  releaseDate: bigint
  arbiter: Address
  day90SupplierShareBps: number
}

/**
 * Builds service terms. A late cancellation can be charged from the free-cancellation deadline and
 * a no-show from the delivery deadline. A charge set to zero is left out, and the reserve is the
 * largest charge.
 */
export function serviceTerms(input: ServiceInput): ServiceTerms {
  const charges: RemedyCharge[] = []
  if (input.lateCancellation > 0n) {
    charges.push({
      kind: 'lateCancellation',
      amount: input.lateCancellation,
      earliest: input.freeCancelBy,
    })
  }
  if (input.noShow > 0n) {
    charges.push({ kind: 'noShow', amount: input.noShow, earliest: input.deliverBy })
  }
  const reserve = reserveOf(input.lateCancellation, input.noShow)
  return {
    version: TERMS_VERSION,
    template: SERVICE,
    currency: input.currency,
    amountDecimals: AMOUNT_DECIMALS,
    subject: {
      offer: input.offer,
      item: { ...input.item },
      quantity: input.quantity,
      delivery: { by: input.deliverBy, evidence: input.evidence },
      payment: { ...input.payment },
    },
    consideration: { kind: 'rate', amount: input.unitPrice, unit: SERVICE_UNIT },
    remedies: {
      acceptBy: input.acceptBy,
      freeCancelBy: input.freeCancelBy,
      charges,
      chargeDeadline: input.chargeDeadline,
    },
    resolution: {
      contestWindow: input.contestWindow,
      arbiter: input.arbiter,
      day90SupplierShareBps: input.day90SupplierShareBps,
    },
    backing: { kind: 'reserve', side: 'buyer', amount: reserve, releaseDate: input.releaseDate },
  }
}

/** A 32-byte id in lower-case hex, so the same offer never hashes two ways. */
const OFFER_ID = /^0x[0-9a-f]{64}$/

/**
 * What's wrong with a service's subject on its own, or null when nothing is. The offer is a
 * lower-case 32-byte id, the item has a name and a summary of bounded length, the quantity is a
 * whole number of units from 1 up, delivery names its evidence and a deadline, and payment names a
 * route this version knows and a deadline (`terms.template_invalid`). A subject of any other shape
 * is refused here, so nothing that reads it after this throws.
 */
export function serviceSubjectProblem(s: ServiceSubject): ReasonCode | null {
  if (typeof s !== 'object' || s === null) return 'terms.template_invalid'
  if (typeof s.offer !== 'string' || !OFFER_ID.test(s.offer)) return 'terms.template_invalid'
  const item: Partial<ServiceSubject['item']> | undefined = s.item
  const delivery: Partial<ServiceSubject['delivery']> | undefined = s.delivery
  const payment: Partial<ServiceSubject['payment']> | undefined = s.payment
  if (typeof item !== 'object' || item === null) return 'terms.template_invalid'
  if (!isFilled(item.name, SERVICE_NAME_MAX) || !isFilled(item.summary, SERVICE_TEXT_MAX)) {
    return 'terms.template_invalid'
  }
  if (!Number.isSafeInteger(s.quantity) || s.quantity < 1 || s.quantity > SERVICE_QUANTITY_MAX) {
    return 'terms.template_invalid'
  }
  if (typeof delivery !== 'object' || delivery === null) return 'terms.template_invalid'
  if (typeof delivery.by !== 'bigint' || !isFilled(delivery.evidence, SERVICE_TEXT_MAX)) {
    return 'terms.template_invalid'
  }
  if (typeof payment !== 'object' || payment === null) return 'terms.template_invalid'
  if (!isPaymentRoute(payment.route) || typeof payment.dueBy !== 'bigint') {
    return 'terms.template_invalid'
  }
  return null
}

/**
 * The template's own rules, which a reader checks after the core's. The subject passes
 * `serviceSubjectProblem`, and the consideration is a price above zero per unit. The supplier
 * accepts and free cancellation ends by the delivery deadline, which falls by the charge deadline,
 * and payment is due at or after delivery. A late cancellation is chargeable from the
 * free-cancellation deadline, and a no-show from the delivery deadline or later. No other charge
 * applies to a service.
 */
export function validateService(
  t: Pick<ServiceTerms, 'subject' | 'consideration' | 'remedies'>,
): ReasonCode | null {
  const { subject: s, remedies: r, consideration: c } = t
  const subject = serviceSubjectProblem(s)
  if (subject) return subject
  if (c.kind !== 'rate' || c.unit !== SERVICE_UNIT || c.amount <= 0n) {
    return 'terms.template_invalid'
  }
  const by = s.delivery.by
  if (r.acceptBy > by || r.freeCancelBy > by || by > r.chargeDeadline) {
    return 'terms.deadlines_out_of_order'
  }
  if (s.payment.dueBy < by) return 'terms.deadlines_out_of_order'
  for (const charge of r.charges) {
    if (charge.kind === 'lateCancellation') {
      if (charge.earliest !== r.freeCancelBy) return 'terms.template_invalid'
    } else if (charge.kind === 'noShow') {
      if (charge.earliest < by) return 'terms.deadlines_out_of_order'
    } else {
      return 'terms.template_invalid'
    }
  }
  return null
}

/** What a service's price comes to for the quantity booked, in micros. */
export const servicePrice = (t: Pick<ServiceTerms, 'subject' | 'consideration'>): bigint =>
  totalOf(t.consideration.amount, t.subject.quantity)

/** How long a supplier has to accept a service booking, in seconds. */
export const SERVICE_ACCEPT_WITHIN = 15n * 60n

/** How long after the delivery deadline a supplier can report a charge, in seconds. */
export const SERVICE_CHARGE_AFTER = 24n * 60n * 60n

/** The contest window of a service booking on the testnet, in seconds, as for compute. */
const SERVICE_CONTEST_WINDOW = 10n * 60n

/**
 * A supplier's rules for booking one of its services, which it approves when it publishes the
 * offer. Every time counts from the moment the terms are built.
 */
export interface ServiceRules {
  /** What counts as evidence that the supplier delivered. */
  evidence: string
  /** How long after booking the supplier delivers by, in seconds, at least `SERVICE_ACCEPT_WITHIN`. */
  leadTime: bigint
  /** The most units one booking takes. */
  maxPerBooking: number
  /**
   * How many bookings the supplier takes in a day. The terms don't carry it, so whoever accepts
   * bookings for the supplier counts against it.
   */
  dailyCapacity: number
  /**
   * How long after booking the buyer can cancel at no charge, in seconds. Zero, so no booking is
   * free to cancel, or from `SERVICE_ACCEPT_WITHIN` to the lead time, so the window outlasts the
   * supplier's time to accept.
   */
  freeCancelWindow: bigint
  /** What a late cancellation can cost, as a share of the price in basis points. */
  lateCancellationBps: number
  /** What not being there to take delivery can cost, as a share of the price in basis points. */
  noShowBps: number
  /** How the buyer pays, and how long after the delivery deadline payment is due, in seconds. */
  payment: { route: PaymentRoute; dueAfterDelivery: bigint }
}

/**
 * One version of a supplier's offer of a service: what it sells, at what price, under which of its
 * rules. A version never changes. A new price or a change to the rules is a new version, with a
 * new id, so a booking always names exactly what its buyer saw.
 */
export interface ServiceOfferVersion {
  /** The supplier's business id. */
  supplier: string
  item: ServiceSubject['item']
  currency: Currency
  /** The price of one unit, in micros. */
  unitPrice: bigint
  rules: ServiceRules
}

const whole = (n: unknown, max: number) =>
  Number.isSafeInteger(n) && (n as number) >= 1 && (n as number) <= max
const share = (bps: unknown) =>
  Number.isSafeInteger(bps) && (bps as number) >= 0 && (bps as number) <= 10_000

/**
 * What's wrong with an offer version, in words for the person setting it, or null when nothing
 * is. The supplier and item are named, the price is above zero, the lead time leaves the supplier
 * its time to accept, free cancellation is off or outlasts that time and ends by delivery, a
 * booking takes 1 to `SERVICE_QUANTITY_MAX` units, capacity is at least one booking a day, each
 * charge is a share from 0 to 100%, and at least one is above zero, since a reserve with nothing to
 * charge backs nothing. Every field has its declared type, so a version that passes hashes one way
 * only.
 */
export function serviceOfferProblem(v: ServiceOfferVersion): string | null {
  if (!isFilled(v.supplier, SUPPLIER_ID_MAX)) return "Name the supplier's business."
  if (!isFilled(v.item?.name, SERVICE_NAME_MAX)) {
    return `Name the item in 1 to ${SERVICE_NAME_MAX} characters.`
  }
  if (!isFilled(v.item?.summary, SERVICE_TEXT_MAX)) {
    return `Say what the item is in 1 to ${SERVICE_TEXT_MAX} characters.`
  }
  if (!(CURRENCIES as readonly unknown[]).includes(v.currency)) return 'Choose a currency.'
  if (typeof v.unitPrice !== 'bigint' || v.unitPrice <= 0n) {
    return 'The price has to be more than zero.'
  }
  const r = v.rules
  if (typeof r !== 'object' || r === null) return 'Set the rules for booking.'
  if (!isFilled(r.evidence, SERVICE_TEXT_MAX)) return 'Say what counts as delivery.'
  if (typeof r.leadTime !== 'bigint' || r.leadTime < SERVICE_ACCEPT_WITHIN) {
    return 'The lead time has to be at least 15 minutes, so you have time to accept.'
  }
  if (
    typeof r.freeCancelWindow !== 'bigint' ||
    (r.freeCancelWindow !== 0n &&
      (r.freeCancelWindow < SERVICE_ACCEPT_WITHIN || r.freeCancelWindow > r.leadTime))
  ) {
    return 'Free cancellation is off, or lasts from 15 minutes to the lead time.'
  }
  if (!whole(r.maxPerBooking, SERVICE_QUANTITY_MAX)) {
    return `A booking takes from 1 to ${SERVICE_QUANTITY_MAX} units.`
  }
  if (!whole(r.dailyCapacity, SERVICE_QUANTITY_MAX)) {
    return 'Capacity is at least one booking a day.'
  }
  if (!share(r.lateCancellationBps) || !share(r.noShowBps)) {
    return 'A charge is a share of the price from 0 to 100%.'
  }
  if (r.lateCancellationBps === 0 && r.noShowBps === 0) {
    return 'Set a late-cancellation or no-show charge, or the reserve backs nothing.'
  }
  if (typeof r.payment !== 'object' || r.payment === null || !isPaymentRoute(r.payment.route)) {
    return 'Choose how the buyer pays.'
  }
  if (typeof r.payment.dueAfterDelivery !== 'bigint' || r.payment.dueAfterDelivery < 0n) {
    return 'Payment is due at or after delivery.'
  }
  return null
}

const text = (max: number) => z.string().min(1).max(max)

/** An offer version as JSON, with amounts and times as decimal strings and nothing else in it. */
export const serviceOfferVersionJson = z.strictObject({
  supplier: text(SUPPLIER_ID_MAX),
  item: z.strictObject({ name: text(SERVICE_NAME_MAX), summary: text(SERVICE_TEXT_MAX) }),
  currency: z.enum(CURRENCIES),
  unitPrice: u256,
  rules: z.strictObject({
    evidence: text(SERVICE_TEXT_MAX),
    leadTime: u64,
    maxPerBooking: z.number().int(),
    dailyCapacity: z.number().int(),
    freeCancelWindow: u64,
    lateCancellationBps: z.number().int(),
    noShowBps: z.number().int(),
    payment: z.strictObject({ route: z.enum(PAYMENT_ROUTES), dueAfterDelivery: u64 }),
  }),
})

/** Reads an offer version from JSON, refusing one `serviceOfferProblem` finds anything wrong with. */
export function parseServiceOfferVersion(json: unknown): Parsed<ServiceOfferVersion> {
  const parsed = serviceOfferVersionJson.safeParse(json)
  if (!parsed.success) return { ok: false, reason: 'message.invalid' }
  const version: ServiceOfferVersion = parsed.data
  return serviceOfferProblem(version) === null
    ? { ok: true, value: version }
    : { ok: false, reason: 'message.invalid' }
}

/** The label an offer version's id is hashed under, so it can't be read as any other hash. */
const OFFER_VERSION_LABEL = 'avow:offer:service/1'

/**
 * An offer version's id: keccak256 of the ABI encoding of `avow:offer:service/1` and the
 * version's canonical JSON as a string. It hashes exactly the fields a version has, so the same
 * version always has the same id, and it throws for a version `serviceOfferProblem` refuses rather
 * than give one an id.
 */
export function offerVersionId(version: ServiceOfferVersion): Hex {
  const problem = serviceOfferProblem(version)
  if (problem) throw new RangeError(problem)
  const { supplier, item, currency, unitPrice, rules: r } = version
  const hashed: ServiceOfferVersion = {
    supplier,
    item: { name: item.name, summary: item.summary },
    currency,
    unitPrice,
    rules: {
      evidence: r.evidence,
      leadTime: r.leadTime,
      maxPerBooking: r.maxPerBooking,
      dailyCapacity: r.dailyCapacity,
      freeCancelWindow: r.freeCancelWindow,
      lateCancellationBps: r.lateCancellationBps,
      noShowBps: r.noShowBps,
      payment: { route: r.payment.route, dueAfterDelivery: r.payment.dueAfterDelivery },
    },
  }
  return keccak256(
    encodeAbiParameters(
      [{ type: 'string' }, { type: 'string' }],
      [OFFER_VERSION_LABEL, canonicalJson(hashed)],
    ),
  )
}

const BPS = 10_000n

/** What booking a number of units of an offer version costs, in micros. */
export interface ServiceOfferQuote {
  /** The whole price, the unit price times the quantity, paid by the payment route. */
  total: bigint
  /** What a late cancellation can cost, the version's share of the whole price. */
  lateCancellation: bigint
  /** What not being there to take delivery can cost, the version's share of the whole price. */
  noShow: bigint
  /** The reserve the booking takes, the larger of the two charges. */
  reserve: bigint
}

/**
 * What booking `quantity` units of an offer version costs. A search prices an offer with it and
 * `serviceOfferTerms` builds terms from it, so the price an agent is shown is the price it books.
 * Throws for a version `serviceOfferProblem` refuses, a quantity the version doesn't take, or a
 * price so small that every charge rounds to zero.
 */
export function serviceOfferQuote(
  version: ServiceOfferVersion,
  quantity: number,
): ServiceOfferQuote {
  const problem = serviceOfferProblem(version)
  if (problem) throw new RangeError(problem)
  const { rules } = version
  if (!whole(quantity, rules.maxPerBooking)) {
    throw new RangeError(`The offer takes 1 to ${rules.maxPerBooking} units a booking`)
  }
  const total = totalOf(version.unitPrice, quantity)
  const lateCancellation = (total * BigInt(rules.lateCancellationBps)) / BPS
  const noShow = (total * BigInt(rules.noShowBps)) / BPS
  if (lateCancellation === 0n && noShow === 0n) {
    throw new RangeError('At this price and quantity every charge rounds to zero')
  }
  return { total, lateCancellation, noShow, reserve: reserveOf(lateCancellation, noShow) }
}

/**
 * The service terms for booking `quantity` units of an offer version at `now`. Delivery is due the
 * lead time after `now`, free cancellation lasts the version's window from `now`, and the supplier
 * accepts within `SERVICE_ACCEPT_WITHIN`. A late cancellation and a no-show cost their shares of the
 * whole price, charges can be reported until `SERVICE_CHARGE_AFTER` past the delivery deadline,
 * when the reserve comes back, and the contest window is ten minutes. Payment is due the version's
 * interval after the delivery deadline. The arbiter and the day-90 share are the deployment's,
 * which Avow's approvals name. Throws for a version `serviceOfferProblem` refuses, a quantity the
 * version doesn't take, or a price so small that every charge rounds to zero.
 */
export function serviceOfferTerms(
  version: ServiceOfferVersion,
  quantity: number,
  now: bigint,
  settlement: { arbiter: Address; day90SupplierShareBps: number },
): ServiceTerms {
  const offer = offerVersionId(version)
  const { rules } = version
  const { lateCancellation, noShow } = serviceOfferQuote(version, quantity)
  const deliverBy = now + rules.leadTime
  const chargeDeadline = deliverBy + SERVICE_CHARGE_AFTER
  const terms = serviceTerms({
    offer,
    item: version.item,
    quantity,
    currency: version.currency,
    unitPrice: version.unitPrice,
    deliverBy,
    evidence: rules.evidence,
    payment: { route: rules.payment.route, dueBy: deliverBy + rules.payment.dueAfterDelivery },
    acceptBy: now + SERVICE_ACCEPT_WITHIN,
    freeCancelBy: now + rules.freeCancelWindow,
    lateCancellation,
    noShow,
    chargeDeadline,
    contestWindow: SERVICE_CONTEST_WINDOW,
    releaseDate: chargeDeadline,
    arbiter: settlement.arbiter,
    day90SupplierShareBps: settlement.day90SupplierShareBps,
  })
  // The version passed every rule above, so its terms pass the template's.
  const problem = validateService(terms)
  if (problem) throw new Error(`The offer built terms its template refuses, ${problem}`)
  return terms
}

/**
 * Whether service terms are exactly the ones `serviceOfferTerms` builds from this version for
 * their quantity, at the moment their delivery deadline implies, under their own arbiter and
 * day-90 share. A booking that passes names the version's id and carries its item, price,
 * evidence, payment, deadlines and charges unchanged, so a supplier or Avow can tell the price a
 * buyer signed is the version's price.
 */
export function serviceTermsMatchOffer(terms: ServiceTerms, version: ServiceOfferVersion): boolean {
  if (serviceOfferProblem(version) !== null || serviceSubjectProblem(terms.subject) !== null) {
    return false
  }
  if (terms.subject.offer !== offerVersionId(version)) return false
  let expected: ServiceTerms
  try {
    expected = serviceOfferTerms(
      version,
      terms.subject.quantity,
      terms.subject.delivery.by - version.rules.leadTime,
      {
        arbiter: terms.resolution.arbiter,
        day90SupplierShareBps: terms.resolution.day90SupplierShareBps,
      },
    )
  } catch {
    return false
  }
  return canonicalJson(expected) === canonicalJson(terms)
}
