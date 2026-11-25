import { describe, expect, it } from 'vitest'
import { API_PATH_PATTERN } from './api-request.js'
import { SANDBOX_PATHS } from './sandbox.js'
import { parseTopUp, TOP_UP_EVERY } from './top-up.js'

const hash = `0x${'ab'.repeat(32)}`

describe("a top-up's answer", () => {
  it('reads a pending and a landed transfer, and a business that had its top-up today', () => {
    for (const answer of [
      {
        state: 'sent',
        amount: '1500000000',
        transactionHash: hash,
        outcome: 'pending',
        nextAt: '1',
      },
      {
        state: 'sent',
        amount: '1500000000',
        transactionHash: hash,
        outcome: 'landed',
        nextAt: '1',
      },
      { state: 'not_yet', nextAt: '1763506800' },
    ]) {
      expect(parseTopUp(answer)).toEqual({ ok: true, value: answer })
    }
  })

  it("refuses no amount, a hash in upper case, an outcome that failed and a field it doesn't know", () => {
    const good = {
      state: 'sent',
      amount: '1500000000',
      transactionHash: hash,
      outcome: 'pending',
      nextAt: '1',
    }
    for (const answer of [
      { ...good, amount: '0' },
      { ...good, amount: '-5' },
      { ...good, transactionHash: hash.toUpperCase() },
      { ...good, outcome: 'reverted' },
      { ...good, lock: hash },
      { state: 'sent', amount: good.amount, transactionHash: hash, outcome: 'pending' },
      { state: 'not_yet', nextAt: '1', amount: good.amount },
      { state: 'refused', nextAt: '1' },
      null,
    ]) {
      expect(parseTopUp(answer)).toEqual({ ok: false, reason: 'message.invalid' })
    }
  })

  it('has a path a signed request can name, and a day between top-ups', () => {
    expect(SANDBOX_PATHS.topUps).toMatch(API_PATH_PATTERN)
    expect(TOP_UP_EVERY).toBe(86_400)
  })
})
