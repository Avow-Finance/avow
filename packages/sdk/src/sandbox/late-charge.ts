import {
  type AvowDomain,
  type Mandate,
  type Parsed,
  type RequestKey,
  toWire,
} from '@avow-finance/spec'
import type { Hex } from 'viem'
import { type AvowRequestConfig, avowRequests } from '../http.js'

/**
 * Where a late-cancellation charge stands once the lock holds its report, as Avow's demo GPU
 * supplier answers it. `awaiting_avow` is a report Avow hasn't confirmed or referred yet, and the
 * rest are `reportOutcome`'s words for what the lock shows.
 */
export const LATE_CHARGE_OUTCOMES = [
  'awaiting_avow',
  'confirmed',
  'charged',
  'ruling',
  'unanswered',
  'withdrawn',
  'ended',
] as const
export type LateChargeOutcome = (typeof LATE_CHARGE_OUTCOMES)[number]

/** The demo supplier's answer once the lock holds its report of a late cancellation. */
export interface LateChargeReport {
  commitmentId: Hex
  /** The charge the report asks for, in base units of the lock's token. */
  amount: bigint
  /** The transaction that filed the report on the lock. */
  transaction: Hex
  outcome: LateChargeOutcome
}

/** The path the demo supplier takes a booking's own buyer asking it to charge a late cancellation. */
export const lateChargePath = (commitmentId: Hex): string =>
  `/v1/bookings/${commitmentId}/late-cancellation`

const HASH = /^0x[0-9a-f]{64}$/i

/** Reads the demo supplier's answer about one booking's report, or gives the reason it can't. */
export function parseLateChargeReport(json: unknown, commitmentId: Hex): Parsed<LateChargeReport> {
  const no: Parsed<LateChargeReport> = { ok: false, reason: 'message.invalid' }
  if (typeof json !== 'object' || json === null) return no
  const a = json as Record<string, unknown>
  if (
    typeof a.commitmentId !== 'string' ||
    a.commitmentId.toLowerCase() !== commitmentId.toLowerCase()
  ) {
    return no
  }
  if (a.kind !== 'lateCancellation') return no
  if (typeof a.amount !== 'string' || !/^[1-9][0-9]{0,77}$/.test(a.amount)) return no
  if (typeof a.transaction !== 'string' || !HASH.test(a.transaction)) return no
  const outcome = LATE_CHARGE_OUTCOMES.find((o) => o === a.outcome)
  if (!outcome) return no
  return {
    ok: true,
    value: { commitmentId, amount: BigInt(a.amount), transaction: a.transaction as Hex, outcome },
  }
}

export interface LateChargeConfig extends Omit<AvowRequestConfig, 'key' | 'baseUrl'> {
  /** The demo supplier's origin, which the request is signed for. */
  supplierUrl: string
  /** The key of the agent that made the booking, through `agentRequestKey`. */
  key: RequestKey
  /** The chain and the buyer's lock, which the request is signed under. */
  domain: AvowDomain
  commitmentId: Hex
  /** The mandate the booking was made under, whose hash the supplier's agreement names. */
  mandate: Mandate
}

/**
 * Asks Avow's demo GPU supplier, a test business, to report the late-cancellation charge the terms
 * of one of its bookings allow. A real supplier reports a late cancellation on its own, and the demo
 * supplier waits to be asked by the booking's own buyer, signed with the key of the mandate the
 * booking was made under, so a buyer can watch a charge go through on testnet when it wants to.
 * Asking grants nothing. The supplier reports only what the terms allow, and Avow confirms the
 * charge only when it recorded the business cancelling after free cancellation ended.
 *
 * It answers once the lock holds the report, sending the same request again while the supplier
 * says it's on its way, and throws an `AvowApiError` with the supplier's reason when it refuses.
 */
export function askForLateCharge(config: LateChargeConfig): Promise<LateChargeReport> {
  const { supplierUrl, key, domain, commitmentId, mandate, ...request } = config
  const send = avowRequests({
    retryFor: 300n,
    ...request,
    baseUrl: new URL(supplierUrl).origin,
    key,
  })
  return send({
    domain,
    path: lateChargePath(commitmentId),
    body: { mandate: toWire(mandate) },
    read: (json) => parseLateChargeReport(json, commitmentId),
  })
}
