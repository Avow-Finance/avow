import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import {
  AGENT_LABEL_MAX,
  agentLabelOf,
  agentLabelProblem,
  approvalHash,
  approvalKeyOf,
  pairingCode,
  parseAgentRequest,
  parseAgentRequestStatus,
  parseOpenAgentRequest,
  parseOpenAgentRequestStatus,
  quotedLabel,
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
      'Research  agent',
      'x'.repeat(AGENT_LABEL_MAX),
    ]) {
      expect(agentLabelOf(label), label).toBe(label)
      expect(parseOpenAgentRequest({ label })?.label, label).toBe(label)
    }
    expect(agentLabelOf('  Research agent ')).toBe('Research agent')
    // A Japanese input method types a wide space between words, which a label reads as a space.
    expect(agentLabelOf('リサーチ\u3000エージェント')).toBe('リサーチ エージェント')
    expect(agentLabelOf('山田\u3000太郎\u3000')).toBe('山田 太郎')
    expect(parseOpenAgentRequest({ label: 'リサーチ\u3000エージェント' })?.label).toBe(
      'リサーチ エージェント',
    )
    // The most is counted in UTF-16 code units, so an emoji outside the first plane counts as two.
    expect(agentLabelOf('🤖'.repeat(AGENT_LABEL_MAX / 2))).not.toBeNull()
    expect(agentLabelOf(`${'🤖'.repeat(AGENT_LABEL_MAX / 2)}x`)).toBeNull()
    expect(agentLabelOf('x'.repeat(AGENT_LABEL_MAX + 1))).toBeNull()
    expect(agentLabelOf('   ')).toBeNull()
  })

  it('refuses emoji joined by a zero-width joiner, as it does in the name of an item, and says why', () => {
    const coder = '\u{1f469}\u200d\u{1f4bb} Coder'
    expect(agentLabelOf(coder)).toBeNull()
    expect(agentLabelProblem(coder)).toMatch(
      /^it holds U\+200D at code point 2, a zero-width joiner/,
    )
    expect(agentLabelProblem(coder)).toMatch(/Write each emoji on its own/)
    expect(agentLabelOf('\u{1f469}\u{1f4bb} Coder')).not.toBeNull()
    // A skin tone or the emoji presentation selector before the joiner still leaves it between emoji.
    for (const [emoji, at] of [
      ['\u{1f469}\u{1f3fd}\u200d\u{1f4bb}', 3],
      ['\u2764\ufe0f\u200d\u{1f525}', 3],
      ['\u{1f3f3}\ufe0f\u200d\u{1f308}', 3],
    ] as const) {
      expect(agentLabelOf(`${emoji} agent`), emoji).toBeNull()
      expect(agentLabelProblem(`${emoji} agent`), emoji).toMatch(
        new RegExp(
          `^it holds U\\+200D at code point ${at}, a zero-width joiner that joins two emoji`,
        ),
      )
    }
    // A joiner between letters is no emoji, so it's named as hidden.
    expect(agentLabelProblem('a\u200db')).toMatch(/which shows nothing/)
  })

  it('names the first character that fails and where it stands', () => {
    expect(agentLabelProblem('Research agent')).toBeNull()
    expect(agentLabelProblem('Agent \u202etcennoc')).toBe(
      'it holds U+202E at code point 7, which shows nothing or changes how the text around it reads',
    )
    expect(agentLabelProblem('🤖 \u200bx')).toMatch(/^it holds U\+200B at code point 3,/)
    expect(agentLabelProblem('Agent "x"')).toBe(
      'it holds U+0022 at code point 7, which reads as a double quote',
    )
    expect(agentLabelProblem("Agent ''x''")).toMatch(/two apostrophes side by side at code point 7/)
    expect(agentLabelProblem('Agent ``x``')).toMatch(/two backticks side by side at code point 7/)
    expect(agentLabelProblem('Agent \ud800')).toMatch(
      /U\+D800 at code point 7, half of a character/,
    )
    expect(agentLabelProblem('   ')).toBe("it's empty")
    expect(agentLabelProblem('x'.repeat(61))).toBe("it's 61 UTF-16 code units long")
  })

  it('quotes a label for a card, and shows each mark in one held from before as its code point', () => {
    expect(quotedLabel('Research agent')).toBe('"Research agent"')
    expect(quotedLabel('Agent \u202etcennoc')).toBe('"Agent [U+202E]tcennoc"')
    expect(quotedLabel("a''b")).toBe('"a[U+0027][U+0027]b"')
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
