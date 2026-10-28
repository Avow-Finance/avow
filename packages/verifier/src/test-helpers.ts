import {
  type Approval,
  approvalDigest,
  approvalTypedData,
  digestOf,
  lockTerms,
  type Mandate,
  mandateHash,
  mandateTypedData,
  type RailToken,
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
/** What the terms make the lock enforce, as Avow's API maps them. */
export const LOCK_TERMS = lockTerms(terms, TOKEN.decimals)

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
    side: 'buyer',
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
