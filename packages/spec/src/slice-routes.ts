import type { Address } from 'viem'
import { address } from './json-fields.js'
import { parseWorkerSlices, type WorkerSlices } from './slice-chain.js'
import type { Parsed } from './wire.js'

/** What a worker, or a key above it, sends to read the worker's slices. */
export interface WorkerSlicesRead {
  subKey: Address
}

/** Reads a `WorkerSlicesRead`, which names the worker's key and nothing else. */
export function parseWorkerSlicesRead(json: unknown): Parsed<WorkerSlicesRead> {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return { ok: false, reason: 'message.invalid' }
  }
  const keys = Object.keys(json)
  const subKey = address.safeParse((json as { subKey?: unknown }).subKey)
  if (keys.length !== 1 || !subKey.success) return { ok: false, reason: 'message.invalid' }
  return { ok: true, value: { subKey: subKey.data as Address } }
}

/**
 * Avow's answer with a worker's slices, and what they hold as Avow counts it: what is open under
 * the agent's mandate and under each level, top first, and what each level had approved within the
 * period of its payment limit for the lock's token, in base units. Avow counts a reserve it
 * approved under a slice as open until its approval expired unfunded or the lock shows it
 * released, so the counts can run high and never low.
 */
export interface WorkerSlicesAnswer {
  slices: WorkerSlices
  holdings: {
    openReserves: { mandate: bigint; slices: readonly bigint[] }
    approvedWithin: readonly bigint[]
  }
}

const UINT = /^(0|[1-9][0-9]{0,77})$/
const amount = (v: unknown): bigint | null =>
  typeof v === 'string' && UINT.test(v) ? BigInt(v) : null
const amounts = (v: unknown, length: number): bigint[] | null => {
  if (!Array.isArray(v) || v.length !== length) return null
  const read = v.map(amount)
  return read.every((x) => x !== null) ? (read as bigint[]) : null
}

/** Reads a `WorkerSlicesAnswer`, each slice and revocation under the business's lock. */
export function parseWorkerSlicesAnswer(
  json: unknown,
  expected: { chainId: number; lock: Address },
): Parsed<WorkerSlicesAnswer> {
  const bad = { ok: false, reason: 'message.invalid' } as const
  if (typeof json !== 'object' || json === null) return bad
  const { slices, holdings } = json as { slices?: unknown; holdings?: unknown }
  if (Object.keys(json).length !== 2) return bad
  const read = parseWorkerSlices(slices, expected)
  if (!read.ok) return read
  const depth = read.value.levels.length
  if (typeof holdings !== 'object' || holdings === null) return bad
  const h = holdings as { openReserves?: unknown; approvedWithin?: unknown }
  const open = h.openReserves as { mandate?: unknown; slices?: unknown } | undefined
  if (Object.keys(holdings).length !== 2 || typeof open !== 'object' || open === null) return bad
  if (Object.keys(open).length !== 2) return bad
  const mandate = amount(open.mandate)
  const perSlice = amounts(open.slices, depth)
  const approved = amounts(h.approvedWithin, depth)
  if (mandate === null || !perSlice || !approved) return bad
  return {
    ok: true,
    value: {
      slices: read.value,
      holdings: { openReserves: { mandate, slices: perSlice }, approvedWithin: approved },
    },
  }
}
