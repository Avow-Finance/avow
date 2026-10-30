import {
  type AvowDomain,
  digestOf,
  type HashSigner,
  MESSAGE_VERSIONS,
  type RailToken,
  RELEASE_REASONS,
  type ReasonCode,
  type ReleaseConsent,
  type ReleaseReason,
  releaseConsentTypedData,
  type Signed,
  signForAccount,
  takesConsent,
} from '@avow-finance/spec'
import { type Address, type Hex, isAddressEqual, isHex, size } from 'viem'
import { same } from './authorization.js'
import { type ChainReader, MAX_REPORTS } from './chain.js'
import { type Disclosure, disclosureId, releaseConsentDisclosure } from './disclosure.js'
import { issue, wasIssued } from './issued.js'
import { randomNonce } from './nonce.js'

export interface ConsentConfig {
  chainId: number
  /** The supplier's account, whose root key or admin key signs the consent. */
  account: Address
  /** Tokens the supplier accepts, used to show the amount the consent releases. */
  acceptedTokens: readonly RailToken[]
}

export interface ConsentDeps {
  config: ConsentConfig
  chain: ChainReader
}

export interface ReleaseConsentRequest {
  lock: Address
  commitmentId: Hex
  reason: ReleaseReason
  evidenceHash: Hex
  /**
   * The report count the consent names, the commitment's current count when left out. A later
   * count makes the consent a preauthorization, which the signer has to confirm.
   */
  reportCount?: number
  /** When the consent stops working. A supplier keeps its consents short. */
  expiry: bigint
  now: bigint
  /** The consent's nonce, a fresh random one when left out. */
  nonce?: bigint
}

export interface ReadyReleaseConsent {
  ok: true
  consent: ReleaseConsent
  domain: AvowDomain
  /** The digest the supplier account signs, in Tempo's keychain envelope. */
  digest: Hex
  /** The account that has to sign, the supplier's own. */
  supplierAccount: Address
  /** What to show the person who approves the signature, before signing. */
  disclosure: Disclosure
}

export type PreparedReleaseConsent = ReadyReleaseConsent | { ok: false; reason: ReasonCode }

/**
 * The supported way for a supplier account to get a release consent to sign. It reads the
 * commitment from the lock and refuses a commitment that isn't this supplier's, one the lock
 * wouldn't release on consent, a consent that has already expired, and a report count the
 * commitment has passed or can never reach. A count above the current one is preauthorization,
 * and the disclosure says so. What it returns is frozen, and `signReleaseConsent` signs nothing
 * else. The lock takes a correctly signed consent however it was built.
 */
export async function prepareReleaseConsent(
  request: ReleaseConsentRequest,
  deps: ConsentDeps,
): Promise<PreparedReleaseConsent> {
  const { config, chain } = deps
  if (chain.chainId !== config.chainId) {
    throw new Error(`The chain reader is for chain ${chain.chainId}, not ${config.chainId}`)
  }
  const refuse = (reason: ReasonCode): PreparedReleaseConsent => ({ ok: false, reason })
  if (
    !Object.hasOwn(RELEASE_REASONS, request.reason) ||
    !isHex(request.evidenceHash) ||
    size(request.evidenceHash) !== 32
  ) {
    return refuse('message.invalid')
  }

  const lockInfo = await chain.lock(request.lock)
  if (!lockInfo?.fromFactory) return refuse('chain.lock_unknown')
  const b = await chain.backing(request.lock, request.commitmentId, 'buyer')
  if (!b || b.state === 'none') return refuse('chain.reserve_missing')
  if (!isAddressEqual(b.supplier, config.account)) return refuse('chain.supplier_mismatch')
  const releasable = takesConsent(b.state) && !(b.state === 'paused' && b.hasRuling)
  if (!releasable) return refuse('consent.not_releasable')
  if (request.expiry <= request.now) return refuse('message.expired')
  const count = request.reportCount ?? b.reportCount
  if (!Number.isInteger(count) || count < 0 || count > MAX_REPORTS) {
    return refuse('consent.count_out_of_range')
  }
  if (count < b.reportCount) return refuse('consent.count_passed')

  const consent: ReleaseConsent = {
    commitmentId: request.commitmentId,
    side: 'buyer',
    reportCount: count,
    reason: request.reason,
    evidenceHash: request.evidenceHash,
    nonce: request.nonce ?? randomNonce(),
    expiry: request.expiry,
  }
  const d = { chainId: config.chainId, verifyingContract: request.lock }
  const digest = digestOf(releaseConsentTypedData(consent, d))
  const token = config.acceptedTokens.find(
    (a) => a.chainId === config.chainId && isAddressEqual(a.token, lockInfo.token),
  )
  return issue({
    ok: true,
    consent,
    domain: d,
    digest,
    supplierAccount: config.account,
    disclosure: releaseConsentDisclosure({
      digest,
      consent,
      lock: request.lock,
      chainId: config.chainId,
      account: lockInfo.account,
      held: b.held,
      token: token ?? null,
      currentCount: b.reportCount,
      now: request.now,
    }),
  })
}

/**
 * Signs a consent as the supplier account, with its root key or an admin key, once the person has
 * seen its disclosure. A consent that names a later report count than the commitment has also
 * needs `preauthorize: true`. It signs only the object `prepareReleaseConsent` returned, which is
 * frozen, so a copy or an edit of it throws. It also throws when the confirmation doesn't match,
 * or when the signature isn't one the chain accepts for the supplier account.
 */
export async function signReleaseConsent(
  prepared: ReadyReleaseConsent,
  key: HashSigner,
  confirmation: { disclosureId: Hex; preauthorize?: boolean },
  deps: { chain: ChainReader },
): Promise<Signed<ReleaseConsent>> {
  if (!wasIssued(prepared)) {
    throw new Error('Sign only the consent prepareReleaseConsent returned, as it returned it')
  }
  const digest = digestOf(releaseConsentTypedData(prepared.consent, prepared.domain))
  const { disclosure } = prepared
  if (
    !same(digest, prepared.digest) ||
    !same(disclosure.digest, digest) ||
    !same(disclosureId(disclosure), disclosure.id)
  ) {
    throw new Error('The consent or its disclosure changed after prepareReleaseConsent built them')
  }
  if (!same(confirmation?.disclosureId, disclosure.id)) {
    throw new Error(
      "Show the person this consent's disclosure, and pass its id back once they confirm it",
    )
  }
  if (disclosure.preauthorization && confirmation?.preauthorize !== true) {
    throw new Error(
      'This consent names a later report count than the commitment has, so it releases the reserve after a report not yet filed. Pass preauthorize: true only if the person means that',
    )
  }
  const signature = await signForAccount(prepared.supplierAccount, digest, key)
  if (!(await deps.chain.isAccountSignature(prepared.supplierAccount, digest, signature))) {
    throw new Error("The key that signed isn't the supplier account's root key or an admin key")
  }
  return {
    type: 'ReleaseConsent',
    schemaVersion: MESSAGE_VERSIONS.ReleaseConsent,
    chainId: prepared.domain.chainId,
    lock: prepared.domain.verifyingContract,
    message: prepared.consent,
    signature,
  }
}
