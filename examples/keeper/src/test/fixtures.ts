import type { Address, Hex } from 'viem'

/** What the keeper's tests share. None of it is a real deployment. */

export const FACTORY: Address = '0x00000000000000000000000000000000000f0c70'
export const EXPLORER = 'https://explore.testnet.tempo.xyz'

/** A lock address from a small number. */
export const lockAt = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}`

/** A commitment id from a small number. */
export const commitment = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`
