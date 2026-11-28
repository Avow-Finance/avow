import { describe, expect, it } from 'vitest'
import { fromAp2IntentMandate, toAp2IntentMandate } from './ap2.js'
import { dollars } from './demo.js'
import {
  MANDATE_PRICE_TYPES,
  MANDATE_TYPES,
  mandateHash,
  mandateTypedData,
  mandateVersion,
} from './eip712.js'
import { checkMandate, type MandateCheckInput, validateMandate } from './mandate.js'
import { parseMandateProof } from './mandate-proof.js'
import { TESTNET_DEMO_PROFILE } from './profiles.js'
import {
  CHAIN_ID,
  DOMAIN,
  demoMandate,
  demoRequest,
  id,
  LOCK,
  NOW,
  newKey,
  TOKEN,
} from './test-helpers.js'
import type { Mandate } from './types.js'
import { MANDATE_PRICE_VERSION } from './version.js'
import { toWire } from './wire.js'

const agent = newKey()
const plain = demoMandate(newKey().address, agent.address)
// The demo request books eight H100s for half an hour at $3 a GPU-hour, a price of $12.
const priced: Mandate = { ...plain, priceCapPerCommitment: dollars(12) }
const pricedReplacement: Mandate = {
  ...priced,
  priceCapPerCommitment: dollars(20),
  nonce: priced.nonce + 1n,
  replaces: mandateHash(priced, DOMAIN),
}
const expected = { chainId: CHAIN_ID, lock: LOCK }
const envelope = (
  message: Mandate,
  proof: Record<string, unknown>,
  version = mandateVersion(message),
) =>
  JSON.parse(
    JSON.stringify(
      toWire({
        type: 'Mandate',
        schemaVersion: version,
        chainId: CHAIN_ID,
        lock: LOCK,
        message,
        ...proof,
      }),
    ),
  )
const SIGNED = { signature: `0x${'11'.repeat(65)}` }
const AUTHORIZED = { authorizedIn: id('key transaction') }
const ZERO = `0x${'00'.repeat(32)}` as const

function input(mandate: Mandate, rest: Partial<MandateCheckInput> = {}): MandateCheckInput {
  return {
    mandate,
    request: demoRequest(agent.address),
    token: TOKEN,
    openReserves: 0n,
    revoked: false,
    now: NOW,
    profile: TESTNET_DEMO_PROFILE,
    ...rest,
  }
}

describe('a mandate with a price limit', () => {
  it('signs at version 3, first or replacement, with the limit and then what it replaces', () => {
    expect(mandateVersion(priced)).toBe(MANDATE_PRICE_VERSION)
    expect(mandateVersion(pricedReplacement)).toBe(MANDATE_PRICE_VERSION)
    expect(MANDATE_PRICE_TYPES.Mandate.slice(0, -2)).toEqual(MANDATE_TYPES.Mandate)
    expect(MANDATE_PRICE_TYPES.Mandate.slice(-2)).toEqual([
      { name: 'priceCapPerCommitment', type: 'uint256' },
      { name: 'replaces', type: 'bytes32' },
    ])
    const first = mandateTypedData(priced, DOMAIN)
    expect(first.domain.version).toBe('3')
    expect(first.types).toBe(MANDATE_PRICE_TYPES)
    expect(first.message).toMatchObject({ priceCapPerCommitment: dollars(12), replaces: ZERO })
    const later = mandateTypedData(pricedReplacement, DOMAIN)
    expect(later.message).toMatchObject({ replaces: pricedReplacement.replaces })
  })

  it('hashes apart from the same mandate with no limit or another limit', () => {
    const hash = mandateHash(priced, DOMAIN)
    expect(hash).not.toBe(mandateHash(plain, DOMAIN))
    expect(hash).not.toBe(mandateHash({ ...priced, priceCapPerCommitment: dollars(13) }, DOMAIN))
    expect(mandateHash(pricedReplacement, DOMAIN)).not.toBe(
      mandateHash({ ...pricedReplacement, replaces: id('another mandate') }, DOMAIN),
    )
  })

  it('keeps its hash, so a key carrying it keeps checking', () => {
    const golden: Mandate = {
      mandateId: `0x${'0a'.repeat(32)}`,
      businessId: 'biz_golden',
      agentId: 'agent-golden',
      account: '0x00000000000000000000000000000000000000a1',
      agentKey: '0x00000000000000000000000000000000000000b2',
      actions: ['reserve', 'start', 'cancel'],
      currency: 'USD',
      capPerCommitment: 50_000_000n,
      capOpenReserves: 200_000_000n,
      priceCapPerCommitment: 200_000_000n,
      suppliers: ['biz_supplier'],
      categories: ['compute'],
      paymentLimits: [
        {
          token: '0x20C0000000000000000000000000000000000001',
          amount: 100_000_000n,
          period: 86400n,
        },
      ],
      approvalRule: { kind: 'never' },
      expiry: 1_900_000_000n,
      nonce: 1n,
    }
    expect(mandateHash(golden, DOMAIN)).toBe(
      '0x16c6b56c82ad0194e1310221676d2e27927f2277c8993f06c04d4f6d95c7f6e9',
    )
  })

  it('keeps the hash of a replacement at version 2 and at version 3', () => {
    const first: Mandate = {
      mandateId: `0x${'0a'.repeat(32)}`,
      businessId: 'biz_golden',
      agentId: 'agent-golden',
      account: '0x00000000000000000000000000000000000000a1',
      agentKey: '0x00000000000000000000000000000000000000b2',
      actions: ['reserve', 'start', 'cancel'],
      currency: 'USD',
      capPerCommitment: 50_000_000n,
      capOpenReserves: 200_000_000n,
      suppliers: ['biz_supplier'],
      categories: ['compute'],
      paymentLimits: [
        {
          token: '0x20C0000000000000000000000000000000000001',
          amount: 100_000_000n,
          period: 86400n,
        },
      ],
      approvalRule: { kind: 'never' },
      expiry: 1_900_000_000n,
      nonce: 1n,
    }
    const replaces = `0x${'0b'.repeat(32)}` as const
    const v2: Mandate = { ...first, nonce: 2n, replaces }
    const v3: Mandate = { ...v2, priceCapPerCommitment: 200_000_000n }
    expect(mandateVersion(v2)).toBe('2')
    expect(mandateVersion(v3)).toBe('3')
    // The version 2 hash is the one the code gave before price limits existed.
    expect(mandateHash(v2, DOMAIN)).toBe(
      '0x90feb88d1b283ba71fa1fdfb0459813e6a368a786a5bd495256c48656b0500d9',
    )
    expect(mandateHash(v3, DOMAIN)).toBe(
      '0xfa62676de840976adc81d99dce241f1a24de068219d387d5984356a64881013d',
    )
  })

  it('refuses a replacement that names the zero hash, which would sign as a first mandate', () => {
    expect(() => mandateTypedData({ ...priced, replaces: ZERO }, DOMAIN)).toThrow(RangeError)
    expect(
      parseMandateProof(envelope({ ...priced, replaces: ZERO }, SIGNED, '3'), expected),
    ).toEqual({ ok: false, reason: 'message.invalid' })
  })

  it('reads signed at version 3, and a first one shown by the transaction that put its key on', () => {
    const signed = parseMandateProof(envelope(priced, SIGNED), expected)
    expect(signed.ok && signed.value.message.priceCapPerCommitment).toBe(dollars(12))
    const authorized = parseMandateProof(envelope(priced, AUTHORIZED), expected)
    expect(authorized.ok && authorized.value.message.priceCapPerCommitment).toBe(dollars(12))
    expect(parseMandateProof(envelope(pricedReplacement, SIGNED), expected).ok).toBe(true)
  })

  it('refuses an envelope at another version than its message signs at, and a replacement shown by a transaction', () => {
    for (const version of ['1', '2']) {
      expect(parseMandateProof(envelope(priced, SIGNED, version), expected)).toEqual({
        ok: false,
        reason: 'message.invalid',
      })
      expect(parseMandateProof(envelope(priced, AUTHORIZED, version), expected)).toEqual({
        ok: false,
        reason: 'message.invalid',
      })
    }
    expect(parseMandateProof(envelope(pricedReplacement, AUTHORIZED), expected)).toEqual({
      ok: false,
      reason: 'message.invalid',
    })
  })

  it('reads a mandate at version 1 or 2 as one with no limit on the price', () => {
    const read = parseMandateProof(envelope(plain, SIGNED), expected)
    expect(read.ok && 'priceCapPerCommitment' in read.value.message).toBe(false)
    expect(mandateVersion(plain)).toBe('1')
  })

  it('is malformed with a limit of nothing', () => {
    expect(validateMandate({ ...priced, priceCapPerCommitment: 0n })).toBe('mandate.invalid')
    expect(validateMandate(priced)).toBeNull()
  })

  it('carries the limit through AP2 and back', () => {
    const pair = toAp2IntentMandate(priced, 'GPU time')
    if (!pair.ok) throw new Error(pair.reason)
    expect(pair.value.avow.price_cap_per_commitment).toBe('12000000')
    const back = fromAp2IntentMandate(JSON.parse(JSON.stringify(pair.value)))
    expect(back.ok && back.value.priceCapPerCommitment).toBe(dollars(12))
    const none = toAp2IntentMandate(plain, 'GPU time')
    expect(none.ok && 'price_cap_per_commitment' in none.value.avow).toBe(false)
  })
})

describe('checkMandate with a price limit', () => {
  it('approves a commitment priced at the limit', () => {
    expect(checkMandate(input({ ...priced, approvalRule: { kind: 'never' } }))).toEqual({
      result: 'approved',
      reason: 'approved',
    })
  })

  it('refuses one priced above it, whatever its reserve', () => {
    const tight = { ...priced, priceCapPerCommitment: dollars(12) - 1n }
    expect(checkMandate(input(tight))).toEqual({
      result: 'denied',
      reason: 'mandate.over_price_limit',
    })
  })

  it('puts no limit on the price when the mandate has none', () => {
    expect(checkMandate(input({ ...plain, approvalRule: { kind: 'never' } }))).toEqual({
      result: 'approved',
      reason: 'approved',
    })
  })

  it('refuses a reserve over its cap before it reads the price', () => {
    const both = { ...priced, priceCapPerCommitment: 1n, capPerCommitment: dollars(1) }
    expect(checkMandate(input(both))).toEqual({
      result: 'denied',
      reason: 'mandate.over_commitment_cap',
    })
  })
})
