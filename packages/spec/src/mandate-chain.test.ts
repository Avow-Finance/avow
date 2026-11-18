import { describe, expect, it } from 'vitest'
import { mandateHash, mandateVersion, type Signed } from './eip712.js'
import {
  type AgentMandates,
  MAX_MANDATE_CHAIN,
  mandateChainProblem,
  parseAgentMandates,
} from './mandate-chain.js'
import type { MandateProof } from './mandate-proof.js'
import { CHAIN_ID, DOMAIN, demoMandate, id, LOCK, newKey } from './test-helpers.js'
import type { Mandate } from './types.js'
import { toWire } from './wire.js'

const account = newKey().address
const agentKey = newKey().address
const signed = (message: Mandate): Signed<Mandate> => ({
  type: 'Mandate',
  schemaVersion: mandateVersion(message),
  chainId: CHAIN_ID,
  lock: LOCK,
  message,
  signature: `0x${'11'.repeat(65)}`,
})
/** The next mandate in a chain, replacing `before` with a higher open-reserves cap. */
const after = (before: Mandate): Mandate => ({
  ...before,
  capOpenReserves: before.capOpenReserves + 1_000_000n,
  nonce: before.nonce + 1n,
  replaces: mandateHash(before, DOMAIN),
})

const first = demoMandate(account, agentKey)
const second = after(first)
const third = after(second)
const witness = mandateHash(first, DOMAIN)
const expected = { domain: DOMAIN, agentKey, witness }
const chain = (current: Mandate, ...earlier: Mandate[]): AgentMandates => ({
  current: signed(current),
  earlier: earlier.map(signed),
})

describe("an agent's chain of mandates", () => {
  it('links back to the mandate the key was put on with, newest first', () => {
    expect(mandateChainProblem(chain(third, second, first), expected)).toEqual({
      ok: true,
      value: {
        current: { proof: signed(third), hash: mandateHash(third, DOMAIN) },
        earlier: [mandateHash(second, DOMAIN), witness],
      },
    })
  })

  it('is just the first mandate for an agent never given another, signed or shown by its key', () => {
    expect(mandateChainProblem(chain(first), expected)).toMatchObject({
      ok: true,
      value: { earlier: [] },
    })
    const { signature: _, message, ...envelope } = signed(first)
    const { replaces: __, ...firstOnly } = message
    const authorized: MandateProof = {
      ...envelope,
      message: firstOnly,
      authorizedIn: id('key transaction'),
    }
    expect(mandateChainProblem({ current: authorized, earlier: [] }, expected).ok).toBe(true)
  })

  it('refuses a chain with a mandate left out, slipped in, or out of order', () => {
    const refused = { ok: false, reason: 'mandate.replaces_mismatch' }
    expect(mandateChainProblem(chain(third, first), expected)).toEqual(refused)
    expect(mandateChainProblem(chain(second, third, first), expected)).toEqual(refused)
    const stray = { ...after(first), nonce: 99n }
    expect(mandateChainProblem(chain(third, second, stray, first), expected)).toEqual(refused)
  })

  it("refuses a chain that doesn't start at the key's witness", () => {
    expect(mandateChainProblem(chain(third, second), expected)).toEqual({
      ok: false,
      reason: 'mandate.replaces_mismatch',
    })
    expect(
      mandateChainProblem(chain(second, first), { ...expected, witness: id('another mandate') }),
    ).toEqual({ ok: false, reason: 'chain.mandate_mismatch' })
  })

  it('refuses a chain for another key, or one that mixes agents or businesses', () => {
    expect(
      mandateChainProblem(chain(second, first), { ...expected, agentKey: newKey().address }),
    ).toEqual({ ok: false, reason: 'agent.key_mismatch' })
    const otherAgent = { ...first, agentId: 'another-agent' }
    expect(
      mandateChainProblem(chain(after(otherAgent), otherAgent), {
        ...expected,
        witness: mandateHash(otherAgent, DOMAIN),
      }).ok,
    ).toBe(true)
    expect(mandateChainProblem(chain({ ...second, businessId: 'other' }, first), expected)).toEqual(
      {
        ok: false,
        reason: 'message.invalid',
      },
    )
  })

  it('parses the chain as Avow serves it, and refuses one too long or with a bad mandate', () => {
    const wire = (c: AgentMandates) => JSON.parse(JSON.stringify(toWire(c)))
    const read = parseAgentMandates(wire(chain(third, second, first)), {
      chainId: CHAIN_ID,
      lock: LOCK,
    })
    expect(read.ok && mandateChainProblem(read.value, expected).ok).toBe(true)
    const long = wire({
      current: signed(first),
      earlier: Array(MAX_MANDATE_CHAIN).fill(signed(first)),
    })
    expect(parseAgentMandates(long, { chainId: CHAIN_ID, lock: LOCK })).toEqual({
      ok: false,
      reason: 'message.invalid',
    })
    const bad = wire(chain(second, first))
    bad.earlier[0].schemaVersion = '2'
    expect(parseAgentMandates(bad, { chainId: CHAIN_ID, lock: LOCK })).toEqual({
      ok: false,
      reason: 'message.invalid',
    })
    expect(
      parseAgentMandates({ current: wire(chain(first)).current }, { chainId: CHAIN_ID, lock: LOCK })
        .ok,
    ).toBe(false)
  })
})
