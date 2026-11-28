import { checkMandate, type MandateCheck, type MandateCheckInput } from './mandate.js'
import { sliceAsMandate } from './slice.js'
import type { SliceChain } from './slice-chain.js'

export interface SlicedCheckInput extends Omit<MandateCheckInput, 'mandate' | 'openReserves'> {
  /** The worker's slices, checked back to the agent's mandate by `sliceChainProblem`. */
  chain: SliceChain
  /**
   * Micros reserved and still open: under the agent's mandate by the agent and every worker, and
   * for each level of the chain, under that slice and every slice below it, top first.
   */
  openReserves: { mandate: bigint; slices: readonly bigint[] }
}

/**
 * Where a sliced check refused, as the index of the level that refused: 0 for the agent's mandate,
 * 1 for the slice just under it, and so on down to the worker's own.
 */
export type SlicedCheck = MandateCheck & { level: number }

/**
 * The mandate check for a worker acting under a slice. It runs `checkMandate` on the agent's
 * current mandate with everything open under it, then on each slice from the top down, read as a
 * mandate with that slice's limits and with what's open under it and below it. A reserve passes
 * only when every level lets it, so a slice can never let a worker do what its parent can't, and
 * what every slice holds together never passes its parent's caps, prices and payment limits.
 *
 * It refuses with the first level that refuses, from the top. It sends the reserve to a person
 * when no level refuses and any level asks for one. A slice's limits are held only here, in the
 * SDK and in Avow's API, while the lock and the keychain hold every worker together to the
 * mandate a person signed.
 */
export function checkSlicedMandate(input: SlicedCheckInput): SlicedCheck {
  const { chain, openReserves, ...rest } = input
  if (openReserves.slices.length !== chain.levels.length) {
    throw new RangeError('Name what is open under every level of the chain')
  }
  const mandate = chain.mandates.current.proof.message
  const levels = [
    { mandate, open: openReserves.mandate },
    ...chain.levels.map((l, i) => ({
      mandate: sliceAsMandate(mandate, l.slice),
      open: openReserves.slices[i] as bigint,
    })),
  ]
  let human: SlicedCheck | null = null
  for (const [level, l] of levels.entries()) {
    const check = checkMandate({ ...rest, mandate: l.mandate, openReserves: l.open })
    if (check.result === 'denied') return { ...check, level }
    if (check.result === 'needs_human' && human === null) human = { ...check, level }
  }
  return human ?? { result: 'approved', reason: 'approved', level: 0 }
}
