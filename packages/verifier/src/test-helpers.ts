import {
  type Approval,
  approvalDigest,
  approvalTypedData,
  type CommitmentReference,
  type Dependency,
  digestOf,
  discloseSection,
  dollars,
  gpuReservationTerms,
  type LockRecordField,
  type LockTerms,
  type Mandate,
  mandateHash,
  mandateTypedData,
  type RailToken,
  type Side,
  type SupplierAuthorization,
  signForAccount,
  supplierAuthorizationTypedData,
  TESTNET_DEMO_PROFILE,
  termsHash,
  testnetDemoTerms,
  toWire,
} from '@avow-finance/spec'
import { type Address, type Hex, keccak256, stringToHex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import type { AcceptanceConfig } from './accept.js'
import { type LockedBacking, type LockInfo, MemoryChain } from './chain.js'
import type { DependencyRecord, PinnedBlock, PinnedLockReader } from './dependency.js'
import type { VerifierConfig } from './verify.js'

/** Shared test setup. Keys are generated for each run and never leave memory. */

export const newKey = () => privateKeyToAccount(generatePrivateKey())
export const id = (label: string): Hex => keccak256(stringToHex(label))

export const CHAIN_ID = 42431
export const START = 1_800_000_000n
/** An hour before the window starts. */
export const NOW = START - 3600n
export const LOCK: Address = '0x00000000000000000000000000000000000010c4'
export const PAYEE: Address = '0x000000000000000000000000000000000000beef'
export const ARBITER: Address = '0x000000000000000000000000000000000000a4b1'
export const TOKEN: RailToken = {
  rail: 'tempo',
  chainId: CHAIN_ID,
  token: '0x20c0000000000000000000000000000000000001',
  currency: 'USD',
  decimals: 6,
}
export const DOMAIN = { chainId: CHAIN_ID, verifyingContract: LOCK }
export const SALT = `0x${'55'.repeat(32)}` as const
export const COMMITMENT = id('commitment-1')
export const KEY_TX = id('the transaction that authorized the agent key')

export const avow = newKey()
/** The business account's root key, the administrator's on testnet. */
export const buyer = newKey()
export const agent = newKey()
/** The supplier's account, whose root key consents to releases. */
export const supplierAccount = newKey()
/** The supplier's signing key, which accepts the reserve. */
export const supplierKey = newKey()
export const terms = testnetDemoTerms(START, ARBITER)
export const TERMS_HASH = termsHash(terms, SALT)
/**
 * What the terms make the lock enforce, written out field by field from the sections rather than
 * through `lockTerms`, so the tests check the mapping against an account of it kept apart from the
 * code. The token has 6 decimals, so its base units equal micros.
 */
export const LOCK_TERMS: LockTerms = {
  side: terms.backing.side,
  amount: terms.backing.amount,
  freeCancelBy: terms.remedies.freeCancelBy,
  acceptBy: terms.remedies.acceptBy,
  chargeDeadline: terms.remedies.chargeDeadline,
  releaseDate: terms.backing.releaseDate,
  contestWindow: terms.resolution.contestWindow,
  charges: terms.remedies.charges.map((c) => ({
    kind: c.kind,
    most: c.amount,
    earliest: c.earliest,
  })),
  day90SupplierShareBps: terms.resolution.day90SupplierShareBps,
  arbiter: terms.resolution.arbiter,
}

/**
 * Another value for each lock-enforced field a lock's record stores. It's typed over every such
 * field, so a field added to what a lock enforces fails the type check until it has a value here,
 * and then the tests that use it check that every comparison catches it.
 */
export const RECORD_CHANGES: { readonly [K in LockRecordField]: LockedBacking[K] } = (() => {
  const [late, noShow] = LOCK_TERMS.charges
  if (!late || !noShow) throw new Error('the terms have two charges')
  return {
    amount: LOCK_TERMS.amount - 1n,
    freeCancelBy: LOCK_TERMS.freeCancelBy + 1n,
    acceptBy: LOCK_TERMS.acceptBy + 1n,
    chargeDeadline: LOCK_TERMS.chargeDeadline + 1n,
    releaseDate: LOCK_TERMS.releaseDate + 1n,
    contestWindow: LOCK_TERMS.contestWindow - 1n,
    charges: [late, { ...noShow, most: noShow.most - 1n }],
    day90SupplierShareBps: LOCK_TERMS.day90SupplierShareBps - 1,
    arbiter: '0x000000000000000000000000000000000000dead',
  }
})()

export const mandate: Mandate = {
  mandateId: id('mandate-1'),
  businessId: 'biz_buyer',
  agentId: 'agt_1',
  account: buyer.address,
  agentKey: agent.address,
  actions: ['reserve'],
  currency: 'USD',
  capPerCommitment: 1_000_000_000n,
  capOpenReserves: 2_000_000_000n,
  suppliers: ['biz_supplier'],
  categories: [],
  paymentLimits: [{ token: TOKEN.token, amount: 5_000_000_000n, period: 86_400n }],
  approvalRule: { kind: 'never' },
  expiry: START + 30n * 86_400n,
  nonce: 1n,
}
export const mHash = mandateHash(mandate, DOMAIN)
/** What the supplier's signed terms agreement names. */
export const agreed = {
  commitmentId: COMMITMENT,
  termsHash: TERMS_HASH,
  category: 'compute',
  buyerBusinessId: 'biz_buyer',
  mandateHash: mHash,
}

export function authorization(change: Partial<SupplierAuthorization> = {}): SupplierAuthorization {
  return {
    commitmentId: COMMITMENT,
    termsHash: TERMS_HASH,
    salt: SALT,
    amount: LOCK_TERMS.amount,
    token: TOKEN.token,
    buyerBusinessId: 'biz_buyer',
    kybReference: 'mock-kyb-1',
    kybTestData: true,
    agentKey: agent.address,
    agentKeyAuthorizedIn: KEY_TX,
    mandateHash: mHash,
    payee: PAYEE,
    acceptBy: LOCK_TERMS.acceptBy,
    chargeDeadline: LOCK_TERMS.chargeDeadline,
    releaseDate: LOCK_TERMS.releaseDate,
    nonce: 1n,
    expiry: NOW + 300n,
    ...change,
  }
}

export const json = (value: unknown) => JSON.parse(JSON.stringify(toWire(value)))

export async function signedAuthorization(
  message = authorization(),
  opts: { signer?: ReturnType<typeof newKey>; schemaVersion?: string; chainId?: number } = {},
): Promise<Record<string, unknown> & { message: Record<string, unknown> }> {
  const signer = opts.signer ?? avow
  const signature = await signer.sign({
    hash: digestOf(supplierAuthorizationTypedData(message, DOMAIN)),
  })
  return json({
    type: 'SupplierAuthorization',
    schemaVersion: opts.schemaVersion ?? '1',
    chainId: opts.chainId ?? CHAIN_ID,
    lock: LOCK,
    message,
    signature,
  })
}

/** The buyer's administrator signs as the business account, in Tempo's keychain envelope. */
export async function signedMandate(m: Mandate, key = buyer): Promise<unknown> {
  const signature = await signForAccount(buyer.address, digestOf(mandateTypedData(m, DOMAIN)), key)
  return json({
    type: 'Mandate',
    schemaVersion: '1',
    chainId: CHAIN_ID,
    lock: LOCK,
    message: m,
    signature,
  })
}

/** Avow's approval for the commitment, built from the terms and the mandate as the API builds it. */
export function approval(change: Partial<Approval> = {}): Approval {
  return {
    commitmentId: COMMITMENT,
    token: TOKEN.token,
    ...LOCK_TERMS,
    supplier: supplierAccount.address,
    supplierSigner: supplierKey.address,
    payee: PAYEE,
    termsHash: TERMS_HASH,
    mandateHash: mHash,
    capPerCommitment: mandate.capPerCommitment,
    capOpenReserves: mandate.capOpenReserves,
    fundingKey: agent.address,
    nonce: 1n,
    expiry: NOW + 120n,
    ...change,
  }
}

/** The approval as the reserve carried it, with Avow's signature, as JSON. */
export async function signedApproval(a: Approval = approval()): Promise<Record<string, unknown>> {
  const signature = await avow.sign({ hash: digestOf(approvalTypedData(a, DOMAIN)) })
  return json({
    type: 'Approval',
    schemaVersion: '1',
    chainId: CHAIN_ID,
    lock: LOCK,
    message: a,
    signature,
  })
}

/** What the lock stores once the agent's key reserves under the approval. */
export function lockedBacking(
  change: Partial<LockedBacking> = {},
  a: Approval = approval(),
): LockedBacking {
  return {
    state: 'reserved',
    token: a.token,
    amount: a.amount,
    held: a.amount,
    payee: a.payee,
    supplier: a.supplier,
    supplierSigner: a.supplierSigner,
    freeCancelBy: a.freeCancelBy,
    acceptBy: a.acceptBy,
    chargeDeadline: a.chargeDeadline,
    contestWindow: a.contestWindow,
    releaseDate: a.releaseDate,
    charges: a.charges,
    day90SupplierShareBps: a.day90SupplierShareBps,
    arbiter: a.arbiter,
    termsHash: a.termsHash,
    mandateHash: a.mandateHash,
    approvalHash: approvalDigest(a, DOMAIN),
    fundingKey: a.fundingKey,
    reportCount: 0,
    hasReport: false,
    hasRuling: false,
    ...change,
  }
}

export function lockInfo(change: Partial<LockInfo> = {}): LockInfo {
  return {
    fromFactory: true,
    account: buyer.address,
    token: TOKEN.token,
    timing: TESTNET_DEMO_PROFILE.lockTiming,
    ...change,
  }
}

export const config: VerifierConfig = {
  chainId: CHAIN_ID,
  avowKeys: [avow.address],
  businessId: 'biz_supplier',
  payee: PAYEE,
  acceptedTokens: [TOKEN],
  profile: TESTNET_DEMO_PROFILE,
  acceptTestData: true,
}

export const acceptanceConfig: AcceptanceConfig = {
  ...config,
  account: supplierAccount.address,
  signingKey: supplierKey.address,
}

/** A chain holding the lock, the reserve and the agent key, as they stand once the reserve lands. */
export function reservedChain(): MemoryChain {
  const chain = new MemoryChain(CHAIN_ID)
  chain.setLock(LOCK, lockInfo())
  chain.setBacking(LOCK, COMMITMENT, 'buyer', lockedBacking())
  chain.setAgentKey(
    buyer.address,
    agent.address,
    { active: true, expiry: null, witness: mHash },
    KEY_TX,
  )
  return chain
}

/**
 * A booking another booking relies on. The supplier, a reseller, booked 8 H100s for an hour from a
 * GPU cloud, as the buyer in its own lock, and sells the buyer capacity out of it. The lock's public
 * view of that booking shows its reserve and charge caps to anyone, so the rate the supplier pays is
 * the one price that stays hidden.
 */
export const FACTORY: Address = '0x00000000000000000000000000000000000fac01'
export const OTHER_FACTORY: Address = '0x00000000000000000000000000000000000fac02'
/** The GPU cloud's account, which supplies the upstream booking. */
export const gpuCloud = newKey()
/** The supplier's own lock, which holds what it booked from the GPU cloud. */
export const SUPPLIER_LOCK: Address = '0x00000000000000000000000000000000000010c6'
export const UPSTREAM_COMMITMENT = id('the supplier books the GPU cloud')
export const upstreamTerms = gpuReservationTerms({
  resource: { gpu: 'H100', count: 8, region: 'demo', sku: 'cloud-h100x8' },
  currency: 'USD',
  windowStart: START,
  windowDuration: 3600n,
  pricePerGpuHour: 2_170_000n,
  freeCancelBy: START - 600n,
  lateCancellation: dollars(123),
  noShow: dollars(321),
  gracePeriod: 120n,
  chargeDeadline: START + 3600n,
  contestWindow: 600n,
  releaseDate: START + 3600n,
  arbiter: ARBITER,
  day90SupplierShareBps: 5000,
})
export const UPSTREAM_SALT = `0x${'77'.repeat(32)}` as const
export const UPSTREAM_HASH = termsHash(upstreamTerms, UPSTREAM_SALT)
/** The upstream rate in micros, as JSON writes it, which the lock never stores. */
export const UPSTREAM_RATE = '2170000'
/** The upstream subject as the supplier shows it to the buyer, as JSON. */
export const shownUpstream = json(discloseSection(upstreamTerms, UPSTREAM_SALT, 'subject'))

/**
 * A dependency on the upstream booking, on the buyer side of the supplier's own lock. A change can
 * make one the types forbid, such as the supplier side, for the checks that refuse it anyway.
 */
export function dependencyOn(change: Partial<CommitmentReference> = {}): Dependency {
  return {
    on: {
      kind: 'commitment',
      chainId: CHAIN_ID,
      lock: SUPPLIER_LOCK,
      commitmentId: UPSTREAM_COMMITMENT,
      side: 'buyer',
      termsHash: UPSTREAM_HASH,
      ...change,
    } as Dependency['on'],
    condition: 'accepted',
    disclosed: 'subject',
  }
}

/** The block the scripted chain pins by default. */
export const PINNED: PinnedBlock = { number: 4321n, hash: id('block 4321') }

export interface ScriptedLock {
  /** Whether the reader's factory lists the lock. */
  listed: boolean
  /** The factory the lock's own field names. */
  factory: Address
  account: Address
  /** Records by `commitmentId:side`. */
  records: Record<string, DependencyRecord>
}

export const recordKey = (commitmentId: Hex, side: Side) => `${commitmentId.toLowerCase()}:${side}`

/** The supplier's lock as it stands once the GPU cloud accepted the upstream booking it supplies. */
export function supplierLock(record: Partial<DependencyRecord> | null = {}): ScriptedLock {
  return {
    listed: true,
    factory: FACTORY,
    account: supplierAccount.address,
    records: record
      ? {
          [recordKey(UPSTREAM_COMMITMENT, 'buyer')]: {
            state: 'accepted',
            hasReport: false,
            termsHash: UPSTREAM_HASH,
            supplier: gpuCloud.address,
            ...record,
          },
        }
      : {},
  }
}

export type ReaderCall = keyof Omit<PinnedLockReader, 'chainId' | 'factory'>

export interface LockScript {
  chainId?: number
  factory?: Address
  head?: PinnedBlock
  /**
   * The blocks `head` gives in turn, as a chain that moves on between reads, the last one from
   * then on. `[head]` by default.
   */
  heads?: PinnedBlock[]
  /** Locks by address. The supplier's lock with an accepted upstream booking by default. */
  locks?: Record<string, ScriptedLock>
  /** What `blockHash` gives for the pinned height, the pinned hash by default. */
  rehash?: Hex | null
  /** A call that throws, as a node that errors. */
  fails?: ReaderCall
  /** A call that never answers. */
  hangs?: ReaderCall
}

/**
 * A pinned lock reader the tests script. It records every call with the block it named, so a test
 * can see that every read was pinned to the same block.
 */
export function scriptedLocks(script: LockScript = {}): {
  reader: PinnedLockReader
  calls: { call: ReaderCall; at: bigint }[]
} {
  const heads = script.heads ?? [script.head ?? PINNED]
  let given = 0
  const locks = new Map(
    Object.entries(script.locks ?? { [SUPPLIER_LOCK]: supplierLock() }).map(([a, l]) => [
      a.toLowerCase(),
      l,
    ]),
  )
  const calls: { call: ReaderCall; at: bigint }[] = []
  const answer = async <T>(call: ReaderCall, at: bigint, value: () => T): Promise<T> => {
    calls.push({ call, at })
    if (script.fails === call) throw new Error('HTTP request failed. 502 Bad Gateway')
    if (script.hangs === call) return new Promise<T>(() => {})
    return value()
  }
  const lockAt = (lock: Address) => {
    const found = locks.get(lock.toLowerCase())
    if (!found) throw new Error(`No contract at ${lock}`)
    return found
  }
  const reader: PinnedLockReader = {
    chainId: script.chainId ?? CHAIN_ID,
    factory: script.factory ?? FACTORY,
    head: () => {
      const head = heads[Math.min(given++, heads.length - 1)] ?? PINNED
      return answer('head', head.number, () => head)
    },
    blockHash: (n) =>
      answer('blockHash', n, () => {
        const at = heads.find((h) => h.number === n)
        if (!at) return null
        return script.rehash === undefined ? at.hash : script.rehash
      }),
    isLock: (lock, at) =>
      answer('isLock', at, () => locks.get(lock.toLowerCase())?.listed ?? false),
    lockFields: (lock, at) =>
      answer('lockFields', at, () => {
        const { factory, account } = lockAt(lock)
        return { factory, account }
      }),
    commitment: (lock, commitmentId, side, at) =>
      answer('commitment', at, () => lockAt(lock).records[recordKey(commitmentId, side)] ?? null),
  }
  return { reader, calls }
}
