import { hexToBigInt, toHex } from 'viem'

/** A fresh nonce for a message the supplier signs, from 32 random bytes. */
export const randomNonce = () => hexToBigInt(toHex(crypto.getRandomValues(new Uint8Array(32))))
