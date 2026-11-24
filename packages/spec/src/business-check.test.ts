import { describe, expect, it } from 'vitest'
import { API_PATH_PATTERN } from './api-request.js'
import { parseBusinessCheck } from './business-check.js'
import { SANDBOX_PATHS } from './sandbox.js'

const checked = { by: 'didit', simulated: true }

describe("a business check's answer", () => {
  it('reads each state with exactly the fields that state carries', () => {
    for (const answer of [
      { state: 'not_available' },
      { state: 'not_started' },
      { state: 'started', ...checked, url: 'https://verify.example/session/1' },
      { state: 'in_review', ...checked },
      { state: 'passed', ...checked, decidedAt: '1763420400' },
      { state: 'declined', ...checked, decidedAt: '1763420400' },
    ]) {
      expect(parseBusinessCheck(answer), answer.state).toEqual({ ok: true, value: answer })
    }
  })

  it("refuses a page that isn't https, a decision with no time and a state it doesn't know", () => {
    for (const answer of [
      { state: 'started', ...checked, url: 'http://verify.example/session/1' },
      { state: 'started', ...checked },
      { state: 'passed', ...checked },
      { state: 'passed', by: 'didit', decidedAt: '1763420400' },
      { state: 'in_review', ...checked, url: 'https://verify.example/session/1' },
      { state: 'passed', by: 'someone-else', simulated: false, decidedAt: '1763420400' },
      { state: 'lapsed', ...checked },
      { state: 'verified' },
      null,
    ]) {
      expect(parseBusinessCheck(answer)).toEqual({ ok: false, reason: 'message.invalid' })
    }
  })

  it('has paths a signed request can name, the read under the start', () => {
    expect(SANDBOX_PATHS.businessChecks).toBe('/v1/sandbox/business-checks')
    expect(SANDBOX_PATHS.businessCheck).toBe(`${SANDBOX_PATHS.businessChecks}/current`)
    for (const path of [SANDBOX_PATHS.businessChecks, SANDBOX_PATHS.businessCheck]) {
      expect(path).toMatch(API_PATH_PATTERN)
    }
  })
})
