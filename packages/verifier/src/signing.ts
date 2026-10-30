import {
  type AvowDomain,
  type AvowTypedData,
  digestOf,
  type HashSigner,
  isKeySignature,
  MESSAGE_VERSIONS,
  type Signed,
} from '@avow-finance/spec'
import type { Address, Hex } from 'viem'
import { same } from './authorization.js'
import { type Disclosure, disclosureId } from './disclosure.js'
import { wasIssued } from './issued.js'

/** What a prepare call returns for a message, which only that message's signing call signs. */
export interface Prepared {
  domain: AvowDomain
  /** The digest the message's signer signs. */
  digest: Hex
  disclosure: Disclosure
}

/** How a signing call's errors name its message and the prepare call that built it. */
export interface SigningNames {
  message: string
  prepare: string
}

/**
 * Checks a prepared message before anything signs it, and returns the digest to sign. It has to be
 * the frozen object its prepare call returned, its digest and disclosure have to match its message,
 * and the confirmation has to name that disclosure, so nothing is signed before a person has seen
 * what it binds the signer to.
 */
export function checkPrepared(
  prepared: Prepared,
  typedData: AvowTypedData,
  confirmation: { disclosureId: Hex },
  names: SigningNames,
): Hex {
  if (!wasIssued(prepared)) {
    throw new Error(`Sign only the ${names.message} ${names.prepare} returned, as it returned it`)
  }
  const digest = digestOf(typedData)
  const { disclosure } = prepared
  if (
    !same(digest, prepared.digest) ||
    !same(disclosure.digest, digest) ||
    !same(disclosureId(disclosure), disclosure.id)
  ) {
    throw new Error(
      `The ${names.message} or its disclosure changed after ${names.prepare} built them`,
    )
  }
  if (!same(confirmation?.disclosureId, disclosure.id)) {
    throw new Error(
      `Show the person this ${names.message}'s disclosure, and pass its id back once they confirm it`,
    )
  }
  return digest
}

/** A signed message as it travels, under the domain its prepare call built it for. */
export function signedMessage<T>(
  typedData: AvowTypedData,
  domain: AvowDomain,
  message: T,
  signature: Hex,
): Signed<T> {
  return {
    type: typedData.primaryType,
    schemaVersion: MESSAGE_VERSIONS[typedData.primaryType],
    chainId: domain.chainId,
    lock: domain.verifyingContract,
    message,
    signature,
  }
}

/**
 * Signs a prepared message with one key's own signature, as the supplier's signing key signs an
 * acceptance or a report. It signs only once `checkPrepared` passes, and throws when the signature
 * isn't the one key the message has to come from.
 */
export async function signWithKey<T>(args: {
  prepared: Prepared & { signingKey: Address }
  typedData: AvowTypedData
  message: T
  key: HashSigner
  confirmation: { disclosureId: Hex }
  /** `signingKey` describes the key the message has to come from, for the error. */
  names: SigningNames & { signingKey: string }
}): Promise<Signed<T>> {
  const digest = checkPrepared(args.prepared, args.typedData, args.confirmation, args.names)
  const signature = await args.key.sign({ hash: digest })
  if (!isKeySignature(digest, signature, args.prepared.signingKey)) {
    throw new Error(`The key that signed isn't ${args.names.signingKey}`)
  }
  return signedMessage(args.typedData, args.prepared.domain, args.message, signature)
}
