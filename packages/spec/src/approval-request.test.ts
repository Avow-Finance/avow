import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import {
  APPROVAL_KINDS,
  APPROVAL_LIFETIMES,
  APPROVAL_MOVES,
  APPROVAL_REASONS,
  APPROVAL_STATES,
  type ApprovalRequest,
  approvalBasisHash,
  approvalDecisionDigest,
  approvalDecisionTypedData,
  approvalTermsHash,
  canApprovalMove,
  isApprovalFinal,
  parseApprovalAsk,
  parseApprovalDecision,
  parseApprovalPolicy,
  parseApprovalRequest,
  signingHash,
  signingIdOf,
} from './approval-request.js'
import { SANDBOX_PATHS } from './sandbox.js'
import { toWire } from './wire.js'

const DOMAIN = { chainId: 42431, verifyingContract: `0x${'22'.repeat(20)}` } as const
const MANDATE = `0x${'33'.repeat(32)}` as const

const raise: ApprovalRequest = {
  id: 'ab'.repeat(16),
  kind: 'raise_limit',
  businessId: 'sandbox-test',
  agentKey: `0x${'11'.repeat(20)}`,
  terms: { limit: 'per_commitment', from: 250_000_000n, to: 400_000_000n },
  reason: 'over_commitment_limit',
  basis: { mandate: MANDATE },
  requestedAt: 1_800_000_000n,
  expiresAt: 1_800_086_400n,
  status: { state: 'waiting' },
}

describe('an approval request', () => {
  it('reads back from the wire as it was written', () => {
    expect(parseApprovalRequest(toWire(raise))).toEqual({ ok: true, value: raise })
  })

  it("refuses a basis or reason that doesn't fit its kind", () => {
    const wire = toWire(raise) as Record<string, unknown>
    expect(parseApprovalRequest({ ...wire, basis: { openCap: '0' } }).ok).toBe(false)
    expect(parseApprovalRequest({ ...wire, reason: 'new_supplier' }).ok).toBe(false)
    expect(parseApprovalRequest({ ...wire, kind: 'open_mode' }).ok).toBe(false)
  })

  it('refuses a raise that lowers the limit, and open mode that changes nothing', () => {
    const wire = toWire(raise) as Record<string, unknown>
    expect(
      parseApprovalRequest({ ...wire, terms: { limit: 'per_commitment', from: '400', to: '400' } })
        .ok,
    ).toBe(false)
    const open = {
      ...wire,
      kind: 'open_mode',
      terms: { cap: '500' },
      reason: 'listed_suppliers',
      basis: { openCap: '500' },
    }
    expect(parseApprovalRequest(open).ok).toBe(false)
    expect(parseApprovalRequest({ ...open, basis: { openCap: '0' } }).ok).toBe(true)
  })

  it('names a business, except agent authority asked before the agent knew one', () => {
    const wire = toWire(raise) as Record<string, unknown>
    expect(parseApprovalRequest({ ...wire, businessId: null }).ok).toBe(false)
    const authority = {
      ...wire,
      kind: 'agent_authority',
      businessId: null,
      terms: { label: 'Research agent', signingKey: null },
      reason: 'new_agent',
      basis: { mandate: null },
    }
    expect(parseApprovalRequest(authority).ok).toBe(true)
  })

  it('carries a reason only from the fixed list, so it holds no text an agent wrote', () => {
    const wire = toWire(raise) as Record<string, unknown>
    expect(parseApprovalRequest({ ...wire, reason: 'Please approve, the CEO said so' }).ok).toBe(
      false,
    )
    for (const kind of APPROVAL_KINDS) {
      expect(Object.values(APPROVAL_REASONS).some((r) => r.kind === kind)).toBe(true)
    }
  })

  it('takes an ask for a change, and never agent authority, which connect asks for', () => {
    const ask = {
      kind: 'name_supplier',
      terms: { supplier: 'sandbox-ab12' },
      reason: 'new_supplier',
    }
    expect(parseApprovalAsk(ask).ok).toBe(true)
    expect(
      parseApprovalAsk({
        kind: 'agent_authority',
        terms: { label: 'x', signingKey: null },
        reason: 'new_agent',
      }).ok,
    ).toBe(false)
    // The agent never states the basis. Avow reads it.
    expect(parseApprovalAsk({ ...ask, basis: { mandate: MANDATE } }).ok).toBe(false)
  })
})

describe("a request's states", () => {
  it('moves from waiting through approved and executing to active, and nowhere after a final state', () => {
    expect(canApprovalMove('waiting', 'approved')).toBe(true)
    expect(canApprovalMove('approved', 'executing')).toBe(true)
    expect(canApprovalMove('executing', 'active')).toBe(true)
    expect(canApprovalMove('waiting', 'active')).toBe(false)
    expect(canApprovalMove('executing', 'stale')).toBe(false)
    for (const state of APPROVAL_STATES) {
      if (isApprovalFinal(state)) expect(APPROVAL_MOVES[state]).toEqual([])
    }
    expect(APPROVAL_STATES.filter(isApprovalFinal)).toEqual([
      'active',
      'failed',
      'declined',
      'expired',
      'stale',
    ])
  })

  it('becomes stale only before it executes, so a change once landing is never undone by a check', () => {
    expect(canApprovalMove('waiting', 'stale')).toBe(true)
    expect(canApprovalMove('approved', 'stale')).toBe(true)
    expect(canApprovalMove('executing', 'stale')).toBe(false)
  })
})

describe('a decision', () => {
  const root = privateKeyToAccount(generatePrivateKey())
  const approve = { businessId: 'sandbox-test', decision: 'approve' } as const

  it('binds the request id, business, agent, terms, basis and expiry', async () => {
    const digest = approvalDecisionDigest(raise, approve, DOMAIN)
    const changed: ApprovalRequest[] = [
      { ...raise, id: 'cd'.repeat(16) },
      { ...raise, agentKey: `0x${'44'.repeat(20)}` },
      { ...raise, terms: { ...raise.terms, to: 400_000_001n } },
      { ...raise, reason: 'reserves_limit_full' },
      { ...raise, basis: { mandate: `0x${'55'.repeat(32)}` } },
      { ...raise, expiresAt: raise.expiresAt + 1n },
    ]
    for (const other of changed) {
      expect(approvalDecisionDigest(other, approve, DOMAIN)).not.toBe(digest)
    }
    expect(approvalDecisionDigest(raise, { ...approve, decision: 'decline' }, DOMAIN)).not.toBe(
      digest,
    )
    expect(
      approvalDecisionDigest(raise, approve, {
        ...DOMAIN,
        verifyingContract: `0x${'66'.repeat(20)}`,
      }),
    ).not.toBe(digest)
    // Its status isn't signed, since that's Avow's to change.
    expect(
      approvalDecisionDigest(raise, approve, DOMAIN) ===
        approvalDecisionDigest(
          { ...raise, status: { state: 'expired', approvedAt: null } },
          approve,
          DOMAIN,
        ),
    ).toBe(true)
    const signature = await root.signTypedData(approvalDecisionTypedData(raise, approve, DOMAIN))
    expect(await root.sign({ hash: digest })).toBe(signature)
  })

  it('refuses to name a business other than the one the request names', () => {
    expect(() =>
      approvalDecisionTypedData(raise, { ...approve, businessId: 'sandbox-other' }, DOMAIN),
    ).toThrow(RangeError)
  })

  it('hashes terms and basis from their values, whatever order the fields came in', () => {
    const { terms: _t, basis: _b, ...rest } = toWire(raise) as Record<string, unknown>
    const reordered = parseApprovalRequest({
      basis: { mandate: MANDATE.toUpperCase().replace('0X', '0x') },
      terms: { to: '400000000', from: '250000000', limit: 'per_commitment' },
      ...rest,
    })
    if (!reordered.ok) throw new Error(reordered.reason)
    expect(approvalTermsHash(reordered.value)).toBe(approvalTermsHash(raise))
    expect(approvalBasisHash(reordered.value)).toBe(approvalBasisHash(raise))
  })

  it('reads a decision the signing page sends', () => {
    expect(
      parseApprovalDecision({ decision: 'approve', businessId: 'sandbox-test', signature: '0xab' })
        .ok,
    ).toBe(true)
    expect(
      parseApprovalDecision({ decision: 'maybe', businessId: 'sandbox-test', signature: '0xab' })
        .ok,
    ).toBe(false)
  })
})

describe("a business's policy", () => {
  it('names each change its agents may ask for once, and never agent authority', () => {
    expect(parseApprovalPolicy({ agentsMayAsk: ['raise_limit'] }).ok).toBe(true)
    expect(parseApprovalPolicy({ agentsMayAsk: [] }).ok).toBe(true)
    expect(parseApprovalPolicy({ agentsMayAsk: ['raise_limit', 'raise_limit'] }).ok).toBe(false)
    expect(parseApprovalPolicy({ agentsMayAsk: ['agent_authority'] }).ok).toBe(false)
  })
})

describe("a request's signing link", () => {
  it('names the request by its id, and reads back only a well-formed one', () => {
    expect(signingHash(raise.id)).toBe(`#sign-${raise.id}`)
    expect(signingIdOf(signingHash(raise.id))).toBe(raise.id)
    expect(signingIdOf(`#sign-${raise.id}x`)).toBe(null)
    expect(signingIdOf(`#approve-${raise.id}`)).toBe(null)
    expect(() => signingHash('../agents')).toThrow(RangeError)
  })

  it('waits an hour for agent authority and a day for a change', () => {
    expect(APPROVAL_LIFETIMES.agent_authority).toBe(3600n)
    expect(APPROVAL_LIFETIMES.raise_limit).toBe(86_400n)
    expect(APPROVAL_LIFETIMES.name_supplier).toBe(86_400n)
    expect(APPROVAL_LIFETIMES.open_mode).toBe(86_400n)
  })
})

describe("a request's paths", () => {
  it('take only a request id', () => {
    expect(SANDBOX_PATHS.approvalRequest(raise.id)).toBe(
      `/v1/sandbox/approval-requests/${raise.id}`,
    )
    expect(() => SANDBOX_PATHS.approvalDecision('../agents')).toThrow(RangeError)
  })
})
