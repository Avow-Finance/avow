import { type AvowDomain, dollars, type Mandate, mandateHash } from '@avow-finance/spec'
import { type Address, keccak256, stringToHex, toFunctionSelector } from 'viem'
import { describe, expect, it } from 'vitest'
import { agentKeyTerms } from './agent-key.js'

const LOCK: Address = '0x00000000000000000000000000000000000010c4'
const TOKEN: Address = '0x20c0000000000000000000000000000000000001'
const DOMAIN: AvowDomain = { chainId: 42431, verifyingContract: LOCK }
// A stand-in for the lock's reserve function, which step 2.2 defines.
const RESERVE = toFunctionSelector('reserve(bytes)')

const mandate: Mandate = {
  mandateId: keccak256(stringToHex('mandate-1')),
  businessId: 'biz_buyer',
  agentId: 'agt_1',
  account: '0x0000000000000000000000000000000000000a11',
  agentKey: '0x0000000000000000000000000000000000000a9e',
  actions: ['reserve', 'cancel'],
  currency: 'USD',
  capPerCommitment: dollars(1000),
  capOpenReserves: dollars(2000),
  suppliers: ['biz_supplier'],
  categories: [],
  paymentLimits: [{ token: TOKEN, amount: dollars(5000), period: 86_400n }],
  approvalRule: { kind: 'never' },
  expiry: 1_900_000_000n,
  nonce: 1n,
}

describe('agentKeyTerms', () => {
  it("takes the key's limit, expiry and witness from the mandate", () => {
    const terms = agentKeyTerms(mandate, DOMAIN, { lock: LOCK, lockSelectors: [RESERVE] })
    expect(terms.expiry).toBe(1_900_000_000)
    expect(terms.limits).toEqual([{ token: TOKEN, limit: dollars(5000), period: 86_400 }])
    expect(terms.witness).toBe(mandateHash(mandate, DOMAIN))
  })

  it('lets the key approve the token only to the lock and call only the listed lock functions', () => {
    const terms = agentKeyTerms(mandate, DOMAIN, { lock: LOCK, lockSelectors: [RESERVE] })
    expect(terms.scopes).toEqual([
      { address: TOKEN, selector: '0x095ea7b3', recipients: [LOCK] },
      { address: LOCK, selector: RESERVE },
    ])
  })

  it('gives a one-time limit no period', () => {
    const once = { ...mandate, paymentLimits: [{ token: TOKEN, amount: dollars(500), period: 0n }] }
    expect(agentKeyTerms(once, DOMAIN, { lock: LOCK, lockSelectors: [] }).limits).toEqual([
      { token: TOKEN, limit: dollars(500) },
    ])
  })

  it("allows no calls at all when the mandate doesn't permit reserves", () => {
    const noReserve = { ...mandate, actions: ['cancel', 'start'] as const }
    expect(
      agentKeyTerms(noReserve, DOMAIN, { lock: LOCK, lockSelectors: [RESERVE] }).scopes,
    ).toEqual([])
  })

  it('binds a different witness on another chain or lock', () => {
    const scope = { lock: LOCK, lockSelectors: [RESERVE] }
    const here = agentKeyTerms(mandate, DOMAIN, scope).witness
    expect(agentKeyTerms(mandate, { ...DOMAIN, chainId: 1 }, scope).witness).not.toBe(here)
  })
})
