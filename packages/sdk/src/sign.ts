import {
  type AvowDomain,
  type HashSigner,
  type HumanApproval,
  humanApprovalTypedData,
  isReplacementTypedData,
  type Mandate,
  MESSAGE_VERSIONS,
  mandateTypedData,
  type Signed,
  signForAccount,
} from '@avow-finance/spec'
import {
  type Address,
  type Hex,
  hashTypedData,
  isAddressEqual,
  type TypedData,
  type TypedDataDefinition,
} from 'viem'

/**
 * Signs for a business account with its root key or an admin key. Every signature comes out in
 * Tempo's keychain V2 envelope, which the lock's `verifyKeychainAdmin` check and Avow's API need.
 * A browser passkey from viem's `Account.fromWebAuthnP256` signs bare, so pass it here as `key`
 * and the envelope is added for it.
 */
export interface AccountSigner {
  readonly account: Address
  signDigest(digest: Hex): Promise<Hex>
  signTypedData<
    const T extends TypedData | Record<string, unknown>,
    P extends keyof T | 'EIP712Domain',
  >(typedData: TypedDataDefinition<T, P>): Promise<Hex>
}

export function accountSigner(account: Address, key: HashSigner): AccountSigner {
  return {
    account,
    signDigest: (digest) => signForAccount(account, digest, key),
    signTypedData: (typedData) => signForAccount(account, hashTypedData(typedData), key),
  }
}

function envelope<T>(
  type: Signed<T>['type'],
  d: AvowDomain,
  message: T,
  signature: Hex,
): Signed<T> {
  return {
    type,
    schemaVersion: MESSAGE_VERSIONS[type],
    chainId: d.chainId,
    lock: d.verifyingContract,
    message,
    signature,
  }
}

/** The administrator signs a mandate for one agent, as the business account. */
export async function signMandate(
  mandate: Mandate,
  d: AvowDomain,
  signer: AccountSigner,
): Promise<Signed<Mandate>> {
  if (!isAddressEqual(mandate.account, signer.account)) {
    throw new Error("The mandate names another account than the signer's")
  }
  const td = mandateTypedData(mandate, d)
  // Both branches make the same call, since viem types its argument by one table.
  const signature = isReplacementTypedData(td)
    ? await signer.signTypedData(td)
    : await signer.signTypedData(td)
  // The envelope carries the version the typed data signed at, which `replaces` decided.
  return { ...envelope('Mandate', d, mandate, signature), schemaVersion: td.domain.version }
}

/** The administrator approves one reserve in person, as the business account. */
export async function signHumanApproval(
  approval: HumanApproval,
  d: AvowDomain,
  signer: AccountSigner,
): Promise<Signed<HumanApproval>> {
  const signature = await signer.signTypedData(humanApprovalTypedData(approval, d))
  return envelope('HumanApproval', d, approval, signature)
}
