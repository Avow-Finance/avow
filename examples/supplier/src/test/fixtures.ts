import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  type TermsAgreement,
  termsHash,
  testnetDemoTerms,
} from '@avow-finance/spec'
import { type AcceptanceConfig, MemoryChain } from '@avow-finance/verifier'
import { type Address, type Hex, keccak256, stringToHex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { type Booking, SupplierStore } from '../store.js'

/** One booking's worth of parties, terms and signed messages. Every key lives only in memory. */

const newKey = () => privateKeyToAccount(generatePrivateKey())
const id = (label: string): Hex => keccak256(stringToHex(label))

export const CHAIN_ID = 42431
export const START = 1_800_000_000n
/** An hour before the window starts, well before the acceptance deadline. */
export const NOW = START - 3600n
export const LOCK: Address = '0x00000000000000000000000000000000000010c4'
export const ARBITER: Address = '0x000000000000000000000000000000000000a4b1'
export const TOKEN: RailToken = {
  rail: 'tempo',
  chainId: CHAIN_ID,
  token: '0x20c0000000000000000000000000000000000001',
  currency: 'USD',
  decimals: 6,
}
export const DOMAIN = { chainId: CHAIN_ID, verifyingContract: LOCK }
export const SALT: Hex = `0x${'55'.repeat(32)}`
export const COMMITMENT = id('commitment-1')
const KEY_TX = id('the transaction that authorized the agent key')

export const avow = newKey()
export const buyer = newKey()
export const agent = newKey()
export const supplierAccount = newKey()
export const supplierKey = newKey()
export const terms = testnetDemoTerms(START, ARBITER)
const TERMS_HASH = termsHash(terms, SALT)

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
const mHash = mandateHash(mandate, DOMAIN)

export const agreement: TermsAgreement = {
  commitmentId: COMMITMENT,
  termsHash: TERMS_HASH,
  category: 'compute',
  buyerBusinessId: 'biz_buyer',
  supplierBusinessId: 'biz_supplier',
  mandateHash: mHash,
  nonce: 9n,
  expiry: NOW + 600n,
}

const LOCK_TERMS = lockTerms(terms, TOKEN.decimals)

export const approval: Approval = {
  commitmentId: COMMITMENT,
  token: TOKEN.token,
  ...LOCK_TERMS,
  supplier: supplierAccount.address,
  supplierSigner: supplierKey.address,
  payee: supplierAccount.address,
  termsHash: TERMS_HASH,
  mandateHash: mHash,
  capPerCommitment: mandate.capPerCommitment,
  capOpenReserves: mandate.capOpenReserves,
  fundingKey: agent.address,
  nonce: 1n,
  expiry: NOW + 120n,
}

const authorization = (nonce: bigint): SupplierAuthorization => ({
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
  payee: supplierAccount.address,
  acceptBy: LOCK_TERMS.acceptBy,
  chargeDeadline: LOCK_TERMS.chargeDeadline,
  releaseDate: LOCK_TERMS.releaseDate,
  nonce,
  expiry: NOW + 300n,
})

const envelope = <T>(type: string, message: T, signature: Hex) => ({
  type,
  schemaVersion: '1',
  chainId: CHAIN_ID,
  lock: LOCK,
  message,
  signature,
})

/** What Avow answers a supplier that asks for an authorization, signed afresh with each nonce. */
export async function authorized(nonce = 1n) {
  const message = authorization(nonce)
  return {
    ok: true as const,
    authorization: envelope(
      'SupplierAuthorization',
      message,
      await avow.sign({ hash: digestOf(supplierAuthorizationTypedData(message, DOMAIN)) }),
    ),
    approval: envelope(
      'Approval',
      approval,
      await avow.sign({ hash: digestOf(approvalTypedData(approval, DOMAIN)) }),
    ),
    mandate: envelope(
      'Mandate',
      mandate,
      await signForAccount(buyer.address, digestOf(mandateTypedData(mandate, DOMAIN)), buyer),
    ),
  } as never
}

/** A chain holding the lock, the funded reserve and the agent's key, as the verifier reads it. */
export function reservedChain(): MemoryChain {
  const chain = new MemoryChain(CHAIN_ID)
  chain.setLock(LOCK, {
    fromFactory: true,
    account: buyer.address,
    token: TOKEN.token,
    timing: TESTNET_DEMO_PROFILE.lockTiming,
  })
  chain.setBacking(LOCK, COMMITMENT, 'buyer', {
    state: 'reserved',
    token: approval.token,
    amount: approval.amount,
    held: approval.amount,
    payee: approval.payee,
    supplier: approval.supplier,
    supplierSigner: approval.supplierSigner,
    freeCancelBy: approval.freeCancelBy,
    acceptBy: approval.acceptBy,
    chargeDeadline: approval.chargeDeadline,
    contestWindow: approval.contestWindow,
    releaseDate: approval.releaseDate,
    charges: approval.charges,
    day90SupplierShareBps: approval.day90SupplierShareBps,
    arbiter: approval.arbiter,
    termsHash: approval.termsHash,
    mandateHash: approval.mandateHash,
    approvalHash: approvalDigest(approval, DOMAIN),
    fundingKey: approval.fundingKey,
    reportCount: 0,
    hasRuling: false,
  })
  chain.setAgentKey(
    buyer.address,
    agent.address,
    { active: true, expiry: null, witness: mHash },
    KEY_TX,
  )
  return chain
}

export const acceptanceConfig: AcceptanceConfig = {
  chainId: CHAIN_ID,
  avowKeys: [avow.address],
  businessId: 'biz_supplier',
  payee: supplierAccount.address,
  acceptedTokens: [TOKEN],
  profile: TESTNET_DEMO_PROFILE,
  acceptTestData: true,
  account: supplierAccount.address,
  signingKey: supplierKey.address,
}

/** A state directory of its own for one test, removed by the returned function. */
export function tempStore(): { store: SupplierStore; remove: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'avow-supplier-'))
  return { store: new SupplierStore(dir), remove: () => rmSync(dir, { recursive: true }) }
}

/** The booking the supplier records once it signs the agreement. */
export function agreedBooking(): Booking {
  return {
    commitmentId: COMMITMENT,
    chainId: CHAIN_ID,
    lock: LOCK,
    agreement,
    terms,
    salt: SALT,
    signature: '0x00',
    status: 'agreed',
  }
}
