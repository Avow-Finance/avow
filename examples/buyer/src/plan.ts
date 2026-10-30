import {
  dollars,
  type GpuReservationInput,
  type Mandate,
  type SupplierProfile,
} from '@avow-finance/spec'
import { type Address, type Hex, toHex } from 'viem'

const MINUTE = 60n
const DAY = 86_400n

/**
 * The mandate the quickstart's administrator signs. The agent may reserve with one supplier, for
 * compute, up to `reserve` per booking and `open` bookings at once, for a week, and may cancel or
 * start its bookings through Avow. Every booking goes ahead without a person's approval, which a
 * real business would set to fit its own rules.
 */
export function quickstartMandate(m: {
  businessId: string
  agentId: string
  account: Address
  agentKey: Address
  supplier: SupplierProfile
  token: Address
  reserve: bigint
  open: bigint
  now: bigint
}): Mandate {
  return {
    mandateId: toHex(crypto.getRandomValues(new Uint8Array(32))) as Hex,
    businessId: m.businessId,
    agentId: m.agentId,
    account: m.account,
    agentKey: m.agentKey,
    actions: ['reserve', 'cancel', 'start'],
    currency: 'USD',
    capPerCommitment: m.reserve,
    capOpenReserves: m.reserve * m.open,
    suppliers: [m.supplier.businessId],
    categories: ['compute'],
    paymentLimits: [{ token: m.token, amount: m.reserve * m.open, period: DAY }],
    approvalRule: { kind: 'never' },
    expiry: m.now + 7n * DAY,
    nonce: 1n,
  }
}

/**
 * What the agent books: 8 H100s for a window starting `startsIn` seconds from now, holding a
 * reserve as large as the no-show charge. Free cancellation ends before the window opens, a
 * late cancellation costs half the reserve, and the reserve goes back at the window's end when
 * nothing is reported. A short window, such as one minute starting in three, runs the whole
 * booking in a few minutes.
 */
export function quickstartBooking(b: {
  now: bigint
  startsIn: bigint
  minutes: bigint
  reserve: bigint
  arbiter: Address
  day90SupplierShareBps: number
}): GpuReservationInput {
  if (b.startsIn < 2n * MINUTE)
    throw new RangeError('The window has to start at least two minutes ahead')
  if (b.minutes < 1n) throw new RangeError('The window has to last at least a minute')
  const windowStart = b.now + b.startsIn
  const windowDuration = b.minutes * MINUTE
  const windowEnd = windowStart + windowDuration
  // Free cancellation ends halfway to the window, at most ten minutes before it opens.
  const halfway = b.startsIn / 2n
  const freeCancelBy = windowStart - (halfway < 10n * MINUTE ? halfway : 10n * MINUTE)
  // A no-show is chargeable after a grace period inside the window.
  const half = windowDuration / 2n
  const gracePeriod = half < 2n * MINUTE ? half : 2n * MINUTE
  return {
    resource: { gpu: 'H100', count: 8, region: 'demo', sku: 'demo-h100x8' },
    currency: 'USD',
    windowStart,
    windowDuration,
    pricePerGpuHour: dollars(3),
    freeCancelBy,
    lateCancellation: b.reserve / 2n,
    noShow: b.reserve,
    gracePeriod,
    chargeDeadline: windowEnd,
    contestWindow: 10n * MINUTE,
    releaseDate: windowEnd,
    arbiter: b.arbiter,
    day90SupplierShareBps: b.day90SupplierShareBps,
  }
}
