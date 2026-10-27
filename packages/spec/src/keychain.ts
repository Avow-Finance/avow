import { SignatureEnvelope } from 'ox/tempo'
import {
  type Address,
  BaseError,
  type Client,
  ContractFunctionRevertedError,
  concat,
  type Hex,
  isAddressEqual,
  keccak256,
} from 'viem'
import { readContract } from 'viem/actions'
import { Abis, Addresses } from 'viem/tempo'
import type { SignatureCheck } from './eip712.js'

/**
 * Tempo's keychain V2 envelope. When a business account's root key or one of its admin keys signs
 * for the account, Tempo's `verifyKeychainAdmin` accepts the signature only inside this envelope:
 * the byte `0x04`, the account's address, then the key's own signature over
 * `keccak256(0x04 || digest || account)`. Tempo refuses a bare signature, and it refuses an
 * envelope that names another account.
 */

/** The hash a root or admin key signs, which binds the signature to one account. */
export function keychainV2Hash(digest: Hex, account: Address): Hex {
  return keccak256(concat(['0x04', digest, account]))
}

/** Wraps a key's serialized signature (secp256k1, P-256 or WebAuthn) for an account. */
export function wrapKeychainV2(account: Address, inner: Hex): Hex {
  return SignatureEnvelope.serialize(
    SignatureEnvelope.from({
      type: 'keychain',
      version: 'v2',
      userAddress: account,
      inner: SignatureEnvelope.from(inner),
    }),
  )
}

/** Anything that signs a 32-byte hash as it is: a viem account, a P-256 key or a passkey. */
export interface HashSigner {
  sign(args: { hash: Hex }): Promise<Hex>
}

/** Signs a digest for an account with its root key or an admin key, ready for the lock. */
export async function signForAccount(account: Address, digest: Hex, key: HashSigner): Promise<Hex> {
  return wrapKeychainV2(account, await key.sign({ hash: keychainV2Hash(digest, account) }))
}

/** Reads a keychain envelope, or returns null when the signature isn't one. */
export function readKeychainEnvelope(
  signature: Hex,
): { version: 'v1' | 'v2'; account: Address; inner: Hex } | null {
  try {
    const envelope = SignatureEnvelope.deserialize(signature)
    if (envelope.type !== 'keychain') return null
    return {
      version: envelope.version ?? 'v1',
      account: envelope.userAddress,
      inner: SignatureEnvelope.serialize(envelope.inner),
    }
  } catch {
    return null
  }
}

/**
 * The same rule as `verifyKeychainAdmin`, checked without a node: a V2 envelope naming the
 * account, around a valid signature by the account's root key or one of its admin keys. Avow's
 * tests use it, and `tempoKeychainCheck` asks the chain itself.
 */
export function keychainSignatureCheck(
  isAdminKey: (account: Address, key: Address) => boolean | Promise<boolean>,
): SignatureCheck {
  return async ({ signer: account, digest, signature }) => {
    const envelope = readKeychainEnvelope(signature)
    if (!envelope || envelope.version !== 'v2') return false
    if (!isAddressEqual(envelope.account, account)) return false
    const payload = keychainV2Hash(digest, account)
    let key: Address
    try {
      const inner = SignatureEnvelope.deserialize(envelope.inner)
      key = SignatureEnvelope.extractAddress({ payload, signature: inner })
      if (!SignatureEnvelope.verify(inner, { payload, address: key })) return false
    } catch {
      return false
    }
    // An account's root key has the account's own address.
    return isAddressEqual(key, account) || (await isAdminKey(account, key))
  }
}

/**
 * Asks Tempo's signature verifier precompile, the same check the lock makes. A refusal returns
 * false, and a network failure throws, so an outage never reads as a forged signature.
 */
export function tempoKeychainCheck(client: Client): SignatureCheck {
  return async ({ signer, digest, signature }) => {
    try {
      return await readContract(client, {
        address: Addresses.signatureVerifier,
        abi: Abis.signatureVerifier,
        functionName: 'verifyKeychainAdmin',
        args: [signer, digest, signature],
      })
    } catch (e) {
      const reverted =
        e instanceof BaseError && e.walk((c) => c instanceof ContractFunctionRevertedError)
      if (reverted) return false
      throw e
    }
  }
}
