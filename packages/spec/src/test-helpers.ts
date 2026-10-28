import { type Address, type Hex, keccak256, stringToHex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { dollars, testnetDemoTerms } from './demo.js'
import type { AvowDomain } from './eip712.js'
import type { RailToken } from './rail.js'
import type { Mandate, ReserveRequest } from './types.js'

/** Shared test setup. Keys are generated for each run and never leave memory. */

export const CHAIN_ID = 42431
export const START = 1_800_000_000n
/** An hour before the window starts. */
export const NOW = START - 3600n
export const LOCK: Address = '0x00000000000000000000000000000000000010c4'
export const OTHER_LOCK: Address = '0x00000000000000000000000000000000000010c5'
export const PAYEE: Address = '0x000000000000000000000000000000000000beef'
/** The fallback arbiter the test terms name. */
export const ARBITER: Address = '0x000000000000000000000000000000000000a4b1'
export const TOKEN: RailToken = {
  rail: 'tempo',
  chainId: CHAIN_ID,
  token: '0x20c0000000000000000000000000000000000001',
  currency: 'USD',
  decimals: 6,
}
export const DOMAIN: AvowDomain = { chainId: CHAIN_ID, verifyingContract: LOCK }

export function newKey() {
  return privateKeyToAccount(generatePrivateKey())
}

export function id(label: string): Hex {
  return keccak256(stringToHex(label))
}

export function demoMandate(account: Address, agentKey: Address): Mandate {
  return {
    mandateId: id('mandate-1'),
    businessId: 'biz_buyer',
    agentId: 'agt_1',
    account,
    agentKey,
    actions: ['reserve', 'cancel', 'start'],
    currency: 'USD',
    capPerCommitment: dollars(1000),
    capOpenReserves: dollars(2000),
    suppliers: ['biz_supplier'],
    categories: ['compute'],
    paymentLimits: [{ token: TOKEN.token, amount: dollars(5000), period: 86_400n }],
    approvalRule: { kind: 'above', amount: dollars(800) },
    expiry: START + 30n * 86_400n,
    nonce: 1n,
  }
}

export function demoRequest(agentKey: Address): ReserveRequest {
  return {
    commitmentId: id('commitment-1'),
    agentKey,
    supplier: 'biz_supplier',
    payee: PAYEE,
    category: 'compute',
    terms: testnetDemoTerms(START, ARBITER),
  }
}
