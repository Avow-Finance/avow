import { createServer, type Server } from 'node:http'
import { toWire } from '@avow-finance/spec'
import type { ChainReader } from '@avow-finance/verifier'
import { type Address, formatUnits, type Hex, isAddressEqual } from 'viem'
import type { BookingStatus, SupplierStore } from './store.js'

export interface LocalDeps {
  store: SupplierStore
  chain: Pick<ChainReader, 'backing'>
  /** The supplier's payout address, which a commitment it can grant pays. */
  payee: Address
  /** The decimals of the lock's token. */
  decimals: number
  log: (line: string) => void
}

/** What the lock holds for a commitment, as the supplier's system reads it. */
export interface OnChain {
  /** The lock's state, such as `reserved`, `accepted`, `charge_pending` or `released`. */
  state: string
  reserveDollars: string
  /** What the lock still holds, less anything already returned or paid. */
  heldDollars: string
  /** Whether a charge on this commitment pays this supplier's payout address. */
  paysYou: boolean
  freeCancellationEndsAt: string
  releaseDate: string
}

/** The answer to a check of one commitment. */
export interface CommitmentCheck {
  commitmentId: Hex
  /** Where the adapter has the booking: agreed, held, accepting, accepted or lapsed. */
  status: BookingStatus
  /**
   * Whether to grant the capacity now. True only when the adapter has accepted the booking, the
   * lock holds that acceptance, and the commitment pays this supplier.
   */
  grant: boolean
  /** What the lock holds, or null when it holds nothing for this commitment yet. */
  onChain: OnChain | null
  terms: unknown
}

const iso = (seconds: bigint) => new Date(Number(seconds) * 1000).toISOString()
const COMMITMENT = /^\/commitments\/(0x[0-9a-fA-F]{64})$/

/**
 * Checks one commitment for the supplier's own system, from the adapter's booking and a fresh read
 * of the lock. It answers null when the adapter holds no booking for the commitment.
 */
export async function checkCommitment(
  deps: LocalDeps,
  commitmentId: Hex,
): Promise<CommitmentCheck | null> {
  const booking = deps.store.booking(commitmentId)
  if (!booking) return null
  const held = await deps.chain.backing(booking.lock, booking.commitmentId, 'buyer')
  const dollars = (units: bigint) => formatUnits(units, deps.decimals)
  const onChain: OnChain | null =
    held === null || held.state === 'none'
      ? null
      : {
          state: held.state,
          reserveDollars: dollars(held.amount),
          heldDollars: dollars(held.held),
          paysYou: isAddressEqual(held.payee, deps.payee),
          freeCancellationEndsAt: iso(held.freeCancelBy),
          releaseDate: iso(held.releaseDate),
        }
  return {
    commitmentId: booking.commitmentId,
    status: booking.status,
    grant: booking.status === 'accepted' && onChain?.state === 'accepted' && onChain.paysYou,
    onChain,
    terms: toWire(booking.terms),
  }
}

/**
 * The adapter's port for the supplier's own systems, which listens on the loopback address unless
 * told otherwise, so only the supplier's machine reaches it. `GET /commitments/<id>` checks one
 * commitment, and `GET /health` answers while the process runs.
 */
export function localServer(deps: LocalDeps): Server {
  return createServer(async (req, res) => {
    let status = 200
    let body: unknown
    try {
      const match = req.method === 'GET' ? COMMITMENT.exec(req.url ?? '') : null
      if (req.method === 'GET' && req.url === '/health') {
        body = { status: 'ok' }
      } else if (match?.[1]) {
        const check = await checkCommitment(deps, match[1].toLowerCase() as Hex)
        if (check) body = check
        else [status, body] = [404, { error: 'this adapter holds no booking for that commitment' }]
      } else {
        ;[status, body] = [404, { error: 'no such route' }]
      }
    } catch (e) {
      deps.log(`a local check failed: ${e instanceof Error ? e.message : String(e)}`)
      ;[status, body] = [500, { error: 'the adapter could not check the commitment' }]
    }
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  })
}
