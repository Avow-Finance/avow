import { describe, expect, it } from 'vitest'
import { API_PATH_PATTERN } from './api-request.js'
import { testnetDemoJobTerms } from './demo.js'
import { GPU_RESERVATION } from './gpu-reservation.js'
import { mailboxStatusAt, parseMailboxOrderRequest } from './mailbox.js'
import { SANDBOX_PATHS } from './sandbox.js'
import { toWire } from './wire.js'

const ORDER = '0123456789abcdef0123456789abcdef'

describe('the mailbox', () => {
  it('names each order in paths the API accepts, and nothing that is not an order id', () => {
    for (const path of [
      SANDBOX_PATHS.mailboxOrders,
      SANDBOX_PATHS.mailboxInbox,
      SANDBOX_PATHS.mailboxOrder(ORDER),
      SANDBOX_PATHS.mailboxQuote(ORDER),
      SANDBOX_PATHS.mailboxReserved(ORDER),
      SANDBOX_PATHS.mailboxAccepted(ORDER),
    ]) {
      expect(path).toMatch(API_PATH_PATTERN)
    }
    expect(() => SANDBOX_PATHS.mailboxOrder('../x')).toThrow()
  })

  it('reads an order a buyer sends, with the demo job terms', () => {
    const terms = testnetDemoJobTerms(1_800_000_600n, '0x7b7b7e93b9de1b9cba5123f0570b56eb66c53173')
    const order = {
      orderId: ORDER,
      commitmentId: `0x${'12'.repeat(32)}`,
      supplierBusinessId: 'sandbox-ab',
      terms,
      requirement: { template: GPU_RESERVATION, condition: 'accepted', disclosed: 'subject' },
      expiry: 1_800_000_300n,
    }
    expect(parseMailboxOrderRequest(toWire(order))?.expiry).toBe(1_800_000_300n)
    expect(parseMailboxOrderRequest({ ...(toWire(order) as object), extra: 1 })).toBeNull()
  })

  it('lapses only an order nobody funded', () => {
    const expiry = 100n
    expect(mailboxStatusAt({ status: 'requested', expiry }, 99n)).toBe('requested')
    expect(mailboxStatusAt({ status: 'requested', expiry }, 100n)).toBe('expired')
    expect(mailboxStatusAt({ status: 'quoted', expiry }, 100n)).toBe('expired')
    expect(mailboxStatusAt({ status: 'reserved', expiry }, 1000n)).toBe('reserved')
    expect(mailboxStatusAt({ status: 'accepted', expiry }, 1000n)).toBe('accepted')
  })
})
