import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import {
  AGENT_LABEL_MAX,
  agentLabelOf,
  approvalHash,
  approvalKeyOf,
  pairingCode,
  parseAgentRequest,
  parseAgentRequestStatus,
  parseOpenAgentRequest,
  parseOpenAgentRequestStatus,
} from './agent-connect.js'
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

  it('refuses a new label with a hidden or direction-changing character, or a double quote', () => {
    const hidden = {
      'a right-to-left override': 'Agent \u202etcennoc ot sksa',
      'a left-to-right override': 'Agent \u202dname',
      'a bidi isolate': 'Agent \u2067name\u2069',
      'a pop of direction': 'Agent name\u202c',
      'a right-to-left mark': 'Agent\u200f name',
      'an Arabic letter mark': 'Agent\u061c name',
      'a zero-width space': 'Agent\u200bname',
      'a zero-width joiner': 'Agent\u200dname',
      'a word joiner': 'Agent\u2060name',
      'a soft hyphen': 'Agent\u00adname',
      'a byte order mark': 'Agent\ufeffname',
      'an interlinear annotation mark': 'Agent\ufff9name',
      'a tag character': 'Agent\u{e0041}name',
      'a line separator': 'Agent\u2028name',
      'a line feed': 'Agent\nname',
      'a C1 control': 'Agent\u0085name',
      'a wide blank': 'Agent\u3000name',
      'a Hangul filler': 'Agent\u3164name',
      'a blank Braille cell': 'Agent\u2800name',
      'a double quote': 'Agent "approved"',
      'a curly quote': 'Agent \u201capproved\u201d',
      'a full-width quote': 'Agent \uff02approved',
      'two apostrophes': "Agent ''approved''",
      'half a character': 'Agent \ud800',
    }
    for (const [what, label] of Object.entries(hidden)) {
      expect(agentLabelOf(label), what).toBeNull()
      expect(parseAgentRequest({ businessId: 'sandbox-ab', label }), what).toBeNull()
      expect(parseOpenAgentRequest({ label }), what).toBeNull()
    }
  })

  it('takes an ordinary name in any script, trimmed, up to its most characters', () => {
    for (const label of [
      'Research agent',
      'リサーチエージェント',
      '研究代理',
      'وكيل البحث',
      'סוכן מחקר',
      'Agent de réservation Zoë',
      'Größe & Søren (v2)',
      'Агент закупок',
      '🤖 Research agent',
      "O'Brien's agent",
      'x'.repeat(AGENT_LABEL_MAX),
    ]) {
      expect(agentLabelOf(label), label).toBe(label)
      expect(parseOpenAgentRequest({ label })?.label, label).toBe(label)
    }
    expect(agentLabelOf('  Research agent ')).toBe('Research agent')
    expect(agentLabelOf('x'.repeat(AGENT_LABEL_MAX + 1))).toBeNull()
    expect(agentLabelOf('   ')).toBeNull()
  })

  it('reads back a request Avow already holds under the label it was asked under', () => {
    // A label from before the rule for new labels, which Avow may still hold and answer with.
    const held = {
      businessId: 'sandbox-ab',
      agentKey: KEY,
      lock: '0x00000000000000000000000000000000000000b2',
      label: 'Agent \u202etcennoc ot sksa "x"',
      pairingCode: pairingCode(KEY),
      requestedAt: '1800000000',
      expiresAt: '1800003600',
      signingKey: null,
    }
    expect(parseAgentRequestStatus({ ...held, state: 'pending' })?.label).toBe(held.label)
    const { businessId: _b, lock: _l, ...open } = held
    expect(parseOpenAgentRequestStatus({ ...open, state: 'open' })?.label).toBe(held.label)
    expect(
      parseAgentRequestStatus({ ...held, label: 'bad\u0007name', state: 'pending' }),
    ).toBeNull()
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

describe('the approval link', () => {
  const key = privateKeyToAccount(generatePrivateKey()).address

  it('names the request by its agent key, and reads back to the same key', () => {
    expect(approvalHash(key)).toBe(`#approve-${key.toLowerCase()}`)
    expect(approvalKeyOf(approvalHash(key))).toBe(key.toLowerCase())
  })

  it('reads nothing from a hash that names no request', () => {
    expect(approvalKeyOf('#agents')).toBeNull()
    expect(approvalKeyOf('#approve-0x1234')).toBeNull()
    expect(approvalKeyOf(`#approve-${key.toLowerCase()}&grant=1`)).toBeNull()
  })
})

describe('a request that names no business', () => {
  const key = privateKeyToAccount(generatePrivateKey()).address.toLowerCase()
  const base = {
    agentKey: key,
    label: 'Research agent',
    pairingCode: pairingCode(key as `0x${string}`),
    requestedAt: '1800000000',
    expiresAt: '1800003600',
    signingKey: null,
  }

  it('takes a name and any signing key, and refuses a business, which the approval sets', () => {
    expect(parseOpenAgentRequest({ label: 'Research agent' })).toEqual({ label: 'Research agent' })
    expect(parseOpenAgentRequest({ label: 'R', signingKey: key })).toEqual({
      label: 'R',
      signingKey: key,
    })
    expect(parseOpenAgentRequest({ label: 'R', businessId: 'sandbox-ab' })).toBeNull()
    expect(parseOpenAgentRequest({ label: '' })).toBeNull()
  })

  it('stands open or expired with no business, and names one only once bound', () => {
    expect(parseOpenAgentRequestStatus({ ...base, state: 'open' })).toMatchObject({ state: 'open' })
    expect(parseOpenAgentRequestStatus({ ...base, state: 'expired' })).not.toBeNull()
    expect(
      parseOpenAgentRequestStatus({ ...base, state: 'bound', businessId: 'sandbox-ab' }),
    ).toMatchObject({ state: 'bound', businessId: 'sandbox-ab' })
    expect(parseOpenAgentRequestStatus({ ...base, state: 'bound' })).toBeNull()
    expect(
      parseOpenAgentRequestStatus({ ...base, state: 'open', businessId: 'sandbox-ab' }),
    ).toBeNull()
  })

  it('is asked at a path of its own, beside the requests that name a business', () => {
    expect(SANDBOX_PATHS.openAgentRequests).toMatch(API_PATH_PATTERN)
    expect(SANDBOX_PATHS.openAgentRequests).toBe(`${SANDBOX_PATHS.agentRequests}/open`)
  })
})
