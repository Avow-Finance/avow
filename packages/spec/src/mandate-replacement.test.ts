import { describe, expect, it } from 'vitest'
import {
  MANDATE_REPLACEMENT_TYPES,
  MANDATE_TYPES,
  mandateHash,
  mandateTypedData,
  mandateVersion,
} from './eip712.js'
import { parseMandateProof } from './mandate-proof.js'
import { CHAIN_ID, DOMAIN, demoMandate, id, LOCK, newKey } from './test-helpers.js'
import type { Mandate } from './types.js'
import { MANDATE_REPLACEMENT_VERSION, MESSAGE_VERSIONS } from './version.js'
import { toWire } from './wire.js'

const first = demoMandate(newKey().address, newKey().address)
const replacement: Mandate = {
  ...first,
  capOpenReserves: first.capOpenReserves * 2n,
  nonce: first.nonce + 1n,
  replaces: mandateHash(first, DOMAIN),
}
const expected = { chainId: CHAIN_ID, lock: LOCK }
/** A mandate's envelope as it crosses the wire, at the version its message signs at unless told. */
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

describe('a mandate that replaces another', () => {
  it('leaves a first mandate signing at version 1 under the first table, byte for byte', () => {
    const td = mandateTypedData(first, DOMAIN)
    expect(td.domain.version).toBe(MESSAGE_VERSIONS.Mandate)
    expect(td.types).toBe(MANDATE_TYPES)
    expect('replaces' in td.message).toBe(false)
    // The hash version 0.6.0 gave this mandate, before replacements existed.
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
      '0x2313bebd7868703c3c9472f986c276a64cbcefd3ed2723dff7dcd3efd9e0ec90',
    )
  })

  it('signs a replacement at version 2, with the replaced hash as the last field', () => {
    const td = mandateTypedData(replacement, DOMAIN)
    expect(td.domain.version).toBe(MANDATE_REPLACEMENT_VERSION)
    expect(td.types).toBe(MANDATE_REPLACEMENT_TYPES)
    expect(MANDATE_REPLACEMENT_TYPES.Mandate.at(-1)).toEqual({ name: 'replaces', type: 'bytes32' })
    expect(MANDATE_REPLACEMENT_TYPES.Mandate.slice(0, -1)).toEqual(MANDATE_TYPES.Mandate)
    expect(mandateVersion(replacement)).toBe('2')
  })

  it('gives a replacement its own hash, which changes with what it replaces', () => {
    const { replaces: _, ...same } = replacement
    expect(mandateHash(replacement, DOMAIN)).not.toBe(mandateHash(same, DOMAIN))
    expect(mandateHash(replacement, DOMAIN)).not.toBe(
      mandateHash({ ...replacement, replaces: id('another mandate') }, DOMAIN),
    )
  })

  it('reads a signed replacement, and a first mandate as before', () => {
    const read = parseMandateProof(envelope(replacement, SIGNED), expected)
    expect(read.ok && read.value.message.replaces).toBe(replacement.replaces)
    expect(parseMandateProof(envelope(first, SIGNED), expected).ok).toBe(true)
    expect(parseMandateProof(envelope(first, AUTHORIZED), expected).ok).toBe(true)
  })

  it("refuses an envelope whose version isn't the one its message signs at", () => {
    expect(parseMandateProof(envelope(replacement, SIGNED, '1'), expected)).toEqual({
      ok: false,
      reason: 'message.invalid',
    })
    expect(parseMandateProof(envelope(first, SIGNED, '2'), expected)).toEqual({
      ok: false,
      reason: 'message.invalid',
    })
    expect(parseMandateProof(envelope(first, SIGNED, '3'), expected)).toEqual({
      ok: false,
      reason: 'message.invalid',
    })
    expect(parseMandateProof(envelope(first, SIGNED, '4'), expected)).toEqual({
      ok: false,
      reason: 'message.invalid',
    })
    expect(parseMandateProof(envelope(first, SIGNED, '5'), expected)).toEqual({
      ok: false,
      reason: 'message.schema_unknown',
    })
  })

  it("refuses a replacement shown by the key's transaction, which bound only the first mandate's hash", () => {
    expect(parseMandateProof(envelope(replacement, AUTHORIZED), expected)).toEqual({
      ok: false,
      reason: 'message.invalid',
    })
  })

  it('refuses a replaces field that is no 32-byte hash', () => {
    const bad = envelope(replacement, SIGNED)
    bad.message.replaces = '0x1234'
    expect(parseMandateProof(bad, expected)).toEqual({ ok: false, reason: 'message.invalid' })
  })
})
