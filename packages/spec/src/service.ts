import { type Address, encodeAbiParameters, type Hex, keccak256 } from 'viem'
import { canonicalJson } from './canonical.js'
import type { ReasonCode } from './reasons.js'
import {
  AMOUNT_DECIMALS,
  type Currency,
  type RemedyCharge,
  TERMS_VERSION,
  type TermsOf,
} from './types.js'

/**
 * A service sold by quantity at a fixed price per unit, delivered by a deadline. Version 1 takes
 * one-off services only. Subscriptions, usage billing and physical shipping aren't services under
 * it, and a supplier that sells them doesn't list them. Its meaning is fixed, and a change of
 * meaning would be `service/2`.
 *
 * The terms book one version of a supplier's offer, which `serviceOfferTerms` turns into terms, so
 * the price a buyer saw is the price it books. The buyer's reserve backs only what the buyer owes
 * if it cancels late or isn't there to take delivery. The price is the consideration, which the
 * lock never reads. It's paid by the route and deadline the terms name, and the reserve doesn't
 * secure it.
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

/**
 * How the buyer pays the price, which the lock never reads. `transfer` is a transfer of the
 * terms' currency to the supplier's payee on the commitment's chain. `invoice` is the supplier
 * billing by its own means, which nothing on chain shows.
 */
export const PAYMENT_ROUTES = ['transfer', 'invoice'] as const
export type PaymentRoute = (typeof PAYMENT_ROUTES)[number]

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
  const reserve = input.lateCancellation > input.noShow ? input.lateCancellation : input.noShow
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

const isText = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= max

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
  if (!isText(item.name, SERVICE_NAME_MAX) || !isText(item.summary, SERVICE_TEXT_MAX)) {
    return 'terms.template_invalid'
  }
  if (!Number.isSafeInteger(s.quantity) || s.quantity < 1 || s.quantity > SERVICE_QUANTITY_MAX) {
    return 'terms.template_invalid'
  }
  if (typeof delivery !== 'object' || delivery === null) return 'terms.template_invalid'
  if (typeof delivery.by !== 'bigint' || !isText(delivery.evidence, SERVICE_TEXT_MAX)) {
    return 'terms.template_invalid'
  }
  if (typeof payment !== 'object' || payment === null) return 'terms.template_invalid'
  if (
    !(PAYMENT_ROUTES as readonly unknown[]).includes(payment.route) ||
    typeof payment.dueBy !== 'bigint'
  ) {
    return 'terms.template_invalid'
  }
  return null
}

/**
 * The template's own rules, which a reader checks after the core's. The subject passes
 * `serviceSubjectProblem`, and the consideration is a price above zero per unit. The supplier
 * accepts and free cancellation ends by the delivery deadline, which falls by the charge deadline,
 * and payment isn't due before the supplier could accept. A late cancellation is chargeable from
 * the free-cancellation deadline, and a no-show from the delivery deadline or later.
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
  if (s.payment.dueBy < r.acceptBy) return 'terms.deadlines_out_of_order'
  for (const charge of r.charges) {
    if (charge.kind === 'lateCancellation' && charge.earliest !== r.freeCancelBy) {
      return 'terms.template_invalid'
    }
    if (charge.kind === 'noShow' && charge.earliest < by) return 'terms.deadlines_out_of_order'
    if (charge.kind !== 'lateCancellation' && charge.kind !== 'noShow') {
      return 'terms.template_invalid'
    }
  }
  return null
}

/** What a service's price comes to for the quantity booked, in micros. */
export const servicePrice = (t: Pick<ServiceTerms, 'subject' | 'consideration'>): bigint =>
  t.consideration.amount * BigInt(t.subject.quantity)

/**
 * A supplier's rules for booking one of its services, which it approves when it publishes the
 * offer. Avow and the agent read the same rules, and the terms a booking signs come from them.
 */
export interface ServiceRules {
  /** What counts as evidence that the supplier delivered. */
  evidence: string
  /** How long after booking the supplier delivers by, in seconds. */
  leadTime: bigint
  /** The most units one booking takes. */
  maxPerBooking: number
  /** How many bookings the supplier takes in a day. */
  dailyCapacity: number
  /** How long after booking the buyer can cancel at no charge, in seconds, no longer than the lead time. */
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

/** The label an offer version's id is hashed under, so it can't be read as any other hash. */
const OFFER_VERSION_LABEL = 'avow:offer:service/1'

/**
 * An offer version's id: keccak256 of the ABI encoding of `avow:offer:service/1` and the
 * version's canonical JSON as a string. The same content always has the same id.
 */
export function offerVersionId(version: ServiceOfferVersion): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'string' }, { type: 'string' }],
      [OFFER_VERSION_LABEL, canonicalJson(version)],
    ),
  )
}

const BPS = 10_000n

/**
 * What's wrong with an offer version's rules, or null when nothing is. The lead time is positive,
 * free cancellation ends by the delivery deadline, a booking takes 1 to `SERVICE_QUANTITY_MAX`
 * units, capacity is at least one booking a day, each charge is a share from 0 to 100%, and at
 * least one is above zero, since a reserve with nothing to charge backs nothing.
 */
export function serviceRulesProblem(rules: ServiceRules): string | null {
  if (!isText(rules.evidence, SERVICE_TEXT_MAX)) return 'Say what counts as delivery.'
  if (rules.leadTime <= 0n) return 'The lead time has to be more than zero.'
  if (rules.freeCancelWindow < 0n || rules.freeCancelWindow > rules.leadTime) {
    return 'Free cancellation has to end by the delivery deadline.'
  }
  const whole = (n: number, max: number) => Number.isSafeInteger(n) && n >= 1 && n <= max
  if (!whole(rules.maxPerBooking, SERVICE_QUANTITY_MAX)) {
    return `A booking takes from 1 to ${SERVICE_QUANTITY_MAX} units.`
  }
  if (!whole(rules.dailyCapacity, SERVICE_QUANTITY_MAX)) {
    return 'Capacity is at least one booking a day.'
  }
  const share = (bps: number) => Number.isInteger(bps) && bps >= 0 && bps <= 10_000
  if (!share(rules.lateCancellationBps) || !share(rules.noShowBps)) {
    return 'A charge is a share of the price from 0 to 100%.'
  }
  if (rules.lateCancellationBps === 0 && rules.noShowBps === 0) {
    return 'Set a late-cancellation or no-show charge, or the reserve backs nothing.'
  }
  if (!(PAYMENT_ROUTES as readonly unknown[]).includes(rules.payment.route)) {
    return 'Choose how the buyer pays.'
  }
  if (rules.payment.dueAfterDelivery < 0n) return 'Payment is due at or after delivery.'
  return null
}

/** How long a supplier has to accept a service booking at most, in seconds. */
export const SERVICE_ACCEPT_WITHIN = 15n * 60n

/** How long after the delivery deadline a supplier can report a charge, in seconds. */
export const SERVICE_CHARGE_AFTER = 24n * 60n * 60n

/**
 * The service terms for booking `quantity` units of an offer version at `now`. Delivery is due the
 * lead time after booking, free cancellation lasts the version's window, and the supplier accepts
 * within `SERVICE_ACCEPT_WITHIN`, or by the delivery deadline when that's sooner. A late
 * cancellation and a no-show cost their shares of the whole price, charges can be reported until
 * `SERVICE_CHARGE_AFTER` past the delivery deadline, when the reserve comes back, and the contest
 * window is ten minutes. Payment is due the version's interval after the delivery deadline. The
 * arbiter and the day-90 share are the deployment's, which Avow's approvals name. Throws for a
 * quantity the version doesn't take, rules `serviceRulesProblem` refuses, or a price so small
 * that every charge rounds to zero.
 */
export function serviceOfferTerms(
  version: ServiceOfferVersion,
  quantity: number,
  now: bigint,
  settlement: { arbiter: Address; day90SupplierShareBps: number },
): ServiceTerms {
  const { rules } = version
  const problem = serviceRulesProblem(rules)
  if (problem) throw new RangeError(problem)
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > rules.maxPerBooking) {
    throw new RangeError(`The offer takes 1 to ${rules.maxPerBooking} units a booking`)
  }
  const price = version.unitPrice * BigInt(quantity)
  const lateCancellation = (price * BigInt(rules.lateCancellationBps)) / BPS
  const noShow = (price * BigInt(rules.noShowBps)) / BPS
  if (lateCancellation === 0n && noShow === 0n) {
    throw new RangeError('At this price and quantity every charge rounds to zero')
  }
  const deliverBy = now + rules.leadTime
  const acceptWithin = now + SERVICE_ACCEPT_WITHIN
  const chargeDeadline = deliverBy + SERVICE_CHARGE_AFTER
  return serviceTerms({
    offer: offerVersionId(version),
    item: version.item,
    quantity,
    currency: version.currency,
    unitPrice: version.unitPrice,
    deliverBy,
    evidence: rules.evidence,
    payment: { route: rules.payment.route, dueBy: deliverBy + rules.payment.dueAfterDelivery },
    acceptBy: acceptWithin < deliverBy ? acceptWithin : deliverBy,
    freeCancelBy: now + rules.freeCancelWindow,
    lateCancellation,
    noShow,
    chargeDeadline,
    contestWindow: 10n * 60n,
    releaseDate: chargeDeadline,
    arbiter: settlement.arbiter,
    day90SupplierShareBps: settlement.day90SupplierShareBps,
  })
}
