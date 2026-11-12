import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import { pairingCode, parseAgentRequest, parseAgentRequestStatus } from './agent-connect.js'
import { API_PATH_PATTERN } from './api-request.js'
import { SANDBOX_PATHS } from './sandbox.js'

const KEY = '0x00000000000000000000000000000000000000AA'

describe('an agent request', () => {
  it('is named by the agent key, in paths the API accepts', () => {
    const key = privateKeyToAccount(generatePrivateKey()).address
    for (const path of [SANDBOX_PATHS.agentRequests, SANDBOX_PATHS.agentApproval(key)]) {
      expect(path).toMatch(API_PATH_PATTERN)
    }
    expect(SANDBOX_PATHS.agentApproval(KEY)).toBe(
      '/v1/sandbox/agent-requests/0x00000000000000000000000000000000000000aa/approval',
    )
    expect(SANDBOX_PATHS.supplier('sandbox-ab')).toBe('/v1/sandbox/suppliers/sandbox-ab')
    expect(() => SANDBOX_PATHS.supplier('../x')).toThrow()
  })

  it('takes a business and a printable name, and nothing else', () => {
    expect(parseAgentRequest({ businessId: 'sandbox-ab', label: '  Research agent ' })).toEqual({
      businessId: 'sandbox-ab',
      label: 'Research agent',
    })
    expect(parseAgentRequest({ businessId: 'sandbox-ab', label: '' })).toBeNull()
    expect(parseAgentRequest({ businessId: 'sandbox-ab', label: 'x'.repeat(61) })).toBeNull()
    expect(parseAgentRequest({ businessId: 'sandbox-ab', label: 'bad\u0007name' })).toBeNull()
    expect(parseAgentRequest({ businessId: 'sandbox-ab', label: 'a', limits: 1 })).toBeNull()
    // An agent that sells names the signing key it made.
    expect(
      parseAgentRequest({ businessId: 'sandbox-ab', label: 'Seller', signingKey: KEY })?.signingKey,
    ).toBe(KEY.toLowerCase())
  })

  it('carries an approval only once it is approved', () => {
    const base = {
      businessId: 'sandbox-ab',
      agentKey: KEY,
      lock: '0x00000000000000000000000000000000000000b2',
      label: 'Research agent',
      pairingCode: pairingCode(KEY),
      requestedAt: '1800000000',
      expiresAt: '1800003600',
      signingKey: null,
    }
    expect(parseAgentRequestStatus({ ...base, state: 'pending' })?.state).toBe('pending')
    const approval = { mandate: { type: 'Mandate' }, keyAuthorizedIn: `0x${'ab'.repeat(32)}` }
    const approved = { ...base, state: 'approved', approval, supplierRegistration: null }
    expect(parseAgentRequestStatus(approved)?.state).toBe('approved')
    expect(parseAgentRequestStatus({ ...base, state: 'approved' })).toBeNull()
    expect(parseAgentRequestStatus({ ...base, state: 'pending', approval })).toBeNull()
  })
})

describe('the pairing code', () => {
  it('is eight characters a person can read back, the same for a key however it is written', () => {
    const code = pairingCode(KEY)
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/)
    expect(pairingCode(KEY.toLowerCase() as `0x${string}`)).toBe(code)
    expect(pairingCode(KEY)).toBe(code)
  })

  it('differs between keys', () => {
    const codes = new Set(
      Array.from({ length: 200 }, () =>
        pairingCode(privateKeyToAccount(generatePrivateKey()).address),
      ),
    )
    expect(codes.size).toBe(200)
  })
})
